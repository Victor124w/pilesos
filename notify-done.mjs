// Уведомление админу по завершении РУЧНОГО запуска (workflow_dispatch).
// Читает последний скан из D1 и шлёт краткую сводку в Telegram.
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN, BOT_TOKEN, ADMIN_CHAT_ID
import { d1 } from './d1.mjs';

const chat = process.env.ADMIN_CHAT_ID;
if (!process.env.BOT_TOKEN || !chat) { console.log('нет BOT_TOKEN/ADMIN_CHAT_ID — пропускаю'); process.exit(0); }

const s = (await d1('SELECT * FROM m112_scans ORDER BY id DESC LIMIT 1'))[0];
if (!s) { console.log('нет сканов'); process.exit(0); }

const dur = (s.finished_at || 0) - s.started_at;
const durText = dur >= 60 ? `${Math.floor(dur / 60)}м ${dur % 60}с` : `${dur}с`;
const scanned = s.pages - (s.empty_pages || 0);
const pct = s.pages ? (scanned / s.pages) * 100 : 0;
const pctText = (pct >= 99.95 ? '100' : pct.toFixed(1)) + '%';

const msg =
  `✅ <b>Сканирование 112 завершено</b>\n\n` +
  `⏱ ${durText} · просканировано ${pctText} (${scanned}/${s.pages} стр)\n` +
  `📦 товаров: ${s.products} · изменений: ${s.changed}\n` +
  `🔴 продано: ${s.sales_qty} · 🟢 поступило: ${s.arrivals_qty}` +
  (s.empty_pages ? `\n⚠️ выпало страниц: ${s.empty_pages} (был троттлинг)` : '');

const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' }),
});
console.log('notify:', (await r.json()).ok ? 'отправлено' : 'ошибка');
