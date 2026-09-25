// Оркестратор прохода ukr-mobil.com: скрап → diff с D1 → запись изменений и движений.
// Полный аналог kspace-run.mjs, отличия — в шапке schema-ukrmobil.sql (три цены, приходы).
//
// Запуск: node ukrmobil-run.mjs              (пишет в D1)
//         node ukrmobil-run.mjs --dry        (скрап + diff без записи)
//         node ukrmobil-run.mjs --dry --limit 60 --conc 10   (быстрая проба)
import { scrapeUkrmobil, CONC } from './ukrmobil-scrape.mjs';
import { d1, bulkInsert } from './d1.mjs';
import { withSiteRetry } from './site-retry.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const DRY = process.argv.includes('--dry');
const LIMIT = arg('--limit', 0);
const CONCURRENCY = arg('--conc', CONC);
const log = (...a) => console.error(...a);

const PROD_COLS = ['code', 'name', 'url', 'category', 'price_retail', 'price_vip', 'price_partner',
  'qty', 'qty_virtual', 'incoming', 'incoming_date', 'first_seen', 'updated_at'];
const MOVE_COLS = ['ts', 'code', 'name', 'category', 'qty_before', 'qty_after', 'delta', 'kind',
  'price_retail', 'price_partner'];

async function main() {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);

  // 1. снимок из D1
  const prev = new Map();
  if (!DRY) {
    log('▸ читаю текущий снимок из D1 …');
    const rows = await d1('SELECT code, price_retail, price_partner, qty, first_seen FROM ukrmobil_products');
    for (const r of rows) prev.set(String(r.code), r);
    log(`  в базе: ${prev.size} товаров`);
  }

  // 2. скрап
  const { items, requests, failures, empty, rebuilds, multi, sec } =
    await withSiteRetry(() => scrapeUkrmobil({ log, conc: CONCURRENCY, limit: LIMIT }), log);

  // 3. diff — пишем ТОЛЬКО изменившихся (иначе упрёмся в лимит записи D1 100k/сутки)
  const upserts = [], moves = [];
  let salesQty = 0, arrivalsQty = 0, changed = 0, isNew = 0, priceChanged = 0;
  for (const it of items) {
    const old = prev.get(it.code);
    const firstSeen = old?.first_seen ?? ts;
    const pChanged = old && (old.price_retail !== it.priceRetail || old.price_partner !== it.pricePartner);
    const qtyChanged = old && old.qty !== it.qty;
    if (!old) isNew++;
    if (pChanged) priceChanged++;
    if (!old || qtyChanged || pChanged) {
      upserts.push([it.code, it.name, it.url, it.category, it.priceRetail, it.priceVip, it.pricePartner,
        it.qty, it.qtyVirtual, it.incoming, it.incomingDate, firstSeen, ts]);
    }
    if (qtyChanged) {
      const delta = it.qty - old.qty;
      if (delta < 0) salesQty += -delta; else arrivalsQty += delta;
      changed++;
      moves.push([ts, it.code, it.name, it.category, old.qty, it.qty, delta,
        delta < 0 ? 'sale' : 'arrival', it.priceRetail, it.pricePartner]);
    }
    // нет old → новый товар: baseline без движения
  }

  // Коды, которых в проходе не встретилось. Строки в снимке НЕ трогаем: карточка могла
  // не ответить, а обнулять остаток — значит записать фантомную продажу. Неполный проход
  // поэтому даёт МЕНЬШЕ движений, но не даёт неверных.
  const seen = new Set(items.map((i) => i.code));
  const missing = [...prev.keys()].filter((c) => !seen.has(c)).length;

  log(`▸ diff: новых ${isNew} | изменилось остатков ${changed} | изменилось цен ${priceChanged} | к upsert ${upserts.length} | продано ${salesQty} | поступило ${arrivalsQty} | пропало из выдачи ${missing}`);

  if (DRY) {
    log('▸ DRY: в D1 не пишу.');
    const inStock = items.filter((i) => i.qty > 0);
    log(`   товаров ${items.length}, в наличии ${inStock.length}, запросов ${requests}, сбоев ${failures}, пустых ${empty}, за ${sec}с`);
    const cats = new Map();
    for (const i of items) cats.set(i.category || '—', (cats.get(i.category || '—') || 0) + 1);
    log(`   категорий ${cats.size}. Топ-8:`);
    for (const [c, n] of [...cats].sort((a, b) => b[1] - a[1]).slice(0, 8)) log(`     ${String(n).padStart(4)}  ${c}`);
    const wholesale = items.filter((i) => i.pricePartner != null && i.pricePartner !== i.priceRetail).length;
    log(`   партнёрская цена отличается от розничной у ${wholesale} товаров`);
    for (const m of moves.slice(0, 15)) {
      log(`   ${m[7] === 'sale' ? '🔴' : '🟢'} ${m[6] > 0 ? '+' : ''}${m[6]}  ${String(m[2]).slice(0, 60)}  (${m[4]}→${m[5]})`);
    }
    return;
  }

  // 4. запись
  log('▸ пишу в D1 …');
  const conflict = `ON CONFLICT(code) DO UPDATE SET
    name=excluded.name, url=excluded.url, category=excluded.category,
    price_retail=excluded.price_retail, price_vip=excluded.price_vip,
    price_partner=excluded.price_partner, qty=excluded.qty,
    qty_virtual=excluded.qty_virtual, incoming=excluded.incoming,
    incoming_date=excluded.incoming_date, updated_at=excluded.updated_at`;
  await bulkInsert('ukrmobil_products', PROD_COLS, upserts, { conflict });
  if (moves.length) await bulkInsert('ukrmobil_moves', MOVE_COLS, moves);

  // ⚠️ Полнота прохода считается В БОТЕ — сравнением с максимумом за неделю (как у m112,
  // ekran и kspace). Здесь её не определить: парсер не знает, сколько товаров «должно» быть.
  // empty_pages = карточки, не отдавшие товар даже с ретраями (сбои сети + пустые ответы).
  await d1(`INSERT INTO ukrmobil_scans
    (started_at, finished_at, pages, products, changed, sales_qty, arrivals_qty, empty_pages, missing, ok)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [ts, Math.floor(Date.now() / 1000), requests, items.length, changed,
      salesQty, arrivalsQty, failures + empty, missing, 1]);

  if (rebuilds) log(`  ⚠️ buildId перечитывался ${rebuilds} раз — сайт деплоился во время прохода`);
  if (multi) log(`  ⚠️ многовариантных товаров ${multi} — остаток просуммирован`);
  log(`✓ готово за ${((Date.now() - t0) / 1000) | 0}с: товаров ${items.length}, движений ${moves.length}`);
}

main().catch((e) => { log('✗ ОШИБКА:', e.stack || e.message); process.exit(1); });
