// Полный отчёт «Вывести все» за период (32k строк тяжело для free-воркера → строим тут).
// Триггерится ботом через workflow_dispatch. Читает D1, строит xlsx, шлёт в чат.
// env: CF_*, BOT_TOKEN, FROM, TO, LABEL, CHAT
import { d1 } from './d1.mjs';
import { freezeHeader } from './xlsx-freeze.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const from = +process.env.FROM, to = +process.env.TO;
const label = process.env.LABEL || 'период';
const chat = process.env.CHAT;
if (!chat || !process.env.BOT_TOKEN) { console.log('нет CHAT/BOT_TOKEN'); process.exit(0); }

// агрегация движений по товару за период
const moves = await d1(
  `SELECT m.product_id,
          SUM(CASE WHEN m.delta<0 THEN -m.delta ELSE 0 END) AS sold,
          SUM(CASE WHEN m.delta>0 THEN  m.delta ELSE 0 END) AS arrived,
          SUM(CASE WHEN m.delta<0 THEN -m.delta*COALESCE(m.price,0) ELSE 0 END) AS revenue,
          (SELECT qty_before FROM m112_moves b WHERE b.product_id=m.product_id AND b.ts>=${from} AND b.ts<${to} ORDER BY b.ts ASC LIMIT 1) AS qstart,
          (SELECT qty_after  FROM m112_moves e WHERE e.product_id=m.product_id AND e.ts>=${from} AND e.ts<${to} ORDER BY e.ts DESC LIMIT 1) AS qend
   FROM m112_moves m WHERE m.ts>=${from} AND m.ts<${to} GROUP BY m.product_id`
);
const mv = new Map(moves.map((r) => [String(r.product_id), r]));
let totSold = 0, totArr = 0, totRev = 0;
for (const r of moves) { totSold += r.sold || 0; totArr += r.arrived || 0; totRev += Math.round(r.revenue || 0); }

// все товары каталога
const prods = await d1('SELECT product_id, name, section_name, top_section, brand, price, q_total FROM m112_products ORDER BY top_section, brand, name');

const wb = XLSX.utils.book_new();

// Лист 1 — сводка по разделам
const bySec = new Map();
for (const p of prods) {
  const m = mv.get(String(p.product_id)); if (!m) continue;
  const sec = p.section_name || p.top_section;
  const s = bySec.get(sec) || bySec.set(sec, { s: 0, a: 0, r: 0 }).get(sec);
  s.s += m.sold || 0; s.a += m.arrived || 0; s.r += Math.round(m.revenue || 0);
}
const sum = [[`Продажі / Поступлення (всі товари) — ${label}`],
  [`Продано: ${totSold}`, `Поступило: ${totArr}`, `Виручка: ${totRev}`], [],
  ['Розділ', 'Продано', 'Поступило', 'Виручка']];
for (const [sec, d] of [...bySec].sort((a, b) => b[1].s - a[1].s)) sum.push([sec, d.s, d.a, d.r]);
const ws1 = XLSX.utils.aoa_to_sheet(sum);
ws1['!cols'] = [{ wch: 34 }, { wch: 10 }, { wch: 11 }, { wch: 12 }];
XLSX.utils.book_append_sheet(wb, ws1, 'Зведення');

// Лист 2 — все товары
const det = [['Товар', 'Розділ', 'Бренд', 'Продано', 'Поступило', 'Ост. початок', 'Ост. кінець', 'Виручка']];
for (const p of prods) {
  const m = mv.get(String(p.product_id));
  det.push([p.name, p.section_name || p.top_section, p.brand,
    m?.sold || 0, m?.arrived || 0, m?.qstart ?? '', m ? m.qend : p.q_total, m ? Math.round(m.revenue || 0) : 0]);
}
const ws2 = XLSX.utils.aoa_to_sheet(det);
ws2['!cols'] = [{ wch: 58 }, { wch: 28 }, { wch: 16 }, { wch: 9 }, { wch: 10 }, { wch: 12 }, { wch: 11 }, { wch: 10 }];
ws2['!autofilter'] = { ref: 'A1:H1' };
XLSX.utils.book_append_sheet(wb, ws2, 'Всі товари');

const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const buf = Buffer.from(freezeHeader(new Uint8Array(raw)));
console.log(`отчёт собран: ${prods.length} товаров, ${(buf.length / 1024 | 0)} КБ`);

// отправка в чат
const fd = new FormData();
fd.append('chat_id', String(chat));
fd.append('document', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  `m112_vse_${new Date().toISOString().slice(0, 10)}.xlsx`);
fd.append('caption', `📋 Всі товари — ${label}: продано ${totSold}, поступило ${totArr}, виручка ${totRev} грн (${prods.length} позицій)`);
const r = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
console.log('отправка:', r.ok ? 'ок' : JSON.stringify(r).slice(0, 200));
