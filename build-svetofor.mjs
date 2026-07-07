// «Светофор» — сборка отчёта продаж по месяцам/дням со светофорной заливкой (наличие по дням).
// Тяжело для free-воркера (1600+ строк, снимки наличия) → строит GitHub Actions и шлёт файлом.
// Триггерится ботом (кнопка «🚦 Светофор») через workflow_dispatch. env: CF_*, BOT_TOKEN, CHAT
import { d1 } from './d1.mjs';
import { freezeHeader } from './xlsx-freeze.mjs';
import { buildSvetofor } from './svetofor.mjs';

const chat = process.env.CHAT;
if (!chat || !process.env.BOT_TOKEN) { console.log('нет CHAT/BOT_TOKEN'); process.exit(0); }

const { buf, products, months, days, snapDays } = await buildSvetofor({ d1 });
const out = Buffer.from(freezeHeader(new Uint8Array(buf)));
console.log(`светофор собран: ${products} товаров, месяцев ${months}, дней ${days}, снимков наличия ${snapDays}, ${(out.length / 1024 | 0)} КБ`);

const fd = new FormData();
fd.append('chat_id', String(chat));
fd.append('document', new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  `svetofor_${new Date().toISOString().slice(0, 10)}.xlsx`);
fd.append('caption',
  `🚦 Светофор — ${products} товаров\n`
  + `Листы: «Светофор. по месяцам» и «Светофор по дням».\n`
  + `Цвет = доля дней в наличии (по утренним снимкам, их пока ${snapDays}). Число = продано шт.`);
const r = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd })).json();
console.log('отправка:', r.ok ? 'ок' : JSON.stringify(r).slice(0, 200));
