// Скрап цен gsm-forsage.com.ua через Magento GraphQL. Разбор сайта — docs/sites_nalichie.md.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ ОСТАЛЬНЫХ ЧЕТЫРЁХ ПАРСЕРОВ:
//   Это ПОСТАВЩИК, а не конкурент. Смысл — следить за ценой закупки, а не считать чужие
//   продажи по движению остатков. Количества сайт не отдаёт вовсе (проверено дважды),
//   есть только «є/немає».
//
// ⚠️ ГЛАВНОЕ: под токеном покупателя GraphQL отдаёт ЦЕНЫ КАБИНЕТА.
//   Подтверждено 2026-08-08: 3 из 3 сошлись точно, включая крайний случай
//   (CB-00000006: розница 0.64 $, кабинет 0.15 $). Без токена придут розничные.
//
// Замеры 2026-08-08:
//   * каталог 43 082 товара, 371 категория, 301 из них — листья с товарами;
//   * pageSize сервером ограничен 50 (просишь 500 — вернёт 50), отсюда ~1200 запросов;
//   * `total_count` упирается в 10000 (лимит Elasticsearch), поэтому обходим ПО КАТЕГОРИЯМ:
//     ни один лист не превышает лимит, самый большой — 4770.
//
// env: FORSAGE_EMAIL, FORSAGE_PASSWORD (без них — анонимный проход, только розница)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HOST = 'https://gsm-forsage.com.ua';
const GQL = HOST + '/graphql';

// ⚠️ Accept-Language обязателен: без него GraphQL отдаёт английские названия.
const BASE_H = { 'User-Agent': UA, 'Accept-Language': 'uk,ru;q=0.9', 'Content-Type': 'application/json' };

export const PAGE = 50;   // потолок сервера, больше не отдаёт
export const CONC = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, token, tries = 3) {
  const headers = token ? { ...BASE_H, Authorization: 'Bearer ' + token } : BASE_H;
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(GQL, { method: 'POST', headers, body: JSON.stringify({ query }) });
      const j = await r.json();
      if (j.errors && !j.data) {
        if (a === tries) throw new Error(j.errors[0]?.message || 'GraphQL error');
      } else return j;
    } catch (e) {
      if (a === tries) throw e;
    }
    await sleep(400 * a);
  }
}

/**
 * Токен покупателя. Живёт ~час — на один проход хватает с запасом.
 * ⚠️ Пароль берётся ТОЛЬКО из окружения (GitHub Actions Secrets). В коде его нет и быть не должно.
 */
export async function login(email, password) {
  const q = `mutation{generateCustomerToken(email:${JSON.stringify(email)},password:${JSON.stringify(password)}){token}}`;
  const j = await gql(q, null);
  const token = j?.data?.generateCustomerToken?.token;
  if (!token) throw new Error('Логин не прошёл: ' + (j?.errors?.[0]?.message || 'нет токена'));
  return token;
}

/** Отзываем токен после прохода — чтобы он не жил лишний час. */
export async function logout(token) {
  try { await gql('mutation{revokeCustomerToken{result}}', token, 1); } catch { /* не критично */ }
}

/**
 * Нарезка каталога на диапазоны ЦЕНЫ — так обходим гарантированно ВЕСЬ каталог.
 *
 * ⚠️ Почему не по категориям (первая версия была именно такой и оказалась дырявой):
 * обход 301 категории-листа собрал 35 881 товар из 43 082 — **17% каталога терялось**,
 * потому что часть товаров лежит только в родительских категориях либо вообще без категории.
 * Плюс товар встречается в нескольких листьях, отсюда лишние запросы: 1396 против 909.
 *
 * ⚠️ Фильтр `price` считает в БАЗОВОЙ валюте магазина (доллар), а `final_price.value`
 * возвращается в ГРИВНЕ. Не перепутать: диапазон "0"–"1" это до 1 доллара, а не до гривны.
 *
 * Диапазоны дробим адаптивно: если в нём >= LIMIT товаров, `total_count` упёрся в лимит
 * Elasticsearch и глубже страницы не листаются — значит делим пополам.
 * Границы включительны с двух сторон, поэтому товар на стыке попадёт в два диапазона —
 * это лечится дедупом по sku.
 */
const ES_LIMIT = 10000;
const START_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 2, 3, 5, 8, 12, 20, 35, 60, 100, 200, 500, 1e6];

/**
 * ⚠️ Считать границы НАДО ПОД ТЕМ ЖЕ ТОКЕНОМ, что и выборку. Первый боевой прогон 08.08
 * это доказал: границы считались анонимно (по РОЗНИЧНЫМ ценам), а товары тянулись под
 * токеном (по ПАРТНЁРСКИМ, они ниже). Товары «переехали» в нижние диапазоны, счётчики
 * страниц разошлись с реальностью — собралось 40 942 вместо 43 076, потеряли 5%.
 */
export async function buildPriceBuckets(token, log = () => {}) {
  const out = [];
  const queue = [];
  for (let i = 0; i < START_EDGES.length - 1; i++) queue.push([START_EDGES[i], START_EDGES[i + 1]]);

  while (queue.length) {
    const [from, to] = queue.shift();
    const j = await gql(`{products(filter:{price:{from:"${from}",to:"${to}"}},pageSize:1){total_count}}`, token);
    const n = j?.data?.products?.total_count ?? 0;
    if (!n) continue;
    if (n >= ES_LIMIT && to - from > 0.005) {
      const mid = +((from + to) / 2).toFixed(3);
      log(`  диапазон ${from}–${to} упёрся в лимит (${n}), делю на ${from}–${mid} и ${mid}–${to}`);
      queue.push([from, mid], [mid, to]);
      continue;
    }
    if (n >= ES_LIMIT) log(`  ⚠️ диапазон ${from}–${to} всё ещё ${n} и дробить дальше некуда — часть товаров не попадёт`);
    out.push({ from, to, count: n });
  }
  return out;
}

