// Снимки остатков kspace утро/вечер — аналог ekran-snapshots.mjs.
//
// ЗАЧЕМ. Таблица kspace_products перезаписывается на месте, истории в ней нет. Утренний
// остаток задним числом не восстановить — поэтому снимок кладём отдельной строкой.
// На них потом строятся «Разница реал. сканов» и «Светофор» (доля дней в наличии).
//
// Утро — ПЕРВЫЙ проход дня, вечер — последний (Киев 20ч), вечерний перезаписывается
// каждым последующим проходом, пока день не кончился.
//
// ⚠️ Нули в снимок ИДУТ (в отличие от ekran, где qty IS NULL отсекались): у kspace ноль —
// это «закончилось», а не «остаток недоступен». Без нулей «Светофор» не смог бы отличить
// день без продаж от дня, когда товара не было в наличии вовсе.
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN
import { d1 } from './d1.mjs';

const kyiv = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: (+p.hour) % 24 };
};

async function main() {
  const { day, hour } = kyiv();
  const ts = Math.floor(Date.now() / 1000);

  const rows = await d1('SELECT code, qty FROM kspace_products');
  if (!rows.length) { console.log('нет данных — снимок не делаю'); return; }
  const data = JSON.stringify(Object.fromEntries(rows.map((r) => [r.code, r.qty])));
  console.log(`снимок: ${rows.length} товаров, ${(data.length / 1024 | 0)} КБ`);

  const have = await d1('SELECT kind FROM kspace_snap WHERE day=?', [day]);
  const kinds = new Set(have.map((r) => r.kind));

  // Утренний пишем ОДИН раз за день — первым прошедшим сканом.
  if (!kinds.has('morning')) {
    await d1(`INSERT INTO kspace_snap (day,kind,ts,data) VALUES (?,'morning',?,?)
              ON CONFLICT(day,kind) DO UPDATE SET ts=excluded.ts, data=excluded.data`, [day, ts, data]);
    console.log(`✓ утренний снимок за ${day}`);
  }

  // Вечерний обновляем на каждом проходе после 17:00 — последний за день и останется.
  if (hour >= 17) {
    await d1(`INSERT INTO kspace_snap (day,kind,ts,data) VALUES (?,'evening',?,?)
              ON CONFLICT(day,kind) DO UPDATE SET ts=excluded.ts, data=excluded.data`, [day, ts, data]);
    console.log(`✓ вечерний снимок за ${day} (час ${hour})`);
  }

  // Чистка: снимки старше 400 дней не нужны, «Светофор» смотрит максимум год.
  await d1(`DELETE FROM kspace_snap WHERE day < date('now','-400 day')`);
}

main().catch((e) => { console.error('✗ kspace-snapshots:', e.message); process.exit(1); });
