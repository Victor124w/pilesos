// Ядро парсера каталога m112.com.ua.
// Работает в Node (GitHub Actions и локально). Без внешних зависимостей.
// Отдаёт массив уникальных товаров: {product_id,name,url,top_section,section_name,brand,price,q_*,q_total}

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 11 верхних разделов каталога — агрегируют всех потомков, покрывают весь каталог.
export const ROOTS = [
  { slug: 'powerbank-puskovi-prstroi',              name: 'Power bank / Пускові пристрої' },
  { slug: 'zaryadni-stantsii-ecoflow',              name: 'Зарядні станції EcoFlow' },
  { slug: 'akumulyatori',                           name: 'Акумулятори' },
  { slug: 'aksesuari-kabeli-zaryadki',              name: 'Аксесуари / Кабелі / Зарядки' },
  { slug: 'displei',                                name: 'Дисплеї' },
  { slug: 'zakhisne-sklo',                          name: 'Захисне скло' },
  { slug: 'korpusni-zapchastini',                   name: 'Корпусні запчастини' },
  { slug: 'dribni-zapchastini',                     name: 'Дрібні запчастини' },
  { slug: 'tachskrini',                             name: 'Тачскріни' },
  { slug: 'shleyfa-nizhni-plati-koaksialni-kabeli', name: 'Шлейфи / Нижні плати / Коаксіальні кабелі' },
  { slug: 'vitratniki-obladnannya-instrument',      name: 'Витратники / Обладнання / Інструмент' },
];

const CITY_MAP = {
  'Дніпро': 'q_dnepr', 'Днепр': 'q_dnepr',
  'Київ': 'q_kiev', 'Киев': 'q_kiev',
  'Одеса': 'q_odesa', 'Одесса': 'q_odesa',
  'Львів': 'q_lvov', 'Львов': 'q_lvov',
};

// Бренд/модель из названия (второй уровень группировки). Порядок = приоритет.
const BRANDS = [
  [/\biphone\b/i, 'Apple iPhone'], [/\bipad\b/i, 'Apple iPad'],
  [/apple\s*watch|\bwatch\b/i, 'Apple Watch'], [/\bmacbook\b|mi[- ]?book/i, 'Apple MacBook'],
  [/\bairpods\b/i, 'Apple AirPods'], [/\bapple\b/i, 'Apple'],
  [/\bredmi\b/i, 'Xiaomi Redmi'], [/\bpoco\b/i, 'Xiaomi Poco'], [/xiaomi|\bmi\b/i, 'Xiaomi'],
  [/\bhonor\b/i, 'Honor'], [/huawei/i, 'Huawei'],
  [/samsung|galaxy/i, 'Samsung'],
  [/realme/i, 'Realme'], [/oneplus|one\s*plus/i, 'OnePlus'], [/oppo/i, 'Oppo'],
  [/\bvivo\b/i, 'Vivo'], [/motorola|\bmoto\b/i, 'Motorola'], [/nokia/i, 'Nokia'],
  [/lenovo/i, 'Lenovo'], [/\blg\b/i, 'LG'], [/sony|xperia/i, 'Sony'], [/meizu/i, 'Meizu'],
  [/\bzte\b/i, 'ZTE'], [/tecno/i, 'Tecno'], [/infinix/i, 'Infinix'], [/nothing/i, 'Nothing'],
  [/google|pixel/i, 'Google'], [/asus|zenfone/i, 'Asus'], [/\btcl\b/i, 'TCL'],
  [/blackview|oscal/i, 'Blackview'], [/doogee/i, 'Doogee'], [/oukitel/i, 'Oukitel'],
  [/ulefone/i, 'Ulefone'], [/prestigio/i, 'Prestigio'], [/\bnomi\b/i, 'Nomi'],
  [/sigma/i, 'Sigma'], [/bravis/i, 'Bravis'], [/\bergo\b/i, 'Ergo'], [/\bfly\b/i, 'Fly'],
  [/\bhtc\b/i, 'HTC'], [/cubot/i, 'Cubot'], [/umidigi/i, 'Umidigi'], [/leagoo/i, 'Leagoo'],
  [/homtom/i, 'Homtom'], [/leeco/i, 'LeEco'], [/baseus/i, 'Baseus'], [/ecoflow/i, 'EcoFlow'],
];

export function extractBrand(name) {
  for (const [re, label] of BRANDS) if (re.test(name)) return label;
  return 'Інше';
}

// Парсинг одной страницы листинга → массив товаров
export function parseItems(html) {
  const blocks = html.split('<div class="itemRow item"').slice(1);
  const out = [];
  for (const b of blocks) {
    const id = (b.match(/data-product-id="(\d+)"/) || [])[1];
    if (!id) continue;
    const name = decodeEnt(((b.match(/class="name">([^<]*)</) || [])[1] || '').trim());
    if (!name) continue;
    const url = (b.match(/href="(https?:\/\/m112\.com\.ua\/item\/[^"]+)"/) || [])[1] || '';
    const priceRaw = ((b.match(/class="price">([^<]*)</) || [])[1] || '').replace(/&nbsp;|\s|грн\.?/gi, '');
    const priceNum = priceRaw ? parseFloat(priceRaw.replace(',', '.')) : null;
    const price = Number.isFinite(priceNum) ? priceNum : null;
    const q = { q_dnepr: 0, q_kiev: 0, q_odesa: 0, q_lvov: 0, q_partner: 0 };
    for (const m of b.matchAll(/aviable_link[^>]*>([^<]+)</g)) {
      const t = decodeEnt(m[1].trim());
      const qm = t.match(/^(.*?)\s*(\d+)\s*$/);
      if (!qm) continue;
      const city = qm[1].trim(), qty = parseInt(qm[2], 10);
      const col = CITY_MAP[city];
      if (col) q[col] += qty; else q.q_partner += qty; // партнерський/иные склады
    }
    const q_total = q.q_dnepr + q.q_kiev + q.q_odesa + q.q_lvov + q.q_partner;
    out.push({ product_id: id, name, url, price, ...q, q_total, brand: extractBrand(name) });
  }
  return out;
}

