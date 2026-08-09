// Скрап каталога uparts.ua: РОЗНИЧНАЯ ЦЕНА + «є/немає». Количеств сайт не отдаёт.
//
// Разведка и все замеры — `Prices/docs/sites_nalichie.md`, раздел про uparts.
// Коротко, почему код такой короткий: сайт на Nuxt 3 с серверным рендером, и на
// КАЖДОЙ странице листинга лежит готовый блок JSON-LD `AggregateOffer` — по 20
// офферов с `sku`, названием, ценой и `availability`. Ни DOM-парсинга, ни карточек,
// ни JS не нужно: регэксп + JSON.parse.
//
// ⚠️ ОДНИМ ЗАПРОСОМ каталог не берётся, и искать такой путь бесполезно — проверено
// 08.08: прайс-фидов нет (16 путей, все 301→404), публичного API нет (Laravel
// `api.uparts.ua` отвечает «route could not be found» на все варианты, GraphQL
// отсутствует), каталог-API `admin.uparts.ua` за авторизацией, клиентских XHR нет
// вовсе. Остаётся пагинация: 467 страниц. Она дешёвая — полный проход 33 с.
//
// Запуск отдельно: node uparts-scrape.mjs        (короткая проба, 3 страницы)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BASE = 'https://uparts.ua/products/page-';

// ⚠️ ПАГИНАЦИЯ ТОЛЬКО ПУТЕВАЯ: `/products/page-2/`. Query-параметры сайт игнорирует
// МОЛЧА — `?page=2`, `?p=2`, `?PAGEN_1=2` отдают HTTP 200 и те же самые двадцать
// товаров, что и первая страница. Парсер на `?page=` намотал бы 467 копий первой
// страницы, отчитался «9321 товар обойдено» и выглядел бы полностью рабочим.
// Размер страницы поднять нельзя: `?limit`, `?per_page`, `?size`, `?take`,
// `/limit-100/` — всё проверено, всегда ровно 20.
const PER_PAGE = 20;

// Потолок на случай, если сайт когда-нибудь зациклит пагинацию (так делает kspace).
// 900 страниц = 18 000 товаров, вдвое больше нынешнего каталога.
const MAX_PAGES = 900;

// Потолок сайта ~11–14 стр/с (замер: conc 5 → 8.0, 10 → 9.4, 20 → 10.5, 30 → 10.9,
// дальше растёт только латентность). Берём 6: полный проход укладывается в 33 с
// при нулевых ошибках, нагрузка вдвое меньше, чем на 20 потоках.
const CONC = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Слаг категории из CDN-пути картинки: .../products/<СЛАГ>/<sku>/файл.png */
const CAT_RE = /^https:\/\/cdn\.uparts\.ua\/products\/([^/]+)\//;

/**
 * Категория товара. ⚠️ В JSON-LD листинга категории НЕТ, поэтому берём её из папки
 * картинки на CDN — проверено на выборке 200 товаров с 10 разных страниц, шаблон
 * совпал 200 из 200.
 *
 * ⚠️ Это ПАПКА КАТАЛОГА КАРТИНОК, а не каноническая категория сайта: у части разделов
 * есть по два слага, украинский и русский (`korpus-dlia-telefoniv` и
 * `korpus-dlya-telefonov`, `displeyi-dlia-telefoniv` и `ekrany-dlya-telefonov`) —
 * зависит от того, на каком языке товар заводили. Для группировки и фильтра в
 * отчёте годится, для точного дерева категорий — нет.
 */
function catOf(image) {
  const m = CAT_RE.exec(String(image || ''));
  return m ? m[1] : '';
}

/**
 * Разбор одной страницы листинга.
 *
 * Возвращает `{ items, total }`, где `total` — `offerCount` из того же блока.
 * `offerCount` — независимый счётчик всего каталога, ради него он и вытаскивается:
 * лекция Форсажа («покрытие проверять сверкой с независимым счётчиком») стоила там
 * двух молча потерявших товар версий обхода.
 */
export function parseListing(html) {
  const items = [];
  let total = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(m[1]); } catch { continue; }
    if (j['@type'] !== 'Product' || !j.offers || !Array.isArray(j.offers.offers)) continue;
    if (j.offers.offerCount != null) total = +j.offers.offerCount;
    for (const o of j.offers.offers) {
      const code = String(o.sku || '').trim();
      if (!code) continue;
      const price = Number(o.price);
      items.push({
        code,
        name: String(o.name || '').trim(),
        category: catOf(o.image),
        // Цена 0 = «уточнюйте», а не бесплатный товар (на 08.08 таких 161 из 9319).
        // Пишем NULL, чтобы ноль не участвовал в сравнении цен и в минимумах отчёта.
        price: Number.isFinite(price) && price > 0 ? price : null,
        inStock: /InStock/i.test(String(o.availability || '')) ? 1 : 0,
        // ⚠️ `offer.url` брать НЕЛЬЗЯ — в нём бага сайта, потерян слэш:
        // «https://uparts.uaproducts/p2193/». Собираем сами из кода.
        url: `https://uparts.ua/products/${code.toLowerCase()}/`,
      });
    }
  }
  return { items, total };
}

