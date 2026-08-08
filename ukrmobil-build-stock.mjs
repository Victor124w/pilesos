// «Остатки текущие» по ukr-mobil.com — аналог kspace-build-stock.mjs.
// Собирает xlsx из D1, грузит в Telegram → file_id, кладёт file_id в settings.ukrmobil_stock_fileid,
// удаляет служебное сообщение. Бот шлёт файл по file_id.
//
// ⚠️ В файл идут ТОЛЬКО позиции с остатком > 0 (как у kspace): нулей в каталоге больше половины,
// в снимке D1 они лежат, а в отчёте это шум.
//
// ⚠️ Листы — по ВЕРХНЕМУ уровню категории, а не по полному пути: полных путей 151,
// столько листов в книге бесполезны. Полный путь остаётся колонкой.
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN, BOT_TOKEN, ADMIN_CHAT_ID
import { d1 } from './d1.mjs';
import { freezeHeader } from './xlsx-freeze.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// «Все для ремонту дисплеїв / Скло дисплея / iPhone» → «Все для ремонту дисплеїв»
const topCat = (path) => (path || '').split('/')[0].trim() || 'Інше';

function sheetName(used, raw) {
  const n = (raw || 'лист').replace(/[\\/?*\[\]:]/g, ' ').slice(0, 28).trim() || 'лист';
  let name = n, i = 2;
  while (used.has(name)) name = `${n.slice(0, 25)} ${i++}`;
  used.add(name);
  return name;
}

function buildXlsx(rows) {
  const byTop = new Map();
  for (const r of rows) {
    const key = topCat(r.category);
    if (!byTop.has(key)) byTop.set(key, []);
    byTop.get(key).push(r);
  }
  // Крупные разделы первыми — по ним и смотрят.
  const groups = [...byTop.entries()].sort((a, b) => b[1].length - a[1].length);

  const wb = XLSX.utils.book_new();
  const used = new Set();
  const header = ['Код', 'Товар', 'Категорія', 'Роздріб, грн', 'VIP, грн', 'Партнер, грн',
    'Залишок', 'Очікується', 'Дата приходу', 'Посилання'];
  for (const [title, items] of groups) {
    const aoa = [header];
    for (const r of items) {
      aoa.push([r.code, r.name, r.category || '', r.price_retail ?? '', r.price_vip ?? '',
        r.price_partner ?? '', r.qty, r.incoming || '', r.incoming_date || '', r.url || '']);
    }
    const tot = items.reduce((s, r) => s + (r.qty || 0), 0);
    aoa.push([], [`РАЗОМ «${title}» (${items.length} поз.)`, '', '', '', '', '', tot, '', '', '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 11 }, { wch: 62 }, { wch: 42 }, { wch: 13 }, { wch: 11 },
      { wch: 13 }, { wch: 10 }, { wch: 11 }, { wch: 13 }, { wch: 46 }];
    ws['!autofilter'] = { ref: 'A1:J1' };
    XLSX.utils.book_append_sheet(wb, ws, sheetName(used, title));
  }
  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  // Правило проекта: любой отчёт — только .xlsx и с закреплённой шапкой (ws['!freeze'] не работает).
  return { buf: Buffer.from(freezeHeader(new Uint8Array(raw))), sections: groups.length };
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
    `SELECT code, name, url, category, price_retail, price_vip, price_partner, qty, incoming, incoming_date
       FROM ukrmobil_products WHERE qty > 0 ORDER BY category, name`
  );
  if (!rows.length) { console.log('нет товаров в наличии — пропускаю сборку остатков'); return; }
  const { buf, sections } = buildXlsx(rows);
  console.log(`xlsx собран: ${rows.length} поз., ${sections} разделов, ${(buf.length / 1024 | 0)} КБ`);

  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('document', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'ukrmobil_ostatki.xlsx');
  fd.append('disable_notification', 'true');
  const up = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
  if (!up.ok) throw new Error('TG upload failed: ' + JSON.stringify(up));

  const meta = JSON.stringify({
    file_id: up.result.document.file_id, built_at: Math.floor(Date.now() / 1000),
    products: rows.length, sections,
  });
  await d1(`INSERT INTO settings (k,v) VALUES ('ukrmobil_stock_fileid', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [meta]);
  await tg('deleteMessage', { chat_id: chat, message_id: up.result.message_id });
  console.log('✓ file_id сохранён, служебное сообщение удалено');
}

main().catch((e) => { console.error('✗ ukrmobil-build-stock:', e.message); process.exit(1); });
