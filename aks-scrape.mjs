// Скрап раздела ЗАПЧАСТЕЙ aks.ua: цена + «є/немає». Количеств сайт не отдаёт.
//
// Разбор сайта и все замеры — `Prices/docs/sites_nalichie.md`, раздел «aks.ua».
//
// ⚠️ aks.ua — большой магазин электроники (телевизоры, аудио, ноутбуки), и обходить его
// целиком незачем: в sitemap ~600 тыс. ссылок, из которых нам нужен ОДИН раздел.
// Поэтому список категорий — жёсткий белый список ниже, а не обход всего каталога.
//
// Запуск отдельно не предусмотрен — проба через `node aks-run.mjs --dry --cats 2`.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BASE = 'https://www.aks.ua/uk/catalog/';

/**
 * 42 категории раздела запчастей.
 *
 * Откуда взяты: `sitemap.xml` → группа `sitemap_1607_{1,2,3}_uk.xml` (в ней лежит именно
 * раздел запчастей), первый сегмент пути после `/catalog/`, уникальные значения.
 * Обновить список: скачать эти три файла и повторить выборку.
 *
 * ⚠️ Пары вроде `displei-ekran` / `displei-ekrany` и `sensornaya-panel` / `sensornaya-paneli` —
 * это РАЗНЫЕ категории сайта с похожими слагами, а не опечатка. Товары между категориями
 * пересекаются, поэтому дедуп по коду обязателен (см. scrapeAks).
 */
export const ROOTS = [
  'antennye-moduli', 'derzhateli-kart-pamyati-i-sim', 'derzhateli-sim-kart-dlya-planshetov',
  'dinamiki', 'dinamiki-dlya-planshetov', 'dinamiki-dlya-umnyh-chasov',
  'displei-dlya-umnyh-chasov', 'displei-ekran', 'displei-ekrany',
  'kamery', 'kamery-dlya-planshetov', 'kolpachki-na-knopku-vkl-vykl',
  'komplektuyushie-dlya-planshetnyh-pk', 'komplektuyushie-dlya-umnyh-chasov',
  'komplektuyushie-k-mobilnym-telefonam', 'komplektuyushie-k-mobilnym-ustroistvam',
  'korpus-na-mobilnuy-telefon', 'korpusa-dlya-umnyh-chasov', 'korpusa-planshetov',
  'licevaya-panel', 'melkie-komplektuyushie-dlya-planshetov', 'melkie-korpusnye-chasti',
  'mikrofony-microphones', 'mikroshemy-i-kontrollery-dlya-telefonov', 'razyomy',
  'sensora-dlya-umnyh-chasov', 'sensornaya-panel', 'sensornaya-paneli',
  'shleif', 'shleify-dlya-umnyh-chasov', 'shleify1', 'shleyfi-dinamiki-k-mobilnym-telefonam',
  'shurupy', 'stekla-displeya-dlya-umnyh-chasov', 'stekla-kamery', 'steklo',
  'steklo-displeya-dlya-planshetov', 'stikery-dlya-telefonov-dvuhstoronnii-skotch',
  'vibromotory', 'vibromotory-dlya-umnyh-chasov', 'zadnie-kryshki',
  'zapchasti-k-mobilnym-ustroistvam',
];

// ⚠️ Потолок сайта ~6–7 стр/с: conc 5 → 4.9 стр/с при медиане 853 мс, conc 10 → 6.2 стр/с,
// но медиана удваивается до 1398 мс. Берём 5. Прогон недельный, гнаться незачем, а страница
// весит ~360 КБ — сайт НЕ отдаёт сжатие вовсе (заголовка content-encoding нет).
const CONC = 5;

