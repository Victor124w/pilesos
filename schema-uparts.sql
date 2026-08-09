-- Схема D1 для парсинга цен uparts.ua.
--
-- ⚠️ ТИП ПАРСЕРА — КАК У ФОРСАЖА, А НЕ КАК У ЧЕТЫРЁХ ОСТАЛЬНЫХ. m112/ekran/kspace/ukrmobil
-- считают чужие ПРОДАЖИ по движению остатков, и у них есть таблица `*_moves` с дельтами штук.
-- Здесь количеств нет вовсе: сайт их не отдаёт (перепроверено 2026-08-08 семью способами,
-- см. docs/sites_nalichie.md — публичное `quantity` схлопнуто в булев `quantity>0`, реальный
-- остаток за админ-авторизацией). Поэтому:
--   * движений остатка нет — есть история изменений полей (`uparts_changes`);
--   * наличие только «є/немає» → `in_stock` 1/0;
--   * цена ОДНА, розничная. Партнёрские цены у сайта есть («Оптові ціни для партнерів»),
--     но они за логином партнёра — аккаунта нет, решение за владельцем.
--
-- Отличие от Форсажа: там валюта магазина USD и гривна производная, поэтому история цен
-- ведётся в долларах. Тут магазин гривневый и пересчёта нет вовсе — храним грн как есть,
-- курсовых ложных изменений возникнуть неоткуда.
--
-- Применять: wrangler d1 execute prices_db --remote --file schema-uparts.sql

CREATE TABLE IF NOT EXISTS uparts_products (
  code        TEXT PRIMARY KEY,   -- `sku` из JSON-LD: «P2193», «LH30B», «AM-C801K»
  name        TEXT NOT NULL,
  -- ⚠️ Категории в JSON-LD листинга НЕТ. Здесь лежит слаг папки картинки на CDN
  -- (`cdn.uparts.ua/products/<СЛАГ>/<sku>/…`) — на выборке 200 товаров шаблон совпал
  -- 200 из 200. Это папка каталога картинок, а НЕ каноническая категория сайта:
  -- у части разделов два слага, украинский и русский («korpus-dlia-telefoniv» и
  -- «korpus-dlya-telefonov»). Для группировки в отчёте годится, для дерева — нет.
  category    TEXT,
  price       REAL,               -- грн; NULL = «уточнюйте» (в выдаче приходит 0)
  in_stock    INTEGER NOT NULL DEFAULT 0,   -- 1 = InStock, 0 = OutOfStock
  url         TEXT,               -- собран из кода: /products/<code>/ — см. uparts-scrape.mjs
  first_seen  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uparts_products_cat ON uparts_products (category);

-- История изменений: строка ТОЛЬКО когда поле реально изменилось.
CREATE TABLE IF NOT EXISTS uparts_changes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  code      TEXT NOT NULL,
  name      TEXT,                 -- денормализовано: отчёты строятся без join
  category  TEXT,
  field     TEXT NOT NULL,        -- 'price' | 'stock'
  old_val   REAL,
  new_val   REAL
);
CREATE INDEX IF NOT EXISTS idx_uparts_changes_ts    ON uparts_changes (ts);
CREATE INDEX IF NOT EXISTS idx_uparts_changes_code  ON uparts_changes (code);
CREATE INDEX IF NOT EXISTS idx_uparts_changes_field ON uparts_changes (field, ts);

-- Лог проходов парсера (кнопка «📡 Статус парсинга»).
CREATE TABLE IF NOT EXISTS uparts_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  requests     INTEGER,           -- запросов к сайту
  pages        INTEGER,           -- страниц листинга обойдено
  products     INTEGER,           -- уникальных товаров собрано
  -- ⚠️ Независимый счётчик: `offerCount` из того же JSON-LD. Сверка с `products` —
  -- единственный способ поймать молча теряющий товары обход (грабля Форсажа, где две
  -- версии подряд теряли 17% и 5% каталога и обе выглядели рабочими).
  expected     INTEGER,
  changed      INTEGER,           -- сколько полей изменилось
  price_up     INTEGER DEFAULT 0,
  price_down   INTEGER DEFAULT 0,
  stock_chg    INTEGER DEFAULT 0, -- сколько раз поменялось наличие
  failures     INTEGER DEFAULT 0, -- страниц не удалось получить (после 3 попыток)
  missing      INTEGER DEFAULT 0, -- кодов из базы не встретилось в проходе
  ok           INTEGER DEFAULT 0
);