function decodeEnt(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Последняя страница раздела = max PAGEN_1 в ссылках
function lastPage(html) {
  const ns = [...html.matchAll(/PAGEN_1=(\d+)/g)].map(m => +m[1]);
  return ns.length ? Math.max(...ns) : ((html.includes('itemRow item')) ? 1 : 0);
}

async function getPage(slug, page, { delay, log }) {
  const url = page === 1
    ? `https://m112.com.ua/${slug}/`
    : `https://m112.com.ua/${slug}/?PAGEN_1=${page}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      const html = await r.text();
      if (html.includes('itemRow item') || lastPage(html) === 0) return html;
    } catch (e) { if (log) log(`  fetch err ${slug} p${page}: ${e.message}`); }
    await sleep(delay * (attempt + 2)); // backoff при пустом/ошибке (троттлинг сайта)
  }
  return '';
}

// Обход одного раздела: страницы качаются пулом по `concurrency` (по умолч. 2 — мягче к сайту).
// Возвращает {items, pages, failed, collapsed}: failed = страниц не отдалось после повтора,
// collapsed = 1 если раздел так и не раскачался (стр1 без товаров — троттлинг/софт-блок).
export async function scrapeRoot(root, opts = {}) {
  const { delay = 200, concurrency = 2, log = null } = opts;

  // Страница 1 критична. Корневые разделы каталога пустыми НЕ бывают — если товаров 0,
  // это троттлинг/софт-блок (страница может вернуться непустой, но без товаров): тянем
  // упорно с растущей паузой, пока не появятся товары.
  let p1 = '', last = 1, items = [];
  for (let a = 0; a < 6; a++) {
    p1 = await getPage(root.slug, 1, { delay, log });
    items = parseItems(p1).map(tag(root));
    last = lastPage(p1) || 1;
    if (items.length > 0) break;
    if (log) log(`  ⚠ ${root.slug}: стр1 без товаров (троттлинг?) — повтор ${a + 1}/6`);
    await sleep(delay * (a + 3) * 3);
  }
  const collapsed = items.length === 0 ? 1 : 0; // раздел так и не раскачался

  const rest = [];
  for (let p = 2; p <= last; p++) rest.push(p);
  let idx = 0, done = 1;
  const collected = [];
  const failed = [];
  const worker = async () => {
    while (idx < rest.length) {
      const p = rest[idx++];
      const html = await getPage(root.slug, p, { delay, log });
      if (!html) failed.push(p);                       // не отдалась после ретраев
      else collected.push(...parseItems(html).map(tag(root)));
      done++;
      if (log && done % 40 === 0) log(`  ${root.slug}: стр ${done}/${last}`);
      await sleep(delay);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rest.length || 1) }, worker));

  // Второй проход по выпавшим страницам — медленно, последовательно.
  let stillFailed = 0;
  if (failed.length) {
    if (log) log(`  ⚠ ${root.slug}: ${failed.length} стр не отдались — повтор медленно…`);
    for (const p of failed) {
      await sleep(delay * 4);
      const html = await getPage(root.slug, p, { delay: delay * 2, log });
      if (html) collected.push(...parseItems(html).map(tag(root)));
      else stillFailed++;
    }
  }
  return { items: items.concat(collected), pages: last, failed: stillFailed, collapsed };
}

const tag = root => it => ({ ...it, top_section: root.slug, section_name: root.name });

// Полный обход каталога с дедупликацией по product_id (первое вхождение выигрывает)
export async function scrapeCatalog(opts = {}) {
  const { roots = ROOTS, delay = 200, concurrency = 2, log = console.error } = opts;
  const byId = new Map();
  let pages = 0, failed = 0;
  const collapsedRoots = [];
  const add = (items) => { for (const it of items) if (!byId.has(it.product_id)) byId.set(it.product_id, it); };

  for (const root of roots) {
    if (log) log(`▶ ${root.slug} …`);
    const r = await scrapeRoot(root, { delay, concurrency, log });
    pages += r.pages; failed += r.failed;
    if (r.collapsed) collapsedRoots.push(root);
    add(r.items);
    if (log) log(`  ✓ ${root.slug}: ${r.pages} стр, +${r.items.length} (уник всего ${byId.size})${r.failed ? ` ⚠ выпало ${r.failed}` : ''}${r.collapsed ? ' ⚠ СХЛОПНУЛСЯ' : ''}`);
  }

  // Повтор схлопнувшихся разделов — очень медленно (concurrency 1), чтобы сайт отпустил.
  let collapsed = 0;
  for (const root of collapsedRoots) {
    if (log) log(`↻ повтор схлопнувшегося ${root.slug} медленно…`);
    await sleep(delay * 15);
    const r = await scrapeRoot(root, { delay: delay * 3, concurrency: 1, log });
    pages += r.pages; failed += r.failed;
    const before = byId.size; add(r.items);
    if (r.collapsed) collapsed++;
    if (log) log(`  ↻ ${root.slug}: +${byId.size - before}${r.collapsed ? ' ⚠ ВСЁ ЕЩЁ СХЛОПНУТ' : ' ✓'}`);
  }

  return { products: [...byId.values()], pages, failed, collapsed };
}