const PRODUCT_FIELDS = `sku name stock_status categories{name level}
  price_range{minimum_price{regular_price{value} final_price{value}}}`;

// Города заведены категориями, но складам они НЕ соответствуют (проверено: совпало 8 из 40),
// поэтому в поле «категория» их не пишем — иначе товар подпишется «Київ» вместо «Акумулятори».
const CITY_WORDS = ['Чернівці', 'Івано-Франківськ', "Кам'янець", 'Коломия', 'Київ', 'Львів', 'Тернопіль', 'Термінал'];
const isCity = (n) => CITY_WORDS.some((w) => n.includes(w.slice(0, 6)));

// Самая глубокая НЕ-городская категория — она содержательнее корня «ЗАПЧАСТИНИ».
function pickCategory(cats) {
  const ok = (cats || []).filter((c) => c.name && !isCity(c.name));
  if (!ok.length) return null;
  return ok.reduce((best, c) => (Number(c.level) > Number(best.level) ? c : best), ok[0]).name;
}

/**
 * Товары одного диапазона цены со всеми страницами.
 *
 * ⚠️ Под токеном `final_price` = цена кабинета, а `regular_price` ДОЛЖЕН остаться розничным
 * (обычная семантика Magento: regular — до правил, final — после). Проверяется на первом
 * же прогоне: если они совпали у подавляющего большинства, значит розницу надо снимать
 * отдельным анонимным проходом — см. предупреждение в scrapeForsage.
 */
async function fetchBucket(b, token, onFail) {
  const out = [];
  // ⚠️ Идём ДО КОНЦА выдачи, а не по расчётному числу страниц. Расчёт по `count` — только
  // ориентир: если он занижен (цены сдвинулись между подсчётом и обходом), по нему мы
  // остановились бы раньше и молча потеряли товары. Признак конца — короткая страница.
  // Потолок MAX_PAGES = лимит Elasticsearch 10000 / 50, дальше сервер всё равно не отдаст.
  const MAX_PAGES = ES_LIMIT / PAGE;
  for (let p = 1; p <= MAX_PAGES; p++) {
    let j;
    try {
      j = await gql(`{products(filter:{price:{from:"${b.from}",to:"${b.to}"}},pageSize:${PAGE},currentPage:${p}){items{${PRODUCT_FIELDS}}}}`, token);
    } catch (e) { onFail(); continue; }
    const items = j?.data?.products?.items || [];
    for (const it of items) {
      const mp = it.price_range?.minimum_price;
      out.push({
        code: String(it.sku || '').trim(),
        name: it.name || '',
        category: pickCategory(it.categories),
        priceRetail: num(mp?.regular_price?.value),
        pricePartner: num(mp?.final_price?.value),
        inStock: it.stock_status === 'IN_STOCK' ? 1 : 0,
      });
    }
    if (items.length < PAGE) break;   // страницы кончились раньше расчётного
  }
  return out;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Полный проход каталога. Без email/password идёт анонимно — тогда партнёрских цен НЕТ. */
export async function scrapeForsage({ log = () => {}, conc = CONC, limitCats = 0 } = {}) {
  const t0 = Date.now();
  const email = process.env.FORSAGE_EMAIL, password = process.env.FORSAGE_PASSWORD;

  let token = null;
  if (email && password) {
    token = await login(email, password);
    log('▸ вход выполнен, токен получен');
  } else {
    log('⚠️ FORSAGE_EMAIL / FORSAGE_PASSWORD не заданы — проход АНОНИМНЫЙ, партнёрских цен не будет');
  }

  log('▸ нарезаю каталог по диапазонам цены …');
  let cats = await buildPriceBuckets(token, log);
  log(`  диапазонов: ${cats.length}, сумма товаров по ним ${cats.reduce((s, c) => s + c.count, 0)}`);
  if (limitCats) cats = cats.slice(0, limitCats);

  const byCode = new Map();
  let requests = 0, failures = 0, idx = 0, done = 0;

  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) {
      const k = idx++;
      if (k >= cats.length) return;
      const b = cats[k];
      requests += Math.ceil(b.count / PAGE);
      const items = await fetchBucket(b, token, () => failures++);
      for (const it of items) if (it.code && !byCode.has(it.code)) byCode.set(it.code, it);
      done++;
      if (done % 5 === 0) log(`  ${done}/${cats.length} диапазонов, товаров ${byCode.size}, ${((Date.now() - t0) / 1000) | 0}с`);
    }
  }));

  if (token) await logout(token);

  const items = [...byCode.values()];
  // Проверка гипотезы про regular/final: если под токеном они всюду равны — партнёрских цен нет.
  const withGap = items.filter((i) => i.priceRetail != null && i.pricePartner != null && i.pricePartner < i.priceRetail).length;
  const authed = token ? 1 : 0;
  if (token && withGap < items.length * 0.05) {
    log(`⚠️ ВНИМАНИЕ: под токеном партнёрская цена ниже розничной лишь у ${withGap} из ${items.length}.`);
    log('   Значит regular_price НЕ хранит розницу — розницу надо снимать отдельным анонимным проходом.');
  }

  const sec = ((Date.now() - t0) / 1000) | 0;
  if (failures) log(`  ⚠️ запросов не удалось: ${failures}`);
  log(`  готово: ${items.length} товаров, ${cats.length} диапазонов, ~${requests} запросов за ${sec}с`);

  return { items, cats: cats.length, requests, failures, authed, withGap, sec };
}
