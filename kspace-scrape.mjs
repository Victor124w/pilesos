// Скрап каталога kspace-parts.com.ua. Разбор сайта и замеры — в Prices/kspace_parsing.md
// (проверено 2026-08-07, ~1100 запросов).
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ ekran И m112:
//   ekran не отдаёт цены в HTML вовсе — там на каждый вариант нужен POST-AJAX (~5300 запросов).
//   Здесь всё проще: страница КАТЕГОРИИ несёт код товара, название, ссылку, цену и точный
//   остаток в атрибуте max поля количества. Карточки качать не нужно (сверка 10 из 10 совпала),
//   AJAX не нужен, вариантов у товаров нет — цвет заведён отдельным товаром со своим кодом.
//   Весь каталог = 6216 товаров за ~389 запросов.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HOST = 'https://kspace-parts.com.ua';

// Шесть верхних разделов каталога. Дублей между ними НЕТ: каждый товар лежит ровно в одном
// (проверено на полном обходе — 6216 товаров, сумма по разделам тоже 6216).
// Родительский раздел содержит все товары своих подкатегорий: 46 подкатегорий-моделей iPhone
// дали ровно те же 1194 кода, что и родитель. Поэтому 170 категорий из меню обходить незачем.
export const ROOTS = [
  '/catalog/displeyi',                      // дисплеи не-Apple брендов
  '/catalog/zapchastini-dlya-apple',        // запчасти iPhone/iPad/Watch + микросхемы + шлейфы JCID
  '/catalog/akumulyatori',                  // АКБ не-Apple брендов
  '/catalog/aksesuari',                     // чехлы, защитные стёкла, зарядки
  '/catalog/inshe',                         // корпуса, шлейфы, инструмент, программаторы
  '/catalog/zapchastini-dlya-planshetiv',
];

const PER_PAGE = 16;      // фиксировано, увеличить нельзя: per_page/limit/size/show=all игнорируются
const BATCH = 3;          // страниц за раз; сервер не масштабируется выше ~5 req/s
const MAX_PAGES = 250;    // потолок на раздел (у самого большого реально 108) — см. про зацикливание

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENT = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', laquo: '«', raquo: '»', '#039': "'", '#39': "'" };
const decode = (s) => s.replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? m);
const clean = (s) => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

async function fetchText(url, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'uk,ru;q=0.9' } });
      if (r.status === 200) return await r.text();
      if (a === tries) return '';
    } catch {
      if (a === tries) return '';
    }
    await sleep(500 * a);
  }
  return '';
}

/**
 * Товары со страницы категории.
 *
 * ⚠️ Остаток — атрибут `max` у input.quantity__input. Это РЕАЛЬНЫЙ остаток, а не лимит корзины:
 * значения некруглые (303, 1596, 481), сверка с замером месячной давности дала правдоподобную
 * динамику (307→303, 142→140, 9→0), за 20 минут между проходами поймана продажа 12→11.
 * Целый, дробных по всему каталогу нет (в отличие от ekran с его метрами плёнки).
 */
export function parseCategory(html, root) {
  const out = [];
  for (const b of html.split('<div class="product">').slice(1)) {
    const chunk = b.slice(0, 6000);
    const code = (chunk.match(/product__code[^<]*<span>(\d+)<\/span>/) || [])[1];
    if (!code) continue;
    const url = (chunk.match(/class="product__name" href="([^"]+)"/) || [])[1] || '';
    const name = clean((chunk.match(/class="product__name"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const qty = Number((chunk.match(/class="quantity__input[^"]*"\s+type="number"\s+min="\d+"\s+max="([\d.]+)"/) || [])[1] ?? 0);
    // Класс .status — производная от остатка (red = 0, yellow = 1..9, без модификатора = 10+).
    // Отдельно не храним, но сравниваем с qty: расхождение = разметка сайта поехала.
    const statusCls = (chunk.match(/<div class="status(?:\s+status--(\w+))?">/) || [])[1] || 'plain';
    const priceBlock = (chunk.match(/<div class="price">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '';
    const priceRaw = (clean(priceBlock).match(/([\d\s ]+(?:[.,]\d+)?)\s*грн/) || [])[1];
    const price = priceRaw ? Number(priceRaw.replace(/[\s ]/g, '').replace(',', '.')) : null;
    out.push({ code, name, url, qty, price, statusCls, section: root });
  }
  return out;
}

// Расхождение класса статуса с остатком — сигнал, что разметка сайта поменялась.
const statusMismatch = (it) =>
  (it.statusCls === 'red' && it.qty > 0) ||
  (it.statusCls === 'yellow' && (it.qty === 0 || it.qty > 9)) ||
  (it.statusCls === 'plain' && it.qty < 10);

/**
 * Полный обход каталога.
 *
 * ⚠️ ГЛАВНАЯ ГРАБЛЯ САЙТА: за последней страницей пагинация ЗАЦИКЛИВАЕТСЯ — ?page=400
 * бесконечно отдаёт последнюю страницу, а не 404 и не пустоту. Критерий «на странице меньше
 * 16 товаров» НЕ работает: если последняя страница ровно 16 (так у «Планшетів»), обход
 * не закончится никогда — на разведке это намотало 402 страницы вместо 4.
 * Останавливаемся ТОЛЬКО по «в батче нет ни одного нового кода», плюс жёсткий потолок MAX_PAGES.
 *
 * ⚠️ Число страниц заранее узнать нельзя: <ul class="pagination"> усечён до 6 даже там,
 * где страниц 75. Идём последовательно.
 */
export async function scrapeKspace({ log = () => {}, roots = ROOTS, batch = BATCH, delay = 150 } = {}) {
  const items = new Map();
  let requests = 0, pages = 0, failures = 0, mismatch = 0;

  for (const root of roots) {
    const before = items.size;
    let page = 1, capped = false;
    for (;;) {
      const nums = Array.from({ length: batch }, (_, i) => page + i);
      const htmls = await Promise.all(nums.map((n) => fetchText(`${HOST}${root}?page=${n}`)));
      requests += nums.length;
      pages += nums.length;

      let fresh = 0;
      for (const html of htmls) {
        if (!html) { failures++; continue; }
        for (const it of parseCategory(html, root)) {
          if (statusMismatch(it)) mismatch++;
          if (!items.has(it.code)) { items.set(it.code, it); fresh++; }
        }
      }
      page += batch;
      if (!fresh) break;                       // единственный надёжный критерий конца
      if (page > MAX_PAGES) { capped = true; break; }
      if (delay) await sleep(delay);
    }
    log(`  ${String(items.size - before).padStart(5)} товаров, ${page - 1} стр${capped ? ' ⚠️ УПЁРЛОСЬ В ПОТОЛОК' : ''}  ${root}`);
    if (capped) log(`  ⚠️ ${root}: достигнут MAX_PAGES=${MAX_PAGES} — проверь, не сломался ли критерий остановки`);
  }

  // Битые запросы — сигнал, что часть каталога недосчитана. Полнота прохода оценивается
  // в боте сравнением с максимумом за неделю (как у m112 и ekran).
  if (failures) log(`  ⚠️ страниц не удалось получить: ${failures}`);
  if (mismatch) log(`  ⚠️ расхождений «класс статуса ↔ остаток»: ${mismatch}`);

  return { items: [...items.values()], requests, pages, failures, mismatch };
}