// Предохранитель от зацикленной пагинации. Самая большая категория (дисплеї) — 303 страницы.
const MAX_PAGES = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** «1 549 грн» / «1549 грн» → 1549. Пусто или 0 → null (нет цены). */
function money(s) {
  const n = Number(String(s || '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const decode = (s) => String(s || '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

/**
 * Разбор страницы листинга.
 *
 * ⚠️ НАЛИЧИЕ ОПРЕДЕЛЯЕТСЯ КЛАССОМ `catalog-item-box inactive`, а НЕ текстом карточки.
 * Слово «немає» на странице встречается в другом контексте (фильтры, подсказки), и поиск
 * по нему даёт неверный ответ — на этом я споткнулся при разборе и решил, что наличия
 * в листинге вообще не видно. У живого товара класс `catalog-item-box` и кнопка
 * `add-to-cart`, у отсутствующего — `inactive` и кнопки нет.
 *
 * ⚠️ Число товаров в категории брать из ПАГИНАЦИИ (`data-page-num`), а НЕ из текста
 * «В асортименті 11678 товарів» — это рекламная строка в `meta description`, а не счётчик.
 */
export function parseListing(html, category) {
  const items = [];
  const chunks = html.split('<div class="catalog-item">').slice(1);
  for (const c of chunks) {
    const id = (c.match(/\/item\/view\/(\d+)/) || [])[1];
    if (!id) continue;
    const name = decode((c.match(/<div class="catalog-name">\s*<a[^>]*title="([^"]*)"/) || [])[1]);
    items.push({
      code: id,
      name,
      category,
      price: money((c.match(/catalog-price-new">([^<]*)/) || [])[1]),
      oldPrice: money((c.match(/old-price__value">([^<]*)/) || [])[1]),
      inStock: /class="catalog-item-box[^"]*\binactive\b/.test(c) ? 0 : 1,
      url: `https://www.aks.ua/uk/item/view/${id}/`,
    });
  }
  // Последняя страница пагинации — ориентир по объёму категории.
  let lastPage = 1;
  for (const m of html.matchAll(/data-page-num="(\d+)"/g)) lastPage = Math.max(lastPage, +m[1]);
  return { items, lastPage };
}

/** Одна страница с ретраями. «Пусто» и «сбой» различаются — см. комментарий в scrapeAks. */
async function fetchPage(cat, n, tries = 3) {
  const url = n === 1 ? `${BASE}${cat}/` : `${BASE}${cat}/page/${n}/`;
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'uk' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text();
      const { items, lastPage } = parseListing(html, cat);
      return { ok: true, n, items, lastPage, bytes: html.length };
    } catch (e) {
      if (a === tries) return { ok: false, n, items: [], lastPage: 1, bytes: 0, err: String(e.message || e) };
      await sleep(500 * a);
    }
  }
}

/**
 * Обход всех категорий белого списка.
 *
 * @param {object}   o
 * @param {Function} o.log       куда писать прогресс
 * @param {number}   o.conc      потоков (по умолчанию 5)
 * @param {number}   o.limitCats ограничить N категориями (для проб)
 */
export async function scrapeAks({ log = () => {}, conc = CONC, limitCats = 0 } = {}) {
  const t0 = Date.now();
  const byCode = new Map();
  let requests = 0, failures = 0, pages = 0, bytes = 0, expected = 0;
  const cats = limitCats ? ROOTS.slice(0, limitCats) : ROOTS;

  for (const cat of cats) {
    const first = await fetchPage(cat, 1);
    requests++;
    if (!first.ok) { failures++; log(`  ⚠️ ${cat}: первая страница не открылась (${first.err})`); continue; }
    pages++; bytes += first.bytes;
    for (const it of first.items) if (!byCode.has(it.code)) byCode.set(it.code, it);

    const last = Math.min(first.lastPage, MAX_PAGES);
    expected += last;               // ориентир: страниц по мнению пагинации
    let stopped = false;

    for (let p = 2; p <= last && !stopped;) {
      const batch = [];
      for (let i = 0; i < conc && p + i <= last; i++) batch.push(p + i);
      const res = await Promise.all(batch.map((n) => fetchPage(cat, n)));
      requests += batch.length;
      for (const r of res) {
        if (!r.ok) { failures++; continue; }
        pages++; bytes += r.bytes;
        // ⚠️ Пустая страница = конец категории; сбой сети — НЕ конец. Спутать их значит
        // оборвать обход на первой же ошибке и записать половину каталога как полный проход.
        if (!r.items.length) { stopped = true; continue; }
        for (const it of r.items) if (!byCode.has(it.code)) byCode.set(it.code, it);
      }
      p += batch.length;
    }
    log(`  ${cat}: стр. ${last}, всего товаров ${byCode.size}`);
  }

  const items = [...byCode.values()];
  const sec = Math.round((Date.now() - t0) / 1000);
  const inStock = items.filter((i) => i.inStock).length;
  log(`▸ скрап: ${items.length} товаров (в наличии ${inStock}) с ${pages} страниц`
    + ` за ${sec}с, запросов ${requests}, сбоев ${failures}, скачано ${(bytes / 1048576) | 0} МБ`);

  return { items, pages, expectedPages: expected, requests, failures, sec, inStock, mb: (bytes / 1048576) | 0 };
}