/**
 * Одна страница с ретраями.
 *
 * ⚠️ «Пусто» и «сбой» РАЗЛИЧАЮТСЯ, и это принципиально: пустая страница — признак
 * конца каталога, а сбой сети — нет. Спутать их значит оборвать обход на первой же
 * сетевой ошибке и записать половину каталога как полный проход (у ukr-mobil ровно
 * этой природы грабля: «200 с пустым телом» вместо 404).
 */
async function fetchPage(n, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(`${BASE}${n}/`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'uk', 'Accept-Encoding': 'gzip' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text();
      const { items, total } = parseListing(html);
      return { ok: true, n, items, total };
    } catch (e) {
      if (a === tries) return { ok: false, n, items: [], total: null, err: String(e.message || e) };
      await sleep(400 * a);
    }
  }
}

/**
 * Полный обход каталога.
 *
 * @param {object}   o
 * @param {Function} o.log        куда писать прогресс
 * @param {number}   o.conc       потоков (по умолчанию 6)
 * @param {number}   o.limitPages ограничить N страницами (для проб)
 */
export async function scrapeUparts({ log = () => {}, conc = CONC, limitPages = 0 } = {}) {
  const t0 = Date.now();
  const byCode = new Map();   // дедуп: см. ниже, порядок выдачи «плавает»
  let requests = 0, failures = 0, expected = null, lastPage = 0, endedClean = false;

  for (let page = 1; page <= MAX_PAGES;) {
    const batch = [];
    for (let i = 0; i < conc && page + i <= MAX_PAGES; i++) batch.push(page + i);
    const res = await Promise.all(batch.map((n) => fetchPage(n)));
    requests += batch.length;

    let stopAt = 0;
    for (const r of res) {
      if (!r.ok) { failures++; continue; }
      if (r.total != null && expected == null) expected = r.total;
      if (!r.items.length) { if (!stopAt || r.n < stopAt) stopAt = r.n; continue; }
      lastPage = Math.max(lastPage, r.n);
      // ⚠️ Дедуп по коду ОБЯЗАТЕЛЕН: порядок выдачи между запросами слегка «плавает»
      // (первый товар `/products/` — то `R45`, то `P687`), из-за чего позиция может
      // попасть на две страницы разом или проскочить между ними. Замер полного
      // прохода: 9319 собранных против 9321 по `offerCount`, расхождение 0.02%.
      for (const it of r.items) byCode.set(it.code, it);
    }

    if (stopAt) {
      // Пустая страница — конец каталога. Но сначала перепроверяем её ОДИНОЧНЫМ
      // запросом: пустой ответ на ровном месте (подвисший бэкенд, отданная не та
      // страница) оборвал бы обход в середине и выглядел бы штатным завершением.
      const again = await fetchPage(stopAt, 2);
      requests++;
      if (again.ok && !again.items.length) { endedClean = true; break; }
      if (again.ok && again.items.length) {
        for (const it of again.items) byCode.set(it.code, it);
        lastPage = Math.max(lastPage, again.n);
        log(`  ⚠️ страница ${stopAt} отдала пусто, при перепроверке — ${again.items.length} товаров; продолжаем`);
      }
    }

    page += batch.length;
    if (limitPages && page > limitPages) break;
    if (byCode.size && page % 120 === 1) log(`  … страница ${page}, товаров ${byCode.size}`);
  }

  const items = [...byCode.values()];
  const sec = Math.round((Date.now() - t0) / 1000);
  const inStock = items.filter((i) => i.inStock).length;

  // Сверка с независимым счётчиком. Пара штук расхождения — норма (каталог живёт
  // во время прохода), разы — признак того, что обход что-то молча теряет.
  const gap = expected != null ? expected - items.length : null;
  log(`▸ скрап: ${items.length} товаров (в наличии ${inStock}) со ${lastPage} страниц`
    + ` за ${sec}с, запросов ${requests}, сбоев ${failures}`
    + (expected != null ? `, по offerCount ожидалось ${expected} (расхождение ${gap})` : ''));
  // При `limitPages` обход оборван намеренно — предупреждать не о чем.
  if (!endedClean && !limitPages) log('  ⚠️ обход завершён НЕ пустой страницей — возможно, каталог обойдён не весь');

  return { items, expected, requests, failures, pages: lastPage, sec, endedClean, inStock };
}
