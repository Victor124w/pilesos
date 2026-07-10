// Авто-отправка отчёта за день после ПОСЛЕДНЕГО скана (Киев 20:xx).
// Запускается после каждого скана, но шлёт только когда киевский час = 20.
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN, BOT_TOKEN, ADMIN_CHAT_ID
import { d1 } from './d1.mjs';
import { ADMIN_KEYBOARD } from './admin-keyboard.mjs';

const chat = process.env.ADMIN_CHAT_ID;
if (!chat || !process.env.BOT_TOKEN) { console.log('нет CHAT/BOT_TOKEN'); process.exit(0); }

const kyivHour = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false })
  .formatToParts(new Date()).find((p) => p.type === 'hour').value % 24;
if (kyivHour !== 20) { console.log('не последний скан дня (Киев ' + kyivHour + 'ч) — не шлю'); process.exit(0); }

const now = Math.floor(Date.now() / 1000);
const dayStart = Math.floor(new Date(new Date().toLocaleDateString('en-US', { timeZone: 'Europe/Kyiv' }) + ' 00:00:00 GMT+0300').getTime() / 1000);
const scans = await d1('SELECT started_at,finished_at,products,sales_qty,arrivals_qty FROM m112_scans WHERE started_at>=' + dayStart + ' ORDER BY started_at DESC');
if (!scans.length) { console.log('нет сканов за сегодня'); process.exit(0); }
const mx = (await d1('SELECT COALESCE(MAX(products),0) mx FROM m112_scans WHERE started_at>=' + (now - 7 * 86400)))[0].mx;
const maxP = Math.max(mx, 1);
const sums = (await d1(`SELECT COALESCE(SUM(CASE WHEN kind='sale' THEN -delta ELSE 0 END),0) ss,
  COALESCE(SUM(CASE WHEN kind='arrival' THEN delta ELSE 0 END),0) aa,
  COALESCE(SUM(CASE WHEN kind='sale' THEN -delta*COALESCE(price,0) ELSE 0 END),0) sr,
  COALESCE(SUM(CASE WHEN kind='arrival' THEN delta*COALESCE(price,0) ELSE 0 END),0) ar
  FROM m112_moves WHERE ts>=` + dayStart))[0];

const full = (s) => s.products >= maxP * 0.5;
const hhmm = (t) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }).format(new Date(t * 1000));
const ddmm = (t) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit' }).format(new Date(t * 1000));
const dur = (s) => { const d = (s.finished_at || s.started_at) - s.started_at; return d >= 60 ? Math.round(d / 60) + 'м' : d + 'с'; };
const nf = (n) => Number(n).toLocaleString('ru-RU');
const sep = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';
const fullN = scans.filter(full).length;

let t = `📡 <b>Парсинг m112 — итог дня ${ddmm(now)}</b>\n\n`;
t += `${sep}\n📅 <b>Итоги за сегодня</b>\n`;
t += ` 🛒 Продано:   <b>${nf(sums.ss)} шт</b>  ·  на <b>${nf(Math.round(sums.sr))} грн</b>\n`;
t += ` 📦 Поступило: <b>${nf(sums.aa)} шт</b>  ·  на <b>${nf(Math.round(sums.ar))} грн</b>\n`;
t += ` 🔍 Сканов: <b>${scans.length}</b> — ✅ ${fullN} полных · ⚠️ ${scans.length - fullN} неполных\n`;
t += `\n${sep}\n🕐 <b>Все сканы за сегодня</b>\n<pre>`;
for (const s of scans)
  t += `${full(s) ? '✅' : '⚠️'} ${hhmm(s.started_at)} ${dur(s).padStart(3)} 🕐 ${String(s.products).padStart(5)} 🛒 ${String(s.sales_qty).padStart(3)} 📦 ${String(s.arrivals_qty).padStart(3)}\n`;
t += '</pre>';

// reply_markup — это последнее сообщение суток, оно возвращает нижние кнопки при открытии Telegram утром.
const r = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chat, text: t, parse_mode: 'HTML', reply_markup: ADMIN_KEYBOARD }),
})).json();
console.log('итог дня:', r.ok ? 'отправлен' : JSON.stringify(r).slice(0, 200));
