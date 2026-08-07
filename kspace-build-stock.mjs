// «Остатки текущие» по kspace-parts.com.ua — аналог ekran-build-stock.mjs.
// Собирает xlsx из D1, грузит в Telegram → file_id, кладёт file_id в settings.kspace_stock_fileid,
// удаляет служебное сообщение. Бот шлёт файл по file_id.
//
// ⚠️ В файл идут ТОЛЬКО позиции с остатком > 0 (решение владельца 2026-08-07): нулей
// в каталоге половина (3040 из 6216), в снимке D1 они лежат, но в отчёте это шум.
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN, BOT_TOKEN, ADMIN_CHAT_ID
import { d1 } from './d1.mjs';
import { freezeHeader } from './xlsx-freeze.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// Человеческие названия разделов: в базе лежит путь, в шапке листа нужен заголовок.
const SECTION_NAME = {
  '/catalog/displeyi': 'Дисплеї',
  '/catalog/zapchastini-dlya-apple': 'Запчастини Apple',
  '/catalog/akumulyatori': 'Акумулятори',
  '/catalog/aksesuari': 'Аксесуари',
  '/catalog/inshe': 'Інше',
  '/catalog/zapchastini-dlya-planshetiv': 'Планшети',
};

function sheetName(used, raw) {
  const n = (raw || 'лист').replace(/[\\/?*\[\]:]/g, ' ').slice(0, 28).trim() || 'лист';
  let name = n, i = 2;
  while (used.has(name)) name = `${n.slice(0, 25)} ${i++}`;
  used.add(name);
  return name;
}

function buildXlsx(rows) {
  const bySection = new Map();
  for (const r of rows) {
    const key = r.section || '/catalog/inshe';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(r);
  }
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const header = ['Код', 'Товар', 'Ціна, грн', 'Залишок', 'Посилання'];
  for (const [section, items] of bySection) {
    const title = SECTION_NAME[section] || section;
    const aoa = [header];
    for (const r of items) aoa.push([r.code, r.name, r.price ?? '', r.qty, r.url || '']);
    const tot = items.reduce((s, r) => s + (r.qty || 0), 0);
    aoa.push([], [`РАЗОМ «${title}» (${items.length} поз.)`, '', '', tot, '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 70 }, { wch: 12 }, { wch: 10 }, { wch: 50 }];
    ws['!autofilter'] = { ref: 'A1:E1' };
    XLSX.utils.book_append_sheet(wb, ws, sheetName(used, title));
  }
  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buf: Buffer.from(freezeHeader(new Uint8Array(raw))), sections: bySection.size };
}

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

async function main() {
  const chat = process.env.ADMIN_CHAT_ID;
  if (!process.env.BOT_TOKEN || !chat) throw new Error('нет BOT_TOKEN / ADMIN_CHAT_ID');

  const rows = await d1(
    `SELECT code, name, url, section, price, qty FROM kspace_products
     WHERE qty > 0 ORDER BY section, name`
  );
  if (!rows.length) { console.log('нет товаров в наличии — пропускаю сборку остатков'); return; }
  const { buf, sections } = buildXlsx(rows);
  console.log(`xlsx собран: ${rows.length} поз., ${sections} разделов, ${(buf.length / 1024 | 0)} КБ`);

  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('document', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'kspace_ostatki.xlsx');
  fd.append('disable_notification', 'true');
  const up = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
  if (!up.ok) throw new Error('TG upload failed: ' + JSON.stringify(up));

  const meta = JSON.stringify({
    file_id: up.result.document.file_id, built_at: Math.floor(Date.now() / 1000),
    products: rows.length, sections,
  });
  await d1(`INSERT INTO settings (k,v) VALUES ('kspace_stock_fileid', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [meta]);
  await tg('deleteMessage', { chat_id: chat, message_id: up.result.message_id });
  console.log('✓ file_id сохранён, служебное сообщение удалено');
}

main().catch((e) => { console.error('✗ kspace-build-stock:', e.message); process.exit(1); });
