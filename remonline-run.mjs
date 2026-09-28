// Оркестратор прохода по НАШЕМУ складу RemOnline: срез склада → diff с D1 → запись
// изменений и движений. Аналог ukrmobil-run.mjs, отличия:
//   * источник — API нашей CRM, а не чужой сайт (см. remonline-scrape.mjs);
//   * срез приходит только по позициям с остатком > 0, поэтому позиция, пропавшая из
//     выдачи, = остаток ушёл в 0. Это честно, потому что scrape гарантирует ПОЛНЫЙ проход
//     (иначе бросает ошибку и сюда не доходит). У чужих сайтов так делать нельзя;
//   * остаток дробный (расходники), резерв хранится отдельно.
//
// ⚠️ Репозиторий публичный — в лог Actions пишем только числа, без названий и цен.
//
// Запуск: node remonline-run.mjs          (пишет в D1)
//         node remonline-run.mjs --dry    (срез + diff без записи; детали — только локально)
import { scrapeRemonline } from './remonline-scrape.mjs';
import { d1, bulkInsert } from './d1.mjs';
import { withSiteRetry } from './site-retry.mjs';

const DRY = process.argv.includes('--dry');
const log = (...a) => console.error(...a);
const r3 = (v) => Math.round(v * 1000) / 1000;

const PROD_COLS = ['id', 'name', 'article', 'code', 'category', 'section', 'price_b2b', 'price_retail',
  'qty', 'reserved', 'first_seen', 'updated_at'];
const MOVE_COLS = ['ts', 'product_id', 'name', 'category', 'section', 'qty_before', 'qty_after', 'delta',
  'kind', 'price_b2b', 'price_retail'];

async function main() {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);

  // 1. снимок из D1
  const prev = new Map();
  if (!DRY) {
    log('▸ читаю текущий снимок из D1 …');
    const rows = await d1(`SELECT id, name, category, section, price_b2b, price_retail, qty, reserved, first_seen
                             FROM ro_products`);
    for (const r of rows) prev.set(String(r.id), r);
    log(`  в базе: ${prev.size} позиций`);
  }

  // 2. срез склада (при обрыве связи — один повтор через 10 мин, как у остальных парсеров)
  const { items, pages, total, sec } = await withSiteRetry(() => scrapeRemonline({ log }), log);

  // 3. diff — пишем ТОЛЬКО изменившиеся (лимит записи D1 100k/сутки)
  const upserts = [];
  const moves = [];
  let salesQty = 0, arrivalsQty = 0, changed = 0, isNew = 0;
  const seen = new Set();

  for (const it of items) {
    seen.add(it.id);
    const old = prev.get(it.id);
    const firstSeen = old?.first_seen ?? ts;
    const qtyChanged = old && Math.abs((old.qty || 0) - it.qty) > 1e-9;
    const other = old && (old.price_b2b !== it.priceB2b || old.price_retail !== it.priceRetail
      || (old.reserved || 0) !== it.reserved || old.name !== it.name || old.section !== it.section);
    if (!old || qtyChanged || other) {
      upserts.push([it.id, it.name, it.article, it.code, it.category, it.section, it.priceB2b, it.priceRetail,
        it.qty, it.reserved, firstSeen, ts]);
    }
    if (!old) {
      // Новой позиции в базе ещё не было. На ПЕРВОМ проходе (база пуста) это baseline без движения;
      // дальше — позиция появилась на складе из нуля, то есть поступление.
      isNew++;
      if (prev.size) {
        arrivalsQty += it.qty;
        changed++;
        moves.push([ts, it.id, it.name, it.category, it.section, 0, it.qty, it.qty, 'arrival', it.priceB2b, it.priceRetail]);
      }
      continue;
    }
    if (qtyChanged) {
      const delta = r3(it.qty - (old.qty || 0));
      if (delta < 0) salesQty += -delta; else arrivalsQty += delta;
      changed++;
      moves.push([ts, it.id, it.name, it.category, it.section, old.qty || 0, it.qty, delta,
        delta < 0 ? 'sale' : 'arrival', it.priceB2b, it.priceRetail]);
    }
  }

  // Позиции, которых нет среди ненулевых: остаток ушёл в 0.
  let zeroed = 0;
  for (const [id, old] of prev) {
    if (seen.has(id) || !(old.qty > 0)) continue;
    zeroed++;
    changed++;
    salesQty += old.qty;
    moves.push([ts, id, old.name, old.category, old.section, old.qty, 0, r3(-old.qty), 'sale', old.price_b2b, old.price_retail]);
    upserts.push([id, old.name, null, null, old.category, old.section, old.price_b2b, old.price_retail,
      0, 0, old.first_seen, ts]);
  }

  log(`▸ diff: позиций ${items.length} | новых ${isNew} | изменилось остатков ${changed} (в т.ч. обнулилось ${zeroed}) | к upsert ${upserts.length} | ушло ${r3(salesQty)} | поступило ${r3(arrivalsQty)}`);

  if (DRY) {
    log(`▸ DRY: в D1 не пишу. Страниц ${pages}, всего по API ${total}, за ${sec}с`);
    const bySection = new Map();
    for (const i of items) bySection.set(i.section, (bySection.get(i.section) || 0) + i.qty);
    log(`   разделов ${bySection.size}. Топ-10 по остатку:`);
    for (const [s, q] of [...bySection].sort((a, b) => b[1] - a[1]).slice(0, 10)) log(`     ${String(r3(q)).padStart(8)}  ${s}`);
    return;
  }

  // 4. запись. article/code при обнулении не знаем — COALESCE оставляет прежние.
  log('▸ пишу в D1 …');
  const conflict = `ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, article=COALESCE(excluded.article, ro_products.article),
    code=COALESCE(excluded.code, ro_products.code), category=excluded.category, section=excluded.section,
    price_b2b=excluded.price_b2b, price_retail=excluded.price_retail, qty=excluded.qty,
    reserved=excluded.reserved, updated_at=excluded.updated_at`;
  await bulkInsert('ro_products', PROD_COLS, upserts, { conflict });
  if (moves.length) await bulkInsert('ro_moves', MOVE_COLS, moves);

  await d1(`INSERT INTO ro_scans
    (started_at, finished_at, pages, products, changed, sales_qty, arrivals_qty, empty_pages, missing, ok)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [ts, Math.floor(Date.now() / 1000), pages, items.length, changed, r3(salesQty), r3(arrivalsQty), 0, zeroed, 1]);

  log(`✓ готово за ${((Date.now() - t0) / 1000) | 0}с: позиций ${items.length}, движений ${moves.length}`);
}

main().catch((e) => { log('✗ ОШИБКА:', e.message); process.exit(1); });
