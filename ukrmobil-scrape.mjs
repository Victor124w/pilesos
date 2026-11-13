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
// 2026-11-12: сайт переехал на www — без него каждый запрос идёт лишним редиректом 308.
const HOST = 'https://www.ukr-mobil.com';
// 2026-10: сайт переехал с admin-new.dashboard-soft.com — старый адрес отдаёт 301, а fetch
// превращает POST в GET без тела, и GraphQL отвечает «Syntax Error: Unexpected <EOF>».
const GRAPHQL = 'https://admin-ukr-mobile.com.ua/graphql';

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
 * 2026-11-12: сайт переехал на www.ukr-mobil.com и на Next.js App Router. JSON-роута
 * `/_next/data/<buildId>/…` и самого buildId больше нет — данные товара теперь вшиты в HTML
 * карточки RSC-потоком: строки `self.__next_f.push([1,"…"])`. Склеиваем их и достаём объект
 * `"mainProduct":{"ProductProduct":[…]}` — по составу полей это тот же объект, что раньше лежал
 * в `pageProps.mainProductData`.
 *
 * Объект может быть разрезан между двумя push — поэтому сначала склейка всех строк, потом поиск.
 */
export function extractMainProduct(html) {
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { flight += JSON.parse(m[1]); } catch { /* битая строка — пропускаем */ }
  }
  const key = '"mainProduct":';
  const at = flight.indexOf(key);
  if (at < 0) return null;
  const raw = balancedJson(flight, at + key.length);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Вырезает JSON-объект/массив, начинающийся с позиции start, с учётом строк и экранирования.
function balancedJson(s, start) {
  if (s[start] !== '{' && s[start] !== '[') return null;
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (--depth === 0) return s.slice(start, i + 1); }
  }
  return null;
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
  const slugs = [...xml.matchAll(/<loc>https:\/\/(?:www\.)?ukr-mobil\.com\/shop\/([^<]+)<\/loc>/g)].map((m) => m[1]);
  // Пустой список при живом sitemap — сменился формат ссылок; без throw проход молча был бы пустым.
  if (!slugs.length) throw new Error('в sitemap.xml нет ни одной ссылки /shop/ — формат поменялся');
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
 * Одна карточка: объект `mainProduct` из HTML (см. extractMainProduct, ~150 КБ на карточку).
 *
 * ⚠️ ГЛАВНАЯ ГРАБЛЯ: отсутствие объекта товара — это СБОЙ (null), а не «остаток 0».
 * Иначе в базу уедет фантомная продажа.
 *
 * Возвращает МАССИВ — по товару на каждый вариант. С 2026-11 на сайте есть шаблоны с 2–18
 * вариантами (филамент по цветам, кабель LEADER красный/чёрный): у каждого варианта свой
 * `default_code`, свой остаток и цены, все коды есть в каталоге GraphQL. Суммировать нельзя
 * (у кабелей остаток вариантов совпадает — сумма его удвоит), брать один — теряются остальные коды.
 *
 * ⚠️ Остаток не числом (null, строка, RSC-ссылка "$…") — СБОЙ всей карточки, а не 0:
 * ноль по всем товарам записал бы продажу всего склада одним проходом.
 */
export function parseCard(mainProduct) {
  const tpl = mainProduct?.ProductProduct?.[0];
  const vars = tpl?.product_variant_ids;
  if (!tpl || !Array.isArray(vars) || !vars.length) return null;
  const out = [];
  for (const v of vars) {
    if (!v || typeof v !== 'object') return null;
    const qty = num(v.qty_available);
    if (qty === null) return null;
    const code = String(v.default_code || (vars.length === 1 ? tpl.default_code : '') || '').trim();
    if (!code) return null;
    // display_name варианта: «[10009161] Кабель … (Червоний)» — без кода в скобках.
    const vName = String(v.display_name || '').replace(/^\[[^\]]*\]\s*/, '');
    out.push({
      code,
      name: vars.length > 1 ? (vName || tpl.name || '') : (tpl.name || vName),
      qty,
      qtyVirtual: num(v.virtual_available),
      incoming: num(v.incoming_qty),
      priceRetail: num(v.price_retail),
      priceVip: num(v.price_vip),
      pricePartner: num(v.price_partner),
      // «08.08.2026» → дата ближайшего прихода; false, когда прихода не ждут
      incomingDate: typeof v.last_receipt_scheduled_date === 'string' ? v.last_receipt_scheduled_date : null,
    });
  }
  return out;
}

/**
 * Полный обход каталога. На каждую карточку до 3 попыток; не отдавшая товар — `failures`
 * (не ответила / 404) или `empty` (200, но объекта товара в странице нет).
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

  log(`▸ обход карточек, потоков ${conc} …`);

  const items = [];
  let done = 0, failures = 0, empty = 0, multi = 0, dup = 0;
  let idx = 0;
  const seen = new Set();

  const one = async (slug) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let status = 0, txt = '';
      try {
        const r = await fetch(`${HOST}/shop/${slug}`, { headers: H });
        status = r.status;
        txt = await r.text();
      } catch { /* сеть — уходим в ретрай */ }

      if (status === 200 && txt) {
        const parsed = parseCard(extractMainProduct(txt));
        if (parsed) return parsed;
        // 200 без объекта товара — вёрстка поменялась либо отдали заглушку
        if (attempt === 3) { empty++; return null; }
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
      const vars = await one(slug);
      done++;
      if (done % 200 === 0) log(`  ${done}/${slugs.length} … ${((Date.now() - t0) / 1000) | 0}с`);
      if (!vars) continue;
      if (vars.length > 1) multi++;
      for (const it of vars) {
      // Один код мог прийти с двух карточек (sitemap с языковыми/старыми slug) — берём первый.
      if (seen.has(it.code)) { dup++; continue; }
      seen.add(it.code);
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
        qty: it.qty,
        qtyVirtual: it.qtyVirtual,
        incoming: it.incoming,
        incomingDate: it.incomingDate,
      });
      }
    }
  }));

  const sec = ((Date.now() - t0) / 1000) | 0;
  if (failures) log(`  ⚠️ карточек не удалось получить: ${failures}`);
  if (empty) log(`  ⚠️ карточек с пустым ответом (устаревший slug): ${empty}`);
  if (multi) log(`  ℹ️ карточек с несколькими вариантами: ${multi} — каждый вариант пишется своим кодом`);
  if (dup) log(`  ℹ️ повторов кода с разных карточек: ${dup} — взят первый`);
  log(`  готово: ${items.length} товаров с ${slugs.length} карточек за ${sec}с (${(slugs.length / Math.max(sec, 1)).toFixed(2)} карт/с)`);

  // Ни одна карточка не разобралась — падаем громко (письмо от GitHub), а не пишем пустой проход.
  // Больше сетевых сбоев, чем пустых страниц — это сеть (слово «network» включает разовый
  // повтор в site-retry.mjs); иначе сайт ответил, а разбор не сработал — поменялась вёрстка.
  if (!items.length) {
    if (failures > empty) throw new Error(`network: ни одна из ${slugs.length} карточек не ответила (сбоев ${failures})`);
    throw new Error(`ни одна из ${slugs.length} карточек не разобрана (без объекта товара ${empty}, сбоев ${failures}) — вёрстка сайта поменялась`);
  }
  return { items, catalog, requests: slugs.length, failures, empty, multi, sec };
}
