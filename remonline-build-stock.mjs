// «Остатки текущие» по НАШЕМУ складу RemOnline — аналог ukrmobil-build-stock.mjs.
// Собирает xlsx из D1 (только остаток > 0), грузит в Telegram → file_id → settings.ro_stock_fileid,
// служебное сообщение удаляет. Бот потом шлёт файл по file_id мгновенно.
//
// Листы — по разделу (section: верхний значимый уровень категории), полный путь — колонкой.
// ⚠️ Репозиторий публичный — в лог только числа.
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN, BOT_TOKEN, ADMIN_CHAT_ID
import { d1 } from './d1.mjs';
import { freezeHeader } from './xlsx-freeze.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const r3 = (v) => Math.round((v || 0) * 1000) / 1000;

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
    const key = r.section || 'Інше';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(r);
  }
  const groups = [...bySection.entries()].sort((a, b) => b[1].length - a[1].length);

  const wb = XLSX.utils.book_new();
  const used = new Set();
  const header = ['ID', 'Товар', 'Артикул', 'Код', 'Категорія', 'B2B, грн', 'Роздріб, грн', 'Залишок', 'Резерв', 'Доступно'];
  for (const [title, items] of groups) {
    const aoa = [header];
    for (const r of items) {
      aoa.push([r.id, r.name, r.article || '', r.code || '', r.category || '', r.price_b2b ?? '', r.price_retail ?? '',
        r3(r.qty), r3(r.reserved), r3(r.qty - (r.reserved || 0))]);
    }
    const tot = items.reduce((s, r) => s + (r.qty || 0), 0);
    aoa.push([], [`РАЗОМ «${title}» (${items.length} поз.)`, '', '', '', '', '', '', r3(tot), '', '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 60 }, { wch: 14 }, { wch: 10 }, { wch: 44 }, { wch: 10 }, { wch: 12 },
      { wch: 9 }, { wch: 8 }, { wch: 9 }];
    ws['!autofilter'] = { ref: 'A1:J1' };
    XLSX.utils.book_append_sheet(wb, ws, sheetName(used, title));
  }
  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  // Правило проекта: любой отчёт — только .xlsx и с закреплённой шапкой.
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
    `SELECT id, name, article, code, category, section, price_b2b, price_retail, qty, reserved
       FROM ro_products WHERE qty > 0 ORDER BY section, category, name`
  );
  if (!rows.length) { console.log('нет позиций в наличии — пропускаю сборку остатков'); return; }
  const { buf, sections } = buildXlsx(rows);
  console.log(`xlsx собран: ${rows.length} поз., ${sections} разделов, ${(buf.length / 1024 | 0)} КБ`);

  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('document', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'nash_sklad_ostatki.xlsx');
  fd.append('disable_notification', 'true');
  const up = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
  if (!up.ok) throw new Error('TG upload failed: ' + (up.description || 'unknown'));

  const qty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const meta = JSON.stringify({
    file_id: up.result.document.file_id, built_at: Math.floor(Date.now() / 1000),
    products: rows.length, sections, qty: r3(qty),
  });
  await d1(`INSERT INTO settings (k,v) VALUES ('ro_stock_fileid', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [meta]);
  await tg('deleteMessage', { chat_id: chat, message_id: up.result.message_id });
  console.log('✓ file_id сохранён, служебное сообщение удалено');
}

main().catch((e) => { console.error('✗ remonline-build-stock:', e.message); process.exit(1); });
