// Скрап каталога ukr-mobil.com. Разбор сайта и замеры — в Prices/ukrmobil_parsing.md
// (разведка 2026-08-07, перепроверено и уточнено 2026-08-08 перед написанием кода).
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ m112 / ekran / kspace:
//   Это Next.js (Vercel) поверх Odoo, а не Bitrix/OpenCart. Данные лежат в ДВУХ независимых
//   источниках, и оба нужны:
//     * GraphQL Odoo — ВЕСЬ каталог одним запросом за ~0.7 с: код, имя, категория, три цены
//       (розница / VIP / партнёрская). Уникальная для нашей подборки вещь — ОПТОВЫЕ цены
//       видны анониму. Но поля склада тут закрыты (`stock.warehouse` — нет прав).
//     * карточка товара — остаток. Только там, дешёвого пути нет: страницы категорий остаток
//       не несут, прайс-фидов нет, Odoo REST отдаёт Session Expired. Значит 1 запрос на товар.
//
// Замер 2026-08-08: потолок сайта ~4 req/s, выше 20 потоков роста нет вовсе, а медиана растёт
// линейно (6 пот. — 2255 мс, 30 пот. — 5872 мс). Сбоев и 429 не было ни на одном режиме.
// Рабочий режим CONC=15: 3.73 req/s ≈ 7.6 мин на 1702 карточки при вдвое меньшей нагрузке,
// чем на 30 потоках.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HOST = 'https://ukr-mobil.com';
const GRAPHQL = 'https://admin-new.dashboard-soft.com/graphql';

// ⚠️ Accept-Language обязателен: без него GraphQL отдаёт АНГЛИЙСКИЕ названия
// («Apple iPhone 11 display glass» вместо «Скло дисплея Apple iPhone 11»).
const H = { 'User-Agent': UA, 'Accept-Language': 'uk,ru;q=0.9' };

export const CONC = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: H });
      if (r.status === 200) return await r.text();
      if (a === tries) return '';
    } catch {
      if (a === tries) return '';
    }
    await sleep(400 * a);
  }
  return '';
}

/**
 * buildId Next.js — часть пути JSON-роута, меняется при КАЖДОМ деплое сайта.
 * Хардкодить нельзя: с чужим buildId все карточки отдадут 404.
 */
export async function fetchBuildId() {
  const html = await fetchText(`${HOST}/uk`);
  const id = (html.match(/"buildId":"([^"]+)"/) || [])[1];
  if (!id) throw new Error('buildId не найден на главной — вёрстка сайта поменялась');
  return id;
}

/**
 * Рабочие slug карточек — ТОЛЬКО из sitemap.
 *
 * ⚠️ Взять их из GraphQL (`website_url`) НЕЛЬЗЯ, хотя поле есть у всех 1834: проверено
 * 2026-08-08 — совпадений с sitemap 0 из 1616, ни один такой URL не открывается.
 * В хвосте website_url лежит id ВАРИАНТА, а сайт роутит по id шаблона.
 *
 * Языковые копии (/en/shop/, /ru/shop/) отбрасываем — нужен украинский, он без префикса.
 */
