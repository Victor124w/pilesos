// Реальные снимки утра/вечера + пред-сборка разницы. Запускается после build-stock.
//  - утро (первый полный скан дня): сохраняет снимок остатков, шлёт «Остатки на утро».
//  - каждый полный скан: пере-собирает разницу «утро → сейчас» → file_id для кнопки.
//  - вечер (Киев 20ч): шлёт «Остатки на вечер».
// env: CF_*, BOT_TOKEN, ADMIN_CHAT_ID
import { d1 } from './d1.mjs';
import { freezeHeader } from './xlsx-freeze.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const chat = process.env.ADMIN_CHAT_ID, BOT = process.env.BOT_TOKEN;
if (!chat || !BOT) { console.log('нет CHAT/BOT_TOKEN'); process.exit(0); }
const now = Math.floor(Date.now() / 1000);
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date()).map(p => [p.type, p.value]));
const day = `${parts.year}-${parts.month}-${parts.day}`;
const kyivHour = +parts.hour % 24;
const ddmm = `${parts.day}.${parts.month}`;

// полный ли был последний скан
const scan = (await d1('SELECT products,empty_pages FROM m112_scans ORDER BY id DESC LIMIT 1'))[0];
if (!scan || scan.empty_pages > 0 || scan.products < 20000) { console.log('последний скан неполный — снимок не делаю'); process.exit(0); }

async function tg(method, body) {
  return (await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
}
async function sendStockFile(caption) {
  const r = (await d1("SELECT v FROM settings WHERE k='m112_stock_fileid'"))[0];
  if (!r) return;
  const fid = JSON.parse(r.v).file_id;
  await tg('sendDocument', { chat_id: chat, document: fid, caption });
}

// текущие остатки
const prods = await d1('SELECT product_id,q_total,name,section_name,brand FROM m112_products');
const cur = {}; for (const p of prods) cur[String(p.product_id)] = p.q_total;

// УТРО: если снимка за сегодня ещё нет — сохранить + прислать «на утро»
const hasMorning = (await d1(`SELECT 1 FROM m112_snap WHERE day='${day}' AND kind='morning' LIMIT 1`)).length > 0;
let morning;
if (!hasMorning) {
  await d1('INSERT OR REPLACE INTO m112_snap (day,kind,ts,data) VALUES (?,?,?,?)', [day, 'morning', now, JSON.stringify(cur)]);
  morning = cur;
  await sendStockFile(`📦 Остатки на УТРО ${ddmm} (реальный скан): ${prods.length} товаров`);
  console.log('утренний снимок сохранён + отчёт отправлен');
} else {
  morning = JSON.parse((await d1(`SELECT data FROM m112_snap WHERE day='${day}' AND kind='morning'`))[0].data);
}

// РАЗНИЦА утро → сейчас → xlsx → file_id
let sold = 0, arr = 0; const rows = [];
for (const p of prods) {
  const was = morning[String(p.product_id)]; if (was === undefined) continue;
  const d = p.q_total - was;
  if (d !== 0) { if (d < 0) sold += -d; else arr += d; rows.push([p.name, p.section_name, p.brand, was, p.q_total, d, d < 0 ? 'продажа' : 'приход']); }
}
rows.sort((a, b) => Math.abs(b[5]) - Math.abs(a[5]));
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet([['Товар', 'Раздел', 'Бренд', 'Остаток УТРО', 'Остаток СЕЙЧАС', 'Разница', 'Тип'], ...rows]);
ws['!cols'] = [{ wch: 55 }, { wch: 26 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 9 }, { wch: 10 }];
ws['!autofilter'] = { ref: 'A1:G1' };
XLSX.utils.book_append_sheet(wb, ws, 'Разница реал. сканов');
const buf = Buffer.from(freezeHeader(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))));

const fd = new FormData();
fd.append('chat_id', chat);
fd.append('document', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'm112_snapdiff.xlsx');
fd.append('disable_notification', 'true');
const up = await (await fetch(`https://api.telegram.org/bot${BOT}/sendDocument`, { method: 'POST', body: fd })).json();
if (up.ok) {
  const meta = JSON.stringify({ file_id: up.result.document.file_id, day, changed: rows.length, sold, arr, built_at: now });
  await d1("INSERT INTO settings (k,v) VALUES ('m112_snapdiff_fileid', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [meta]);
  await tg('deleteMessage', { chat_id: chat, message_id: up.result.message_id });
  console.log(`разница пред-собрана: изменилось ${rows.length}, продано ${sold}, поступило ${arr}`);
}

// ВЕЧЕР: в 20ч прислать «на вечер»
if (kyivHour === 20) {
  await sendStockFile(`📦 Остатки на ВЕЧЕР ${ddmm} (реальный скан): ${prods.length} товаров`);
  console.log('вечерний отчёт отправлен');
}
