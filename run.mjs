// Оркестратор часового прохода: скрап каталога → diff с D1 → запись изменений и движений.
// Запуск: node scripts/m112/run.mjs            (полный каталог, пишет в D1)
//         node scripts/m112/run.mjs --dry       (скрап + diff, без записи в D1)
//         node scripts/m112/run.mjs --roots tachskrini,akumulyatori  (только эти разделы)
import { scrapeCatalog, ROOTS } from './scrape.mjs';
import { d1, bulkInsert } from './d1.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const rootsArg = (args[args.indexOf('--roots') + 1] || '').split(',').filter(Boolean);
const roots = rootsArg.length ? ROOTS.filter(r => rootsArg.includes(r.slug)) : ROOTS;
const log = (...a) => console.error(...a);

const PROD_COLS = ['product_id','name','url','top_section','section_name','brand','price',
  'q_dnepr','q_kiev','q_odesa','q_lvov','q_partner','q_total','first_seen','updated_at'];
const MOVE_COLS = ['ts','product_id','name','top_section','section_name','brand',
  'qty_before','qty_after','delta','kind','price'];

async function main() {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);

  // 1. текущий снимок из D1 (только нужное для diff)
  let prev = new Map();
  if (!DRY) {
    log('▸ читаю текущий снимок из D1 …');
    const rows = await d1('SELECT product_id, q_total, price, first_seen FROM m112_products');
    for (const r of rows) prev.set(String(r.product_id), r);
    log(`  в базе: ${prev.size} товаров`);
  }

  // 2. скрап
  log('▸ скрап каталога …');
  const { products, pages } = await scrapeCatalog({ roots, delay: 150, concurrency: 3, log });
  log(`  скачано: ${pages} страниц, ${products.length} уникальных товаров`);

  // 3. diff → upsert только изменившихся (иначе 32k×24 превысят лимит записи D1)
  const upserts = [], moves = [];
  let salesQty = 0, arrivalsQty = 0, changed = 0, isNew = 0;
  for (const p of products) {
    const old = prev.get(p.product_id);
    const firstSeen = old?.first_seen ?? ts;
    const priceChanged = old && old.price !== p.price;
    const qtyChanged = old && old.q_total != null && old.q_total !== p.q_total;
    if (!old) isNew++;
    if (!old || qtyChanged || priceChanged) {
      upserts.push([p.product_id, p.name, p.url, p.top_section, p.section_name, p.brand, p.price,
        p.q_dnepr, p.q_kiev, p.q_odesa, p.q_lvov, p.q_partner, p.q_total, firstSeen, ts]);
    }

    if (qtyChanged) {
      const delta = p.q_total - old.q_total;
      const kind = delta < 0 ? 'sale' : 'arrival';
      if (delta < 0) salesQty += -delta; else arrivalsQty += delta;
      changed++;
      moves.push([ts, p.product_id, p.name, p.top_section, p.section_name, p.brand,
        old.q_total, p.q_total, delta, kind, p.price]);
    }
    // old отсутствует → новый товар: baseline без движения (first_seen=ts)
  }

  log(`▸ diff: новых ${isNew} | изменилось остатков ${changed} | к upsert ${upserts.length} | продано ${salesQty} | поступило ${arrivalsQty}`);

  if (DRY) {
    log('▸ DRY: в D1 не пишу. Примеры движений:');
    for (const m of moves.slice(0, 15))
      log(`   ${m[9]==='sale'?'🔴':'🟢'} ${m[8]>0?'+':''}${m[8]}  ${String(m[2]).slice(0,50)}  (${m[6]}→${m[7]})`);
    log(`   всего движений: ${moves.length}`);
    return;
  }

  // 4. запись: upsert товаров, вставка движений, лог скана
  log('▸ пишу в D1 …');
  const conflict = `ON CONFLICT(product_id) DO UPDATE SET
    name=excluded.name, url=excluded.url, top_section=excluded.top_section,
    section_name=excluded.section_name, brand=excluded.brand, price=excluded.price,
    q_dnepr=excluded.q_dnepr, q_kiev=excluded.q_kiev, q_odesa=excluded.q_odesa,
    q_lvov=excluded.q_lvov, q_partner=excluded.q_partner, q_total=excluded.q_total,
    updated_at=excluded.updated_at`;
  await bulkInsert('m112_products', PROD_COLS, upserts, { conflict });
  if (moves.length) await bulkInsert('m112_moves', MOVE_COLS, moves);
  await d1(`INSERT INTO m112_scans
    (started_at, finished_at, pages, products, changed, sales_qty, arrivals_qty, ok)
    VALUES (?,?,?,?,?,?,?,1)`,
    [ts, Math.floor(Date.now()/1000), pages, products.length, changed, salesQty, arrivalsQty]);

  log(`✓ готово за ${((Date.now()-t0)/1000|0)}с: товаров ${products.length}, движений ${moves.length}`);
}

main().catch(e => { log('✗ ОШИБКА:', e.stack || e.message); process.exit(1); });
