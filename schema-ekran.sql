-- Схема D1 для парсинга ekran.com.ua. Повторяет m112 (schema-m112.sql), отличия:
--   * ключ — offer_id (ID торгового предложения), а не product_id: у ekran на один
--     «товар» приходится до 150 предложений (модель × цвет);
--   * складов нет. Замер на 248 предложениях: второй склад всегда 0, а ID складов
--     СВОИ у каждого предложения — это не склады магазина, а строки учёта.
--     Поэтому одна колонка qty вместо пяти;
--   * qty РЕАЛЬНОЕ (REAL), не INTEGER: плёнка и клей меряются метрами, видели 817.259;
--   * у товаров без вариантов остатка нет вовсе → qty NULL, отслеживаем только цену.
-- Применять: wrangler d1 execute prices_db --remote --file schema-ekran.sql

CREATE TABLE IF NOT EXISTS ekran_products (
  offer_id    TEXT PRIMARY KEY,     -- ID торгового предложения; у простых товаров 'p<product_id>'
  product_id  TEXT NOT NULL,        -- родительский товар (data-product-id)
  name        TEXT NOT NULL,        -- название с комбинацией, напр. '… (11, white)'
  url         TEXT,
  section     TEXT,                 -- раздел каталога (2-й сегмент пути)
  model       TEXT,                 -- свойство VYBERETE_PREDLOZHENIE
  variant     TEXT,                 -- свойство COLOR (цвет/подвариант)
  article     TEXT,                 -- артикул поставщика CML2_ARTICLE
  price       REAL,
  qty         REAL,                 -- NULL у товаров без вариантов (остаток недоступен)
  can_buy     INTEGER DEFAULT 1,    -- CAN_BUY: qty<=0 и can_buy=1 → «под заказ»
  first_seen  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ekran_products_section ON ekran_products (section);
CREATE INDEX IF NOT EXISTS idx_ekran_products_product ON ekran_products (product_id);

-- Журнал движений остатка: строка ТОЛЬКО когда qty изменился.
CREATE TABLE IF NOT EXISTS ekran_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  offer_id    TEXT NOT NULL,
  product_id  TEXT,
  name        TEXT,                 -- денормализовано: отчёты строятся без join
  section     TEXT,
  model       TEXT,
  qty_before  REAL NOT NULL,
  qty_after   REAL NOT NULL,
  delta       REAL NOT NULL,
  kind        TEXT NOT NULL,        -- 'sale' (delta<0) | 'arrival' (delta>0)
  price       REAL                  -- цена на момент движения (для выручки)
);
CREATE INDEX IF NOT EXISTS idx_ekran_moves_ts   ON ekran_moves (ts);
CREATE INDEX IF NOT EXISTS idx_ekran_moves_oid  ON ekran_moves (offer_id);
CREATE INDEX IF NOT EXISTS idx_ekran_moves_sec  ON ekran_moves (section, ts);

-- Лог проходов парсера (кнопка «📡 Статус парсинга»).
CREATE TABLE IF NOT EXISTS ekran_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  pages        INTEGER,             -- страниц категорий в карте
  products     INTEGER,             -- предложений в проходе
  changed      INTEGER,             -- сколько остатков изменилось
  sales_qty    REAL,
  arrivals_qty REAL,
  empty_pages  INTEGER DEFAULT 0,   -- запросов без ответа (>0 = сайт троттлит)
  ok           INTEGER DEFAULT 0
);

-- Снимки остатков утро/вечер — для «Разницы реал. сканов» и «Светофора».
CREATE TABLE IF NOT EXISTS ekran_snap (
  day  TEXT    NOT NULL,   -- YYYY-MM-DD (Киев)
  kind TEXT    NOT NULL,   -- 'morning' | 'evening'
  ts   INTEGER NOT NULL,
  data TEXT    NOT NULL,   -- JSON {offer_id: qty}
  PRIMARY KEY (day, kind)
);
