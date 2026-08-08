// Проход по ценам gsm-forsage.com.ua: скрап → diff с D1 → запись изменений.
//
// ⚠️ Отличие от остальных парсеров: здесь ПОСТАВЩИК, и нас интересует ИСТОРИЯ ЦЕН,
// а не движение остатков. Поэтому вместо `*_moves` с дельтами штук пишем `forsage_changes`
// со строкой на каждое изменившееся поле — так же, как устроена таблица `changes`
// для прайсов из Google-таблиц.
//
// Запуск: node forsage-run.mjs                  (пишет в D1)
//         node forsage-run.mjs --dry            (скрап + diff без записи)
//         node forsage-run.mjs --dry --cats 5   (быстрая проба на 5 категориях)
//
// env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN + FORSAGE_EMAIL, FORSAGE_PASSWORD
import { scrapeForsage } from './forsage-scrape.mjs';
import { d1, bulkInsert } from './d1.mjs';

const arg = (n, def) => { const i = process.argv.indexOf(n); return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def; };
const DRY = process.argv.includes('--dry');
const CATS = arg('--cats', 0);
const log = (...a) => console.error(...a);

const PROD_COLS = ['code', 'name', 'category', 'price_retail', 'price_partner', 'in_stock', 'first_seen', 'updated_at'];
const CHG_COLS = ['ts', 'code', 'name', 'category', 'field', 'old_val', 'new_val'];

// Цены сравниваем с округлением до копейки: float из JSON иначе даёт ложные «изменения».
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);

async function main() {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);

  const prev = new Map();
  if (!DRY) {
    log('▸ читаю текущий снимок из D1 …');
    const rows = await d1('SELECT code, price_retail, price_partner, in_stock, first_seen FROM forsage_products');
    for (const r of rows) prev.set(String(r.code), r);
    log(`  в базе: ${prev.size} товаров`);
  }

  const { items, cats, requests, failures, authed, withGap, sec } =
    await scrapeForsage({ log, limitCats: CATS });

  const upserts = [], changes = [];
  let isNew = 0, up = 0, down = 0, stockChg = 0;
  for (const it of items) {
    const old = prev.get(it.code);
    const firstSeen = old?.first_seen ?? ts;
    if (!old) { isNew++; upserts.push([it.code, it.name, it.category, it.priceRetail, it.pricePartner, it.inStock, firstSeen, ts]); continue; }

    const dRetail = !same(old.price_retail, it.priceRetail);
    const dPartner = !same(old.price_partner, it.pricePartner);
    const dStock = (old.in_stock ? 1 : 0) !== it.inStock;

    if (dRetail) changes.push([ts, it.code, it.name, it.category, 'retail', old.price_retail, it.priceRetail]);
    if (dPartner) {
      changes.push([ts, it.code, it.name, it.category, 'partner', old.price_partner, it.pricePartner]);
      if (old.price_partner != null && it.pricePartner != null) (it.pricePartner > old.price_partner ? up++ : down++);
    }
    if (dStock) { changes.push([ts, it.code, it.name, it.category, 'stock', old.in_stock ? 1 : 0, it.inStock]); stockChg++; }

    if (dRetail || dPartner || dStock) {
      upserts.push([it.code, it.name, it.category, it.priceRetail, it.pricePartner, it.inStock, firstSeen, ts]);
    }
  }

  // Коды, которых не встретилось. Строки НЕ трогаем: товар мог не попасть в неполный проход,
  // а стереть цену — значит записать ложное изменение. Число уходит в лог прохода.
  const seen = new Set(items.map((i) => i.code));
  const missing = [...prev.keys()].filter((c) => !seen.has(c)).length;

  log(`▸ diff: новых ${isNew} | изменений ${changes.length} (цена вверх ${up}, вниз ${down}, наличие ${stockChg}) | пропало из выдачи ${missing}`);

  if (DRY) {
    log('▸ DRY: в D1 не пишу.');
    const inStock = items.filter((i) => i.inStock).length;
    const gapPct = items.length ? (withGap / items.length * 100).toFixed(1) : '0';
    log(`   товаров ${items.length}, в наличии ${inStock}, категорий ${cats}, запросов ~${requests}, сбоев ${failures}, за ${sec}с`);
    log(`   под токеном: ${authed ? 'ДА' : 'нет (анонимно)'}; партнёрская ниже розничной у ${withGap} (${gapPct}%)`);
    for (const c of changes.slice(0, 10)) log(`   ${c[4]}: ${c[5]} → ${c[6]}  ${String(c[2]).slice(0, 50)}`);
    return;
  }

  log('▸ пишу в D1 …');
  const conflict = `ON CONFLICT(code) DO UPDATE SET
    name=excluded.name, category=excluded.category,
    price_retail=excluded.price_retail, price_partner=excluded.price_partner,
    in_stock=excluded.in_stock, updated_at=excluded.updated_at`;
  await bulkInsert('forsage_products', PROD_COLS, upserts, { conflict });
  if (changes.length) await bulkInsert('forsage_changes', CHG_COLS, changes);

  await d1(`INSERT INTO forsage_scans
    (started_at, finished_at, requests, cats, products, changed, price_up, price_down, failures, missing, authed, ok)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ts, Math.floor(Date.now() / 1000), requests, cats, items.length, changes.length,
      up, down, failures, missing, authed, 1]);

  log(`✓ готово за ${((Date.now() - t0) / 1000) | 0}с: товаров ${items.length}, изменений ${changes.length}`);
}

main().catch((e) => { log('✗ ОШИБКА:', e.stack || e.message); process.exit(1); });
