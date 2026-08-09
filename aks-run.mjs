// Проход по ценам раздела запчастей aks.ua: скрап → diff с D1 → запись изменений.
//
// ⚠️ Тип парсера — как у uparts и Форсажа: цена и «є/немає», движений остатка нет.
// ⏰ Расписание — РАЗ В НЕДЕЛЮ (решение владельца 09.08): проход тяжёлый, ~625 МБ,
//    потому что сайт не отдаёт сжатие. Триггерит воркер своим недельным cron.
//
// Запуск: node aks-run.mjs                   (пишет в D1)
//         node aks-run.mjs --dry             (скрап + diff без записи)
//         node aks-run.mjs --dry --cats 2    (быстрая проба на двух категориях)
//         node aks-run.mjs --conc 3          (потоков; по умолчанию 5)
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN
import { scrapeAks, ROOTS } from './aks-scrape.mjs';
import { d1, bulkInsert } from './d1.mjs';

const arg = (n, def) => { const i = process.argv.indexOf(n); return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def; };
const DRY = process.argv.includes('--dry');
const CATS = arg('--cats', 0);
const CONC = arg('--conc', 5);
const log = (...a) => console.error(...a);

const PROD_COLS = ['code', 'name', 'category', 'price', 'old_price', 'in_stock', 'url', 'first_seen', 'updated_at'];
const CHG_COLS = ['ts', 'code', 'name', 'category', 'field', 'old_val', 'new_val'];

const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);

async function main() {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);

  const prev = new Map();
  if (!DRY) {
    log('▸ читаю текущий снимок из D1 …');
    const rows = await d1('SELECT code, price, in_stock, first_seen FROM aks_products');
    for (const r of rows) prev.set(String(r.code), r);
    log(`  в базе: ${prev.size} товаров`);
  }

  const { items, pages, expectedPages, requests, failures, sec, inStock, mb } =
    await scrapeAks({ log, conc: CONC, limitCats: CATS });

  if (!items.length) throw new Error('скрап не вернул ни одного товара — в базу не пишем');

  const row = (it, firstSeen) => [it.code, it.name, it.category, it.price, it.oldPrice,
    it.inStock, it.url, firstSeen, ts];

  const upserts = [], changes = [];
  let isNew = 0, up = 0, down = 0, stockChg = 0;
  for (const it of items) {
    const old = prev.get(it.code);
    const firstSeen = old?.first_seen ?? ts;
    if (!old) { isNew++; upserts.push(row(it, firstSeen)); continue; }

    // ⚠️ Переход NULL → значение изменением НЕ считаем, это базовая линия (грабля Форсажа:
    // на добавлении колонки вышло 86 154 ложных «изменения» за прогон). Здесь случай живой —
    // у снятых с продажи товаров цены нет, и она однажды появится снова.
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

  // ⚠️ Пропавшие коды НЕ обнуляем и не удаляем — как у kspace/ukrmobil/uparts: товар мог
  // не попасть в неполный проход, а записать ему «немає» значит выдумать событие.
  const seen = new Set(items.map((i) => i.code));
  const missing = [...prev.keys()].filter((c) => !seen.has(c)).length;

  log(`▸ diff: новых ${isNew} | изменений ${changes.length} (цена вверх ${up}, вниз ${down}, наличие ${stockChg}) | пропало из выдачи ${missing}`);

  if (DRY) {
    log('▸ DRY: в D1 не пишу.');
    log(`   товаров ${items.length}, в наличии ${inStock}, страниц ${pages} из ${expectedPages} обещанных пагинацией`);
    log(`   категорий ${CATS || ROOTS.length}, запросов ${requests}, сбоев ${failures}, ${mb} МБ, за ${sec}с`);
    for (const i of items.slice(0, 5)) {
      log(`   ${i.code.padStart(7)} ${String(i.price ?? '—').padStart(7)} грн ${i.inStock ? 'є    ' : 'немає'}  ${i.name.slice(0, 52)}`);
    }
    for (const c of changes.slice(0, 10)) log(`   ${c[4]}: ${c[5]} → ${c[6]}  ${String(c[2]).slice(0, 50)}`);
    return;
  }

  log('▸ пишу в D1 …');
  const conflict = `ON CONFLICT(code) DO UPDATE SET
    name=excluded.name, category=excluded.category, price=excluded.price,
    old_price=excluded.old_price, in_stock=excluded.in_stock, url=excluded.url,
    updated_at=excluded.updated_at`;
  await bulkInsert('aks_products', PROD_COLS, upserts, { conflict });
  if (changes.length) await bulkInsert('aks_changes', CHG_COLS, changes);

  await d1(`INSERT INTO aks_scans
    (started_at, finished_at, requests, pages, expected_pages, products, changed,
     price_up, price_down, stock_chg, failures, missing, mb, ok)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ts, Math.floor(Date.now() / 1000), requests, pages, expectedPages, items.length,
      changes.length, up, down, stockChg, failures, missing, mb, failures ? 0 : 1]);

  log(`✓ готово за ${((Date.now() - t0) / 1000) | 0}с: товаров ${items.length}, изменений ${changes.length}`);
}

main().catch((e) => { log('✗ ОШИБКА:', e.stack || e.message); process.exit(1); });
