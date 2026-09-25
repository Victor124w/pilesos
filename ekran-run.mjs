// Оркестратор прохода ekran.com.ua: скрап → diff с D1 → запись изменений и движений.
// Полный аналог run.mjs (m112), отличия — в шапке schema-ekran.sql.
//
// Запуск: node ekran-run.mjs         (пишет в D1)
//         node ekran-run.mjs --dry   (скрап + diff без записи)
import { scrapeEkran } from './ekran-scrape.mjs';
import { d1, bulkInsert } from './d1.mjs';
import { withSiteRetry } from './site-retry.mjs';

const DRY = process.argv.includes('--dry');
const log = (...a) => console.error(...a);

const PROD_COLS = ['offer_id', 'product_id', 'name', 'url', 'section', 'model', 'variant',
  'article', 'price', 'qty', 'can_buy', 'first_seen', 'updated_at'];
const MOVE_COLS = ['ts', 'offer_id', 'product_id', 'name', 'section', 'model',
  'qty_before', 'qty_after', 'delta', 'kind', 'price'];

async function main() {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);

  // 1. снимок из D1
  const prev = new Map();
  if (!DRY) {
    log('▸ читаю текущий снимок из D1 …');
    const rows = await d1('SELECT offer_id, price, qty, first_seen FROM ekran_products');
    for (const r of rows) prev.set(String(r.offer_id), r);
    log(`  в базе: ${prev.size} предложений`);
  }

  // 2. скрап
  log('▸ скрап каталога …');
  const { offers, requests, catalogSize, mismatch } = await withSiteRetry(() => scrapeEkran({ log, concurrency: 3, delay: 120 }), log);

  // 3. diff — пишем ТОЛЬКО изменившихся (иначе упрёмся в лимит записи D1 100k/сутки)
  const upserts = [], moves = [];
  let salesQty = 0, arrivalsQty = 0, changed = 0, isNew = 0;
  for (const o of offers) {
    const old = prev.get(o.offer_id);
    const firstSeen = old?.first_seen ?? ts;
    const priceChanged = old && old.price !== o.price;
    // qty === null у простых товаров: сравнивать нечего, движений у них не бывает.
    const qtyChanged = old && o.qty !== null && old.qty !== null && old.qty !== o.qty;
    if (!old) isNew++;
    if (!old || qtyChanged || priceChanged) {
      upserts.push([o.offer_id, o.product_id, o.name, o.url, o.section, o.model, o.variant,
        o.article, o.price, o.qty, o.can_buy, firstSeen, ts]);
    }
    if (qtyChanged) {
      const delta = +(o.qty - old.qty).toFixed(3);
      if (delta < 0) salesQty += -delta; else arrivalsQty += delta;
      changed++;
      moves.push([ts, o.offer_id, o.product_id, o.name, o.section, o.model,
        old.qty, o.qty, delta, delta < 0 ? 'sale' : 'arrival', o.price]);
    }
    // нет old → новое предложение: baseline без движения
  }

  log(`▸ diff: новых ${isNew} | изменилось остатков ${changed} | к upsert ${upserts.length} | продано ${salesQty.toFixed(2)} | поступило ${arrivalsQty.toFixed(2)}`);

  if (DRY) {
    log('▸ DRY: в D1 не пишу. Примеры движений:');
    for (const m of moves.slice(0, 15)) {
      log(`   ${m[9] === 'sale' ? '🔴' : '🟢'} ${m[8] > 0 ? '+' : ''}${m[8]}  ${String(m[3]).slice(0, 60)}  (${m[6]}→${m[7]})`);
    }
    log(`   всего движений: ${moves.length}`);
    return;
  }

  // 4. запись
  log('▸ пишу в D1 …');
  const conflict = `ON CONFLICT(offer_id) DO UPDATE SET
    product_id=excluded.product_id, name=excluded.name, url=excluded.url,
    section=excluded.section, model=excluded.model, variant=excluded.variant,
    article=excluded.article, price=excluded.price, qty=excluded.qty,
    can_buy=excluded.can_buy, updated_at=excluded.updated_at`;
  await bulkInsert('ekran_products', PROD_COLS, upserts, { conflict });
  if (moves.length) await bulkInsert('ekran_moves', MOVE_COLS, moves);

  // ⚠️ Полнота прохода считается В БОТЕ — сравнением с максимумом за неделю (как у m112).
  // Здесь её не определить: парсер не знает, сколько предложений «должно» быть.
  // `empty_pages` держит счётчик расхождений «сумма складов ≠ CATALOG_QUANTITY» —
  // это сигнал, что схема сайта поехала. Единичные расхождения бывают (видел 1 из 3786),
  // поэтому ok по ним НЕ роняем: иначе статус всегда показывал бы «неполный».
  await d1(`INSERT INTO ekran_scans
    (started_at, finished_at, pages, products, changed, sales_qty, arrivals_qty, empty_pages, ok)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [ts, Math.floor(Date.now() / 1000), catalogSize, offers.length, changed,
      +salesQty.toFixed(3), +arrivalsQty.toFixed(3), mismatch, 1]);

  log(`✓ готово за ${((Date.now() - t0) / 1000) | 0}с: предложений ${offers.length}, запросов ${requests}, движений ${moves.length}`);
}

main().catch((e) => { log('✗ ОШИБКА:', e.stack || e.message); process.exit(1); });
