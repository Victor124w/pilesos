// Снимки остатков ekran утро/вечер — аналог snapshots.mjs (m112), только сохранение блоба.
//
// ЗАЧЕМ. Таблица ekran_products перезаписывается на месте, истории в ней нет. Утренний
// остаток задним числом не восстановить — поэтому снимок кладём отдельной строкой.
// На них потом строятся «Разница реал. сканов» и «Светофор» (доля дней в наличии).
//
// Утро — ПЕРВЫЙ проход дня, вечер — последний (Киев 20ч), вечерний перезаписывается
// каждым последующим проходом, пока день не кончился.
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

  const rows = await d1('SELECT offer_id, qty FROM ekran_products WHERE qty IS NOT NULL');
  if (!rows.length) { console.log('нет данных — снимок не делаю'); return; }
  const data = JSON.stringify(Object.fromEntries(rows.map((r) => [r.offer_id, r.qty])));
  console.log(`снимок: ${rows.length} предложений, ${(data.length / 1024 | 0)} КБ`);

  const have = await d1('SELECT kind FROM ekran_snap WHERE day=?', [day]);
  const kinds = new Set(have.map((r) => r.kind));

  // Утренний пишем ОДИН раз за день — первым прошедшим сканом.
  if (!kinds.has('morning')) {
    await d1(`INSERT INTO ekran_snap (day,kind,ts,data) VALUES (?,'morning',?,?)
              ON CONFLICT(day,kind) DO UPDATE SET ts=excluded.ts, data=excluded.data`, [day, ts, data]);
    console.log(`✓ утренний снимок за ${day}`);
  }

  // Вечерний обновляем на каждом проходе после 17:00 — последний за день и останется.
  if (hour >= 17) {
    await d1(`INSERT INTO ekran_snap (day,kind,ts,data) VALUES (?,'evening',?,?)
              ON CONFLICT(day,kind) DO UPDATE SET ts=excluded.ts, data=excluded.data`, [day, ts, data]);
    console.log(`✓ вечерний снимок за ${day} (час ${hour})`);
  }

  // Чистка: снимки старше 400 дней не нужны, «Светофор» смотрит максимум год.
  await d1(`DELETE FROM ekran_snap WHERE day < date('now','-400 day')`);
}

main().catch((e) => { console.error('✗ ekran-snapshots:', e.message); process.exit(1); });
