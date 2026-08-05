// Скрап каталога ekran.com.ua: карта товаров со страниц категорий + цены/остатки через AJAX.
// Разбор сайта и замеры — в Prices/ekran_parsing.md (проверено 2026-08-05).
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ m112 (scrape.mjs):
//   m112 отдаёт цену и остаток прямо в листинге — хватает GET страниц.
//   ekran в HTML цен НЕ отдаёт вовсе: они подгружаются POST-запросом на каждый выбор
//   варианта. Поэтому здесь два прохода: сначала карта товаров, потом AJAX по вариантам.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HOST = 'https://ekran.com.ua';
const AJAX = `${HOST}/bitrix/templates/dresscodeV2/components/dresscode/catalog.item/detail/ajax.php`;
const SITEMAP = `${HOST}/sitemap-iblock-18.xml`;

// Услуги (замена стекла, ремонт FaceID и пр.) не отслеживаем — решение владельца 2026-08-05.
// ⚠️ Фильтруем ПО РАЗДЕЛУ, а не по словам в названии: под «замена»/«переклейка» попадают
// настоящие товары — «Дисплей, заменено только стекло» и «Стекло под переклейку iPad».
// Проверено: все услуги каталога лежат ровно в этом разделе.
const SKIP_SECTIONS = ['/catalog/uslugy_perekleyky/'];
const skipUrl = (u) => SKIP_SECTIONS.some((s) => u.includes(s));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, opts = {}, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) }, ...opts });
      if (r.status === 200) return await r.text();
      if (a === tries) return '';
    } catch {
      if (a === tries) return '';
    }
    await sleep(400 * a);
  }
  return '';
}

/** Разделы каталога из карты сайта (страницы, а не карточки товаров). */
export async function categoryUrls() {
  const xml = await fetchText(SITEMAP);
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => u.endsWith('/'));
}

/**
 * Товары со страницы категории.
 *
 * ⚠️ Карточки товаров качать НЕ нужно: листинг несёт те же data-атрибуты
 * (product-id / iblock-id / prop-id) и полные списки значений свойств.
 * 55 страниц категорий вместо 250 карточек.
 */
