// «Остатки текущие» по ekran.com.ua — аналог build-stock.mjs (m112).
// Собирает xlsx из D1, грузит в Telegram → file_id, кладёт file_id в settings.ekran_stock_fileid,
// удаляет служебное сообщение. Бот шлёт файл по file_id.
//
// Отличия от m112: одна колонка остатка вместо пяти городов, группировка по разделу
// и родительскому товару (у ekran на один товар до 150 предложений).
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN, BOT_TOKEN, ADMIN_CHAT_ID
import { d1 } from './d1.mjs';
import { freezeHeader } from './xlsx-freeze.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

function sheetName(used, raw) {
  const n = (raw || 'лист').replace(/[\\/?*\[\]:]/g, ' ').slice(0, 28).trim() || 'лист';
  let name = n, i = 2;
  while (used.has(name)) name = `${n.slice(0, 25)} ${i++}`;
  used.add(name);
  return name;
}

// Наличие как на сайте: >0 — в наличии, ≤0 при can_buy — под заказ, иначе нет.
// qty=NULL у товаров без вариантов: остаток там недоступен в принципе.
const nal = (r) => (r.qty === null || r.qty === undefined ? '—'
  : r.qty > 0 ? 'в наявності' : r.can_buy ? 'під замовлення' : 'немає');

function buildXlsx(rows) {
  const bySection = new Map();
  for (const r of rows) {
    const key = r.section || 'inshe';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(r);
  }
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const header = ['Товар', 'Модель', 'Варіант', 'Артикул', 'Ціна', 'Наявність', 'Залишок'];
  for (const [section, items] of bySection) {
    const aoa = [header];
    let curProd = null, sub = 0, subN = 0;
    const flush = () => { if (curProd !== null) aoa.push([`  Разом ${String(curProd).slice(0, 50)}`, '', '', '', '', `${subN} поз.`, sub]); };
    for (const r of items) {
      if (r.product_id !== curProd) { flush(); curProd = r.product_id; sub = 0; subN = 0; }
      aoa.push([r.name, r.model || '', r.variant || '', r.article || '', r.price ?? '', nal(r), r.qty ?? '']);
      sub += r.qty || 0; subN++;
    }
    flush();
    const tot = items.reduce((s, r) => s + (r.qty || 0), 0);
    aoa.push([], [`РАЗОМ «${section}» (${items.length} поз.)`, '', '', '', '', '', tot]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 60 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 10 }];
    ws['!autofilter'] = { ref: 'A1:G1' };
    XLSX.utils.book_append_sheet(wb, ws, sheetName(used, section));
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
    `SELECT section, product_id, name, model, variant, article, price, qty, can_buy
     FROM ekran_products ORDER BY section, product_id, model, variant`
  );
  if (!rows.length) { console.log('нет предложений — пропускаю сборку остатков'); return; }
  const { buf, sections } = buildXlsx(rows);
  console.log(`xlsx собран: ${rows.length} поз., ${sections} разделов, ${(buf.length / 1024 | 0)} КБ`);

  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('document', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'ekran_ostatki.xlsx');
  fd.append('disable_notification', 'true');
  const up = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
  if (!up.ok) throw new Error('TG upload failed: ' + JSON.stringify(up));

  const meta = JSON.stringify({
    file_id: up.result.document.file_id, built_at: Math.floor(Date.now() / 1000),
    products: rows.length, sections,
  });
  await d1(`INSERT INTO settings (k,v) VALUES ('ekran_stock_fileid', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [meta]);
  await tg('deleteMessage', { chat_id: chat, message_id: up.result.message_id });
  console.log('✓ file_id сохранён, служебное сообщение удалено');
}

main().catch((e) => { console.error('✗ ekran-build-stock:', e.message); process.exit(1); });
