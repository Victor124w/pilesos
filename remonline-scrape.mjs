// Остатки НАШЕГО склада из API RemOnline (RO App) — «скрап» для remonline-run.mjs.
//
// Источник: GET /warehouse/goods/{склад}?exclude_zero_residue=true (старое API — в v2
// раздела склада нет). Отдаёт сразу всё нужное: название, артикул, код, цены, категорию,
// остаток (residue) и резерв (reserved). Справка по полям — RemOnline-Sync/api-roapp.md.
//
// ⚠️ Лимит API — 3 запроса в секунду: качаем по 3 страницы, пачка не чаще раза в ~1.1 с.
// ⚠️ Проход обязан быть ПОЛНЫМ: remonline-run обнуляет остаток у позиций, которых нет в
//    выдаче ненулевых. Любая недокачанная страница = фантомные продажи. Поэтому при
//    несовпадении с count из API здесь бросаем ошибку — и в D1 ничего не пишется.
// ⚠️ Репозиторий публичный, логи Actions видны всем: в лог — ТОЛЬКО числа.
//
// env: RO_TOKEN (API-ключ RemOnline), RO_WAREHOUSE_ID (по умолчанию 59938)

const BASE = 'https://api.roapp.io';
const PER_PAGE = 50;
const PARALLEL = 3;
const BATCH_MS = 1100;
const B2B_PRICE = '163521';
const RETAIL_PRICE = '163520';

export const WAREHOUSE_ID = process.env.RO_WAREHOUSE_ID || '59938';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

async function get(path, { tries = 4 } = {}) {
  const token = process.env.RO_TOKEN;
  if (!token) throw new Error('нет env RO_TOKEN');
  let last;
  for (let a = 1; a <= tries; a++) {
    let res;
    try {
      res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (e) {
      last = e;
      if (a < tries) { await sleep(2000 * a); continue; }
      throw e;
    }
    if ((res.status === 429 || res.status >= 500) && a < tries) { await sleep(2000 * a); continue; }
    if (res.status === 401 || res.status === 403) throw new Error(`RemOnline не принял токен (HTTP ${res.status})`);
    if (res.status === 404) return { status: 404, json: null };
    if (!res.ok) {
      const e = new Error(`RemOnline HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return { status: res.status, json: await res.json() };
  }
  throw last || new Error('RemOnline не отвечает');
}

const itemsOf = (json) => (Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : []);

/** Все страницы списка; страницы 2..N — по 3 параллельно. Возвращает {items, pages, total}. */
async function fetchAllPages(path, query, log) {
  const url = (p) => `${path}?page=${p}&limit=${PER_PAGE}${query}`;
  const first = await get(url(1));
  const firstItems = itemsOf(first.json);
  const total = Number(first.json?.count) || 0;
  const items = [...firstItems];
  let pages = 1;
  if (!firstItems.length) return { items, pages, total };

  if (total) {
    const last = Math.ceil(total / firstItems.length);
    for (let p = 2; p <= last; p += PARALLEL) {
      const t0 = Date.now();
      const nums = [];
      for (let k = p; k < p + PARALLEL && k <= last; k++) nums.push(k);
      const res = await Promise.all(nums.map((n) => get(url(n))));
      res.forEach((r) => items.push(...itemsOf(r.json)));
      pages += nums.length;
      const wait = BATCH_MS - (Date.now() - t0);
      if (p + PARALLEL <= last && wait > 0) await sleep(wait);
    }
  } else {
    // count не пришёл — по одной странице до пустой / неполной / повтора
    let prevFirst = JSON.stringify(firstItems[0]?.id);
    for (let p = 2; p < 2000; p++) {
      const t0 = Date.now();
      const batch = itemsOf((await get(url(p))).json);
      pages++;
      const f = JSON.stringify(batch[0]?.id);
      if (!batch.length || f === prevFirst) break;
      prevFirst = f;
      items.push(...batch);
      if (batch.length < firstItems.length) break;
      const wait = Math.round(BATCH_MS / PARALLEL) - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
  }
  log(`  ${path}: страниц ${pages}, записей ${items.length}${total ? ` из ${total}` : ''}`);
  return { items, pages, total };
}

/** Дерево категорий → id → «путь без корней "_…"» и «верхний значимый уровень». */
async function loadCategories(log) {
  let cats = [];
  try {
    cats = (await fetchAllPages('/warehouse/categories/', '', log)).items;
  } catch (e) {
    log(`  ⚠️ категории не получены (${e.message}) — будут только названия листовых категорий`);
    return () => null;
  }
  const byId = new Map(cats.map((c) => [String(c.id), { title: String(c.title || c.name || '').trim(), parent: c.parent_id != null ? String(c.parent_id) : null }]));
  const cache = new Map();
  return (id) => {
    id = id != null ? String(id) : '';
    if (!byId.has(id)) return null;
    if (cache.has(id)) return cache.get(id);
    const parts = [];
    const seen = new Set();
    for (let cur = id; cur && byId.has(cur) && !seen.has(cur); cur = byId.get(cur).parent) {
      seen.add(cur);
      parts.unshift(byId.get(cur).title);
    }
    // корни вида «_Запчастини SkloRepair», «__Запчастини iPhone» — технические, в отчётах шум
    const meaningful = parts.filter((p) => !p.startsWith('_'));
    const path = (meaningful.length ? meaningful : parts).join(' / ');
    const out = { category: path, section: (meaningful[0] || parts[parts.length - 1] || '').trim() };
    cache.set(id, out);
    return out;
  };
}

/**
 * Полный срез склада: позиции с остатком > 0.
 * { items: [{id, name, article, code, category, section, priceB2b, priceRetail, qty, reserved}], pages, total, sec }
 */
export async function scrapeRemonline({ log = console.error } = {}) {
  const t0 = Date.now();
  const catOf = await loadCategories(log);

  const path = `/warehouse/goods/${WAREHOUSE_ID}`;
  let res;
  try {
    res = await fetchAllPages(path, '&exclude_zero_residue=true', log);
  } catch (e) {
    if (!(e.status >= 400 && e.status < 500)) throw e;
    log(`  exclude_zero_residue не принят (HTTP ${e.status}) — беру склад целиком`);
    res = await fetchAllPages(path, '', log);
  }

  // Полнота: уникальных позиций должно быть столько, сколько сказал API.
  const byId = new Map();
  for (const it of res.items) if (it && it.id != null) byId.set(String(it.id), it);
  if (res.total && byId.size < res.total) {
    throw new Error(`неполный проход склада: получено ${byId.size} из ${res.total} — в D1 не пишу`);
  }

  const items = [];
  for (const [id, it] of byId) {
    const qty = num(it.residue) ?? 0;
    if (qty <= 0) continue; // если exclude_zero проигнорирован — нули отсекаем сами
    const prices = it.price && typeof it.price === 'object' ? it.price : it.prices || {};
    const cat = it.category || {};
    const tree = catOf(cat.id);
    items.push({
      id,
      name: String(it.title || '').trim(),
      article: String(it.article || '').trim() || null,
      code: String(it.code || '').trim() || null,
      category: tree?.category || String(cat.title || '').trim() || null,
      section: tree?.section || String(cat.title || '').trim() || 'Інше',
      priceB2b: num(prices[B2B_PRICE]),
      priceRetail: num(prices[RETAIL_PRICE]),
      qty,
      reserved: num(it.reserved) ?? 0,
    });
  }
  return { items, pages: res.pages, total: res.total, sec: Math.round((Date.now() - t0) / 1000) };
}