export function parseListing(html, pageUrl) {
  const out = [];
  for (const b of html.split(/<div class="itemRow item sku"/).slice(1)) {
    const at = (n) => (b.match(new RegExp(`data-${n}="([^"]*)"`)) || [])[1] || '';
    const productId = at('product-id');
    if (!productId) continue;
    const href = (b.match(/href="(\/catalog\/[^"]+\.html)"/) || [])[1] || '';
    const url = href ? HOST + href : pageUrl;
    if (skipUrl(url)) continue;
    const nameRaw = (b.match(/<a[^>]*class="name"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '';
    // Цена товара «по умолчанию» — единственная, что есть в листинге. Нужна для товаров
    // без вариантов: у них AJAX не работает (см. ниже), другого источника цены нет.
    const listPrice = (b.match(/<a class="price">([^<]*?)грн/) || [])[1];
    const props = [...b.matchAll(/<div class="skuProperty"[^>]*data-name="([^"]*)"[^>]*data-level="([^"]*)"[\s\S]*?<\/ul>/g)]
      .map((m) => ({
        name: m[1],
        level: m[2],
        vals: [...m[0].matchAll(/<li class="skuPropertyValue[^"]*"[\s\S]*?data-value="([^"]*)"/g)].map((x) => x[1]),
      }));
    out.push({
      productId,
      iblockId: at('iblock-id'),
      propId: at('prop-id'),
      name: nameRaw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      url,
      section: sectionOf(url),
      price: listPrice ? +listPrice.replace(/\s/g, '').replace(',', '.') : null,
      props,
    });
  }
  return out;
}

/** Раздел = второй сегмент пути: /catalog/<раздел>/… */
const sectionOf = (url) => {
  const p = url.replace(HOST, '').split('/').filter(Boolean);
  return p[1] || '';
};

/** Карта каталога: product_id → параметры для AJAX. Меняется редко, тянуть каждый скан незачем. */
export async function buildCatalogMap({ log = () => {}, concurrency = 3, delay = 200 } = {}) {
  const cats = (await categoryUrls()).filter((u) => !skipUrl(u));
  log(`  разделов в карте сайта: ${cats.length}`);
  const byId = new Map();
  for (let i = 0; i < cats.length; i += concurrency) {
    const chunk = cats.slice(i, i + concurrency);
    const pages = await Promise.all(chunk.map((u) => fetchText(u)));
    pages.forEach((h, k) => {
      if (!h) return;
      for (const it of parseListing(h, chunk[k])) if (!byId.has(it.productId)) byId.set(it.productId, it);
    });
    await sleep(delay);
  }
  const list = [...byId.values()];
  log(`  товаров: ${list.length} (с вариантами ${list.filter((x) => x.props.length).length})`);
  return list;
}

/** Один AJAX-выбор варианта. `params` — строка вида `PROP:знач;PROP2:знач;`. */
async function selectSku(p, params, level) {
  const body = new URLSearchParams({
    act: 'selectSku', params, props: params, level: String(level),
    iblock_id: p.iblockId, prop_id: p.propId, product_id: p.productId,
    highload: '', stores_params: '',
  });
  const txt = await fetchText(AJAX, {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body,
  });
  try { return JSON.parse(txt)?.[0]?.PRODUCT || null; } catch { return null; }
}

/**
 * Предложение из ответа AJAX.
 *
 * ⚠️ Модель и цвет берём из PROPERTIES ОТВЕТА, а не из того, что просили: несуществующая
 * комбинация не даёт ошибку, а возвращает ближайшее предложение. Поэтому же дедуп идёт
 * по offer_id — у товара 26×29 живых предложений оказалось ~150, а не 754.
 *
 * ⚠️ CATALOG_QUANTITY — ДРОБНОЕ (плёнка и клей меряются метрами): parseFloat, не parseInt.
 */
function toOffer(prod, p) {
  if (!prod?.ID) return null;
  const pv = (k) => {
    const v = prod.PROPERTIES?.[k]?.VALUE;
    return Array.isArray(v) ? v.join(', ') : (v ?? '');
  };
  const price = +(prod.PRICE?.PRICE?.PRICE ?? NaN);
  const stores = Array.isArray(prod.STORES) ? prod.STORES : [];
  return {
    offer_id: String(prod.ID),
    product_id: p.productId,
    name: String(prod.NAME || p.name).replace(/\s+/g, ' ').trim(),
    url: p.url,
    section: p.section,
    model: String(pv('VYBERETE_PREDLOZHENIE') || ''),
    variant: String(pv('COLOR') || ''),
    article: String(pv('CML2_ARTICLE') || ''),
    price: Number.isFinite(price) ? price : null,
    // Сумма складских строк. Замер на 248 предложениях: всегда равна CATALOG_QUANTITY,
    // второй склад ни разу не был ненулевым. Считаем сумму, чтобы поймать расхождение,
    // если магазин когда-нибудь оживит второй склад.
    // ⚠️ Остаток — ТОЛЬКО CATALOG_QUANTITY. Сумму складов брать НЕЛЬЗЯ: замер полного
    // прохода (5125 запросов, 2191 предложение) нашёл предложение ID 13282
    // «Стекло камеры (11 Pro)»: CATALOG_QUANTITY=17, а STORES=["4","0"], сумма 4.
    // Тринадцать штук в разбивке не учтены — рассинхрон учёта на стороне магазина.
    // Возьми мы сумму — в базе стояло бы 4, а после починки учёта скан увидел бы +13
    // и записал фантомный приход. qty_stores держим только для сверки.
    qty: parseFloat(prod.CATALOG_QUANTITY ?? '0') || 0,
    qty_stores: stores.reduce((a, s) => a + (parseFloat(s.AMOUNT) || 0), 0),
    can_buy: prod.CAN_BUY === 'Y' ? 1 : 0,
  };
}

/**
 * Полный проход: по карте каталога собрать все предложения.
 *
 * Товары БЕЗ вариантов (их ~108) через AJAX не идут: при пустом params эндпоинт
 * возвращает чужое предложение (пять разных товаров дали одинаковые 3224.00).
 * Для них берём цену из листинга, остаток недоступен в принципе → qty=null.
 */
export async function scrapeEkran({ log = () => {}, concurrency = 3, delay = 120, map = null } = {}) {
  const catalog = map || await buildCatalogMap({ log });
  const offers = new Map();
  const simple = [];
  let requests = 0, mismatch = 0;

  const tasks = [];
  for (const p of catalog) {
    if (!p.props.length) {
      // Простой товар: цена из листинга, остатка нет.
      simple.push({
        offer_id: `p${p.productId}`, product_id: p.productId, name: p.name, url: p.url,
        section: p.section, model: '', variant: '', article: '',
        price: p.price, qty: null, qty_stores: null, can_buy: 1,
      });
      continue;
    }
    const l1 = p.props[0];
    const l2 = p.props[1];
    if (l2 && l2.vals.length > 1) {
      // Второй уровень обязателен: без него цена может отличаться в разы
      // (33890: «11 серия» → 2999, «11 серия»+COLOR:11 → 1266).
      for (const a of l1.vals) for (const b of l2.vals) {
        tasks.push({ p, params: `${l1.name}:${a};${l2.name}:${b};`, level: 2 });
      }
    } else {
      for (const a of l1.vals) tasks.push({ p, params: `${l1.name}:${a};`, level: 1 });
    }
  }
  log(`  простых товаров: ${simple.length}, AJAX-запросов: ${tasks.length}`);

  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    const res = await Promise.all(chunk.map((t) => selectSku(t.p, t.params, t.level)));
    res.forEach((prod, k) => {
      requests++;
      const o = toOffer(prod, chunk[k].p);
      if (!o) return;
      if (o.qty_stores !== o.qty) mismatch++;
      // Дедуп по offer_id: одна и та же комбинация приходит много раз.
      if (!offers.has(o.offer_id)) offers.set(o.offer_id, o);
    });
    if (delay) await sleep(delay);
    if (requests % 500 === 0) log(`  … ${requests}/${tasks.length} запросов, предложений ${offers.size}`);
  }

  const all = [...offers.values(), ...simple];
  log(`  предложений: ${offers.size} + простых ${simple.length} = ${all.length}`);
  if (mismatch) log(`  ⚠️ сумма складов ≠ CATALOG_QUANTITY у ${mismatch} ответов — проверить схему сайта`);
  return { offers: all, requests, catalogSize: catalog.length, mismatch };
}
