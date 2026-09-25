// Проход по ценам uparts.ua: скрап → diff с D1 → запись изменений.
//
// ⚠️ Тип парсера — как у Форсажа: следим за ЦЕНОЙ и наличием «є/немає», движений
// остатка нет (количеств сайт не отдаёт вовсе). Отсюда `uparts_changes` со строкой
// на каждое изменившееся поле вместо `*_moves` с дельтами штук.
//
// Запуск: node uparts-run.mjs                    (пишет в D1)
//         node uparts-run.mjs --dry              (скрап + diff без записи)
//         node uparts-run.mjs --dry --pages 10   (быстрая проба на 10 страницах)
//         node uparts-run.mjs --conc 10          (потоков; по умолчанию 6)
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN
import { scrapeUparts } from './uparts-scrape.mjs';
import { d1, bulkInsert } from './d1.mjs';
import { withSiteRetry } from './site-retry.mjs';

const arg = (n, def) => { const i = process.argv.indexOf(n); return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def; };
const DRY = process.argv.includes('--dry');
const PAGES = arg('--pages', 0);
const CONC = arg('--conc', 6);
const log = (...a) => console.error(...a);

const PROD_COLS = ['code', 'name', 'category', 'price', 'in_stock', 'url', 'first_seen', 'updated_at'];
const CHG_COLS = ['ts', 'code', 'name', 'category', 'field', 'old_val', 'new_val'];

// Сравнение цен с допуском в копейку: float из JSON иначе даёт ложные срабатывания.
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);

async function main() {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);

  const prev = new Map();
  if (!DRY) {
    log('▸ читаю текущий снимок из D1 …');
    const rows = await d1('SELECT code, price, in_stock, first_seen FROM uparts_products');
    for (const r of rows) prev.set(String(r.code), r);
    log(`  в базе: ${prev.size} товаров`);
  }

  const { items, expected, requests, failures, pages, sec, endedClean, inStock } =
    await withSiteRetry(() => scrapeUparts({ log, conc: CONC, limitPages: PAGES }), log);

  if (!items.length) throw new Error('скрап не вернул ни одного товара — в базу не пишем');

  const row = (it, firstSeen) => [it.code, it.name, it.category, it.price, it.inStock,
    it.url, firstSeen, ts];

  const upserts = [], changes = [];
  let isNew = 0, up = 0, down = 0, stockChg = 0;
  for (const it of items) {
    const old = prev.get(it.code);
    const firstSeen = old?.first_seen ?? ts;
    if (!old) { isNew++; upserts.push(row(it, firstSeen)); continue; }

    // ⚠️ Переход NULL → значение изменением НЕ считаем, это базовая линия. Иначе любая
    // миграция, добавившая колонку, порождает по записи на КАЖДЫЙ товар: у Форсажа на
    // добавлении долларовых цен так и вышло — 86 154 ложных «изменения» за один прогон.
    // Здесь тот же случай: у товаров «уточнюйте» цена NULL и однажды станет числом.
    const dPrice = old.price != null && !same(old.price, it.price);
    const dStock = (old.in_stock ? 1 : 0) !== it.inStock;

    if (dPrice) {
      changes.push([ts, it.code, it.name, it.category, 'price', old.price, it.price]);
      if (it.price != null) (it.price > old.price ? up++ : down++);
    }
    if (dStock) {
      changes.push([ts, it.code, it.name, it.category, 'stock', old.in_stock ? 1 : 0, it.inStock]);
      stockChg++;
    }
    if (dPrice || dStock) upserts.push(row(it, firstSeen));
  }

  // ⚠️ Коды, которых не встретилось, НЕ обнуляем и не удаляем — ровно как у kspace
  // и ukrmobil. Товар мог не попасть в неполный проход, а записать ему «немає» значит
  // выдумать событие. Неполный проход поэтому даёт МЕНЬШЕ изменений, но не даёт неверных.
  const seen = new Set(items.map((i) => i.code));
  const missing = [...prev.keys()].filter((c) => !seen.has(c)).length;

  log(`▸ diff: новых ${isNew} | изменений ${changes.length} (цена вверх ${up}, вниз ${down}, наличие ${stockChg}) | пропало из выдачи ${missing}`);

  if (DRY) {
    log('▸ DRY: в D1 не пишу.');
    log(`   товаров ${items.length}, в наличии ${inStock}, страниц ${pages}, запросов ${requests}, сбоев ${failures}, за ${sec}с`);
    if (expected != null) log(`   offerCount сайта: ${expected}, расхождение ${expected - items.length}`);
    for (const i of items.slice(0, 5)) {
      log(`   ${i.code.padEnd(14)} ${String(i.price ?? '—').padStart(9)} грн  ${i.inStock ? 'є    ' : 'немає'}  ${i.name.slice(0, 48)}`);
    }
    for (const c of changes.slice(0, 10)) log(`   ${c[4]}: ${c[5]} → ${c[6]}  ${String(c[2]).slice(0, 50)}`);
    return;
  }

  log('▸ пишу в D1 …');
  const conflict = `ON CONFLICT(code) DO UPDATE SET
    name=excluded.name, category=excluded.category, price=excluded.price,
    in_stock=excluded.in_stock, url=excluded.url, updated_at=excluded.updated_at`;
  await bulkInsert('uparts_products', PROD_COLS, upserts, { conflict });
  if (changes.length) await bulkInsert('uparts_changes', CHG_COLS, changes);

  await d1(`INSERT INTO uparts_scans
    (started_at, finished_at, requests, pages, products, expected, changed,
     price_up, price_down, stock_chg, failures, missing, ok)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ts, Math.floor(Date.now() / 1000), requests, pages, items.length, expected, changes.length,
      up, down, stockChg, failures, missing, endedClean && !failures ? 1 : 0]);

  log(`✓ готово за ${((Date.now() - t0) / 1000) | 0}с: товаров ${items.length}, изменений ${changes.length}`);
}

main().catch((e) => { log('✗ ОШИБКА:', e.stack || e.message); process.exit(1); });
