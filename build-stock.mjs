// Пред-сборка отчёта «Остатки текущие» вне воркера (у free-воркера 10мс CPU не хватает
// на 32k строк). Собирает xlsx из D1, грузит в Telegram → file_id, кладёт file_id в D1
// (settings.m112_stock_fileid), удаляет служебное сообщение. Бот шлёт файл по file_id.
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN, BOT_TOKEN, ADMIN_CHAT_ID
import { d1 } from './d1.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const CITY = [['q_dnepr', 'Дніпро'], ['q_kiev', 'Київ'], ['q_odesa', 'Одеса'], ['q_lvov', 'Львів'], ['q_partner', 'Партнер']];

function sheetName(used, raw) {
  let n = (raw || 'лист').replace(/[\\/?*\[\]:]/g, ' ').slice(0, 28).trim() || 'лист';
  let name = n, i = 2;
  while (used.has(name)) name = `${n.slice(0, 25)} ${i++}`;
  used.add(name);
  return name;
}

function buildXlsx(rows) {
  const bySection = new Map();
  for (const r of rows) {
    const key = r.section_name || r.top_section || 'Інше';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(r);
  }
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const header = ['Товар', 'Бренд', 'Ціна', ...CITY.map((c) => c[1]), 'Всього'];
  for (const [section, items] of bySection) {
    const aoa = [header];
    let curBrand = null;
    let sub = [0, 0, 0, 0, 0, 0];
    const flush = () => { if (curBrand !== null) aoa.push([`  Разом ${curBrand}`, '', '', ...sub]); };
    for (const r of items) {
      if (r.brand !== curBrand) { flush(); curBrand = r.brand; sub = [0, 0, 0, 0, 0, 0]; }
      aoa.push([r.name, r.brand, r.price ?? '', r.q_dnepr, r.q_kiev, r.q_odesa, r.q_lvov, r.q_partner, r.q_total]);
      CITY.forEach((c, i) => (sub[i] += r[c[0]] || 0));
      sub[5] += r.q_total || 0;
    }
    flush();
    const secTot = CITY.map((c) => items.reduce((s, r) => s + (r[c[0]] || 0), 0));
    secTot.push(items.reduce((s, r) => s + (r.q_total || 0), 0));
    aoa.push([], [`РАЗОМ «${section}» (${items.length} поз.)`, '', '', ...secTot]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 58 }, { wch: 16 }, { wch: 9 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 9 }];
    ws['!autofilter'] = { ref: 'A1:I1' };
    XLSX.utils.book_append_sheet(wb, ws, sheetName(used, section));
  }
  return { buf: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), sections: bySection.size };
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
    `SELECT section_name, top_section, brand, name, price,
            q_dnepr, q_kiev, q_odesa, q_lvov, q_partner, q_total
     FROM m112_products ORDER BY top_section, brand, name`
  );
  if (!rows.length) { console.log('нет товаров — пропускаю сборку остатков'); return; }
  const { buf, sections } = buildXlsx(rows);
  console.log(`xlsx собран: ${rows.length} поз., ${sections} разделов, ${(buf.length / 1024 | 0)} КБ`);

  // загрузка в Telegram → file_id
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('document', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'm112_ostatki.xlsx');
  fd.append('disable_notification', 'true');
  const up = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
  if (!up.ok) throw new Error('TG upload failed: ' + JSON.stringify(up));
  const fileId = up.result.document.file_id;
  const msgId = up.result.message_id;

  // сохранить file_id в D1 и удалить служебное сообщение
  const meta = JSON.stringify({ file_id: fileId, built_at: Math.floor(Date.now() / 1000), products: rows.length, sections });
  await d1(`INSERT INTO settings (k,v) VALUES ('m112_stock_fileid', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [meta]);
  await tg('deleteMessage', { chat_id: chat, message_id: msgId });
  console.log('✓ file_id сохранён, служебное сообщение удалено');
}

main().catch((e) => { console.error('✗ build-stock:', e.message); process.exit(1); });