export async function fetchSlugs() {
  const xml = await fetchText(`${HOST}/sitemap.xml`);
  if (!xml) throw new Error('sitemap.xml не получен');
  const slugs = [...xml.matchAll(/<loc>https:\/\/ukr-mobil\.com\/shop\/([^<]+)<\/loc>/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

// Код товара — префикс slug до первого дефиса: «10003694-bms-plata-...» → «10003694».
export const codeOfSlug = (slug) => (slug.match(/^(\d+)-/) || [])[1] || null;

/**
 * Весь каталог из GraphQL: код → цены, категория, имя, опубликован ли.
 * Один запрос, ~0.9 с, 1834 товара (опубликованных 1616).
 *
 * `categ_id.display_name` — ГОТОВЫЙ путь категории («Все для ремонту дисплеїв / Скло дисплея /
 * iPhone»), 151 штука. Иначе разделы пришлось бы вытаскивать из карточек.
 */
export async function fetchCatalog() {
  const query = `{ProductProduct(limit:5000){
    id default_code name is_published
    price_retail price_vip price_partner
    categ_id{display_name}
  }}`;
  const r = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  const list = j?.data?.ProductProduct;
  if (!Array.isArray(list)) throw new Error('GraphQL не отдал каталог: ' + JSON.stringify(j).slice(0, 300));
  const map = new Map();
  for (const p of list) {
    if (!p.default_code) continue;
    map.set(String(p.default_code), {
      id: p.id,
      name: p.name || '',
      category: p.categ_id?.display_name || '',
      priceRetail: num(p.price_retail),
      priceVip: num(p.price_vip),
      pricePartner: num(p.price_partner),
      published: !!p.is_published,
    });
  }
  return map;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Одна карточка через JSON-роут Next.js (46 КБ против 89 КБ у HTML — вдвое меньше трафика).
 *
 * ⚠️ ГЛАВНАЯ ГРАБЛЯ: на неверный slug роут отдаёт не 404, а **200 с пустым pageProps**.
 * Если счесть это за «остаток 0», в базу уедет фантомная продажа. Поэтому отсутствие
 * объекта товара — это СБОЙ (null), а не ноль.
 *
 * Вариант у товаров ровно один (замер: 29 из 29), поэтому берём product_variant_ids[0].
 * Если вариантов вдруг станет больше — суммируем остаток и помечаем, чтобы это было видно.
 */
export function parseCard(json) {
  const tpl = json?.pageProps?.mainProductData?.ProductProduct?.[0];
  const vars = tpl?.product_variant_ids;
  if (!tpl || !Array.isArray(vars) || !vars.length) return null;
  const v = vars[0];
  const code = String(v.default_code || tpl.default_code || '').trim();
  if (!code) return null;
  return {
    code,
    name: tpl.name || v.display_name || '',
    qty: num(v.qty_available) ?? 0,
    qtyVirtual: num(v.virtual_available),
    incoming: num(v.incoming_qty),
    priceRetail: num(v.price_retail),
    priceVip: num(v.price_vip),
    pricePartner: num(v.price_partner),
    // «08.08.2026» → дата ближайшего прихода; false, когда прихода не ждут
    incomingDate: typeof v.last_receipt_scheduled_date === 'string' ? v.last_receipt_scheduled_date : null,
    variants: vars.length,
    qtyAll: vars.reduce((s, x) => s + (num(x.qty_available) ?? 0), 0),
  };
}

/**
 * Полный обход каталога.
 *
 * ⚠️ buildId может смениться ПРЯМО ВО ВРЕМЯ прохода — деплой сайта посреди наших 8 минут
 * реален. Симптом: карточки массово начинают отдавать 404. Поэтому при 404 один раз
 * перечитываем buildId и повторяем; счётчик `rebuilds` виден в логе.
 */
export async function scrapeUkrmobil({ log = () => {}, conc = CONC, limit = 0 } = {}) {
  const t0 = Date.now();

  log('▸ GraphQL: каталог с ценами и категориями …');
  const catalog = await fetchCatalog();
  const published = [...catalog.values()].filter((c) => c.published).length;
  log(`  ${catalog.size} товаров, опубликовано ${published}, категорий ${new Set([...catalog.values()].map((c) => c.category)).size}`);

  log('▸ sitemap: ссылки карточек …');
  let slugs = await fetchSlugs();
  log(`  ${slugs.length} карточек`);
  if (limit) slugs = slugs.slice(0, limit);

  let buildId = await fetchBuildId();
  log(`▸ buildId ${buildId}`);
  log(`▸ обход карточек, потоков ${conc} …`);

  const items = [];
  let done = 0, failures = 0, empty = 0, rebuilds = 0, multi = 0;
  let idx = 0;

  const one = async (slug) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let status = 0, txt = '';
      try {
        const r = await fetch(`${HOST}/_next/data/${buildId}/uk/shop/${slug}.json`, { headers: H });
        status = r.status;
        txt = await r.text();
      } catch { /* сеть — уходим в ретрай */ }

      if (status === 200 && txt) {
        let parsed = null;
        try { parsed = parseCard(JSON.parse(txt)); } catch { /* битый JSON — ретрай */ }
        if (parsed) return parsed;
        // 200 с пустым pageProps — устаревший slug либо сменившийся buildId
        if (attempt === 3) { empty++; return null; }
      }

      // Массовые 404 = сайт задеплоился, buildId протух. Перечитываем ОДИН раз.
      if (status === 404 && rebuilds < 3) {
        rebuilds++;
        const fresh = await fetchBuildId().catch(() => null);
        if (fresh && fresh !== buildId) { buildId = fresh; log(`  ⚠️ buildId сменился на ${fresh} — сайт задеплоился во время прохода`); }
      }
      if (attempt === 3) { failures++; return null; }
      await sleep(300 * attempt);
    }
    return null;
  };

  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) {
      const k = idx++;
      if (k >= slugs.length) return;
      const slug = slugs[k];
      const it = await one(slug);
      done++;
      if (done % 200 === 0) log(`  ${done}/${slugs.length} … ${((Date.now() - t0) / 1000) | 0}с`);
      if (!it) continue;
      if (it.variants > 1) multi++;
      const c = catalog.get(it.code);
      items.push({
        code: it.code,
        // Имя из карточки — украинское и полное; GraphQL как запасной вариант.
        name: it.name || c?.name || '',
        url: `${HOST}/shop/${slug}`,
        category: c?.category || '',
        // Цены есть в обоих источниках; карточка свежее, GraphQL страхует.
        priceRetail: it.priceRetail ?? c?.priceRetail ?? null,
        priceVip: it.priceVip ?? c?.priceVip ?? null,
        pricePartner: it.pricePartner ?? c?.pricePartner ?? null,
        qty: it.variants > 1 ? it.qtyAll : it.qty,
        qtyVirtual: it.qtyVirtual,
        incoming: it.incoming,
        incomingDate: it.incomingDate,
      });
    }
  }));

  const sec = ((Date.now() - t0) / 1000) | 0;
  if (failures) log(`  ⚠️ карточек не удалось получить: ${failures}`);
  if (empty) log(`  ⚠️ карточек с пустым ответом (устаревший slug): ${empty}`);
  if (multi) log(`  ⚠️ товаров с несколькими вариантами: ${multi} — остаток просуммирован, проверить схему`);
  log(`  готово: ${items.length} товаров за ${sec}с (${(items.length / Math.max(sec, 1)).toFixed(2)} req/s)`);

  return { items, catalog, requests: slugs.length, failures, empty, rebuilds, multi, sec };
}
