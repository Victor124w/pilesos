// Оркестратор прохода kspace-parts.com.ua: скрап → diff с D1 → запись изменений и движений.
// Полный аналог ekran-run.mjs, отличия — в шапке schema-kspace.sql.
//
// Запуск: node kspace-run.mjs         (пишет в D1)
//         node kspace-run.mjs --dry   (скрап + diff без записи)
import { scrapeKspace } from './kspace-scrape.mjs';
import { d1, bulkInsert } from './d1.mjs';

const DRY = process.argv.includes('--dry');
const log = (...a) => console.error(...a);

const PROD_COLS = ['code', 'name', 'url', 'section', 'price', 'qty', 'first_seen', 'updated_at'];
const MOVE_COLS = ['ts', 'code', 'name', 'section', 'qty_before', 'qty_after', 'delta', 'kind', 'price'];

async function main() {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);

  // 1. снимок из D1
  const prev = new Map();
  if (!DRY) {
    log('▸ читаю текущий снимок из D1 …');
    const rows = await d1('SELECT code, price, qty, first_seen FROM kspace_products');
    for (const r of rows) prev.set(String(r.code), r);
    log(`  в базе: ${prev.size} товаров`);
  }

  // 2. скрап
  log('▸ скрап каталога …');
  const { items, requests, pages, failures, mismatch } = await scrapeKspace({ log });

  // 3. diff — пишем ТОЛЬКО изменившихся (иначе упрёмся в лимит записи D1 100k/сутки)
  const upserts = [], moves = [];
  let salesQty = 0, arrivalsQty = 0, changed = 0, isNew = 0;
  for (const it of items) {
    const old = prev.get(it.code);
    const firstSeen = old?.first_seen ?? ts;
    const priceChanged = old && old.price !== it.price;
    const qtyChanged = old && old.qty !== it.qty;
    if (!old) isNew++;
    if (!old || qtyChanged || priceChanged) {
      upserts.push([it.code, it.name, it.url, it.section, it.price, it.qty, firstSeen, ts]);
    }
    if (qtyChanged) {
      const delta = it.qty - old.qty;
      if (delta < 0) salesQty += -delta; else arrivalsQty += delta;
      changed++;
      moves.push([ts, it.code, it.name, it.section, old.qty, it.qty, delta,
        delta < 0 ? 'sale' : 'arrival', it.price]);
    }
    // нет old → новый товар: baseline без движения
  }

  // Коды, которых в проходе не встретилось. Строки в снимке НЕ трогаем: товар мог просто
  // не попасть в неполный проход, а обнулять его остаток — значит записать фантомную продажу.
  // Число уходит в лог прохода как индикатор полноты.
  const seen = new Set(items.map((i) => i.code));
  const missing = [...prev.keys()].filter((c) => !seen.has(c)).length;

  log(`▸ diff: новых ${isNew} | изменилось остатков ${changed} | к upsert ${upserts.length} | продано ${salesQty} | поступило ${arrivalsQty} | пропало из выдачи ${missing}`);

  if (DRY) {
    log('▸ DRY: в D1 не пишу. Примеры движений:');
    for (const m of moves.slice(0, 15)) {
      log(`   ${m[7] === 'sale' ? '🔴' : '🟢'} ${m[6] > 0 ? '+' : ''}${m[6]}  ${String(m[2]).slice(0, 60)}  (${m[4]}→${m[5]})`);
    }
    log(`   всего движений: ${moves.length}`);
    log(`   товаров ${items.length}, запросов ${requests}, страниц ${pages}, сбоев ${failures}, за ${((Date.now() - t0) / 1000) | 0}с`);
    return;
  }

  // 4. запись
  log('▸ пишу в D1 …');
  const conflict = `ON CONFLICT(code) DO UPDATE SET
    name=excluded.name, url=excluded.url, section=excluded.section,
    price=excluded.price, qty=excluded.qty, updated_at=excluded.updated_at`;
  await bulkInsert('kspace_products', PROD_COLS, upserts, { conflict });
  if (moves.length) await bulkInsert('kspace_moves', MOVE_COLS, moves);

  // ⚠️ Полнота прохода считается В БОТЕ — сравнением с максимумом за неделю (как у m112 и ekran).
  // Здесь её не определить: парсер не знает, сколько товаров «должно» быть.
  // empty_pages — страницы, которые не удалось получить даже с ретраями; mismatch в лог
  // не пишем отдельной колонкой, он уходит предупреждением в вывод скрапа.
  await d1(`INSERT INTO kspace_scans
    (started_at, finished_at, pages, products, changed, sales_qty, arrivals_qty, empty_pages, missing, ok)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [ts, Math.floor(Date.now() / 1000), pages, items.length, changed,
      salesQty, arrivalsQty, failures, missing, 1]);

  log(`✓ готово за ${((Date.now() - t0) / 1000) | 0}с: товаров ${items.length}, запросов ${requests}, движений ${moves.length}`);
}

main().catch((e) => { log('✗ ОШИБКА:', e.stack || e.message); process.exit(1); });
