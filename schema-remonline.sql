-- Схема D1 для отслеживания НАШЕГО склада в RemOnline (RO App) — аналог m112/ukrmobil,
-- только источник не чужой сайт, а API нашей же CRM (склад «Україна», id 59938).
--   * ключ — id товара RemOnline;
--   * остаток бывает ДРОБНЫМ (расходники учитываются не в штуках) → REAL, а не INTEGER;
--   * reserved — резерв под заказы (доступно = qty − reserved);
--   * две цены: B2B (тип цены 163521) и, скорее всего, розница (163520);
--   * category — путь категории без технических корней «_…» («Акумулятори iPhone / Контролер АКБ»),
--     section — верхний значимый уровень («Акумулятори iPhone») для сводок.
-- Движение остатка = любая его смена в RemOnline: продажа, заказ, списание, перемещение,
-- оприходование. Отдельно их API склада не различает — «продано» здесь = «ушло со склада».
-- Применять: wrangler d1 execute prices_db --remote --file schema-remonline.sql

CREATE TABLE IF NOT EXISTS ro_products (
  id            TEXT PRIMARY KEY,     -- id товара в RemOnline
  name          TEXT NOT NULL,
  article       TEXT,
  code          TEXT,
  category      TEXT,                 -- путь категории без корней «_…»
  section       TEXT,                 -- верхний значимый уровень категории
  price_b2b     REAL,                 -- грн, тип цены 163521
  price_retail  REAL,                 -- грн, тип цены 163520
  qty           REAL NOT NULL DEFAULT 0,
  reserved      REAL NOT NULL DEFAULT 0,
  first_seen    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ro_products_section ON ro_products (section);

-- Журнал движений: строка ТОЛЬКО когда qty изменился.
CREATE TABLE IF NOT EXISTS ro_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  product_id    TEXT NOT NULL,
  name          TEXT,                 -- денормализовано: отчёты без join
  category      TEXT,
  section       TEXT,
  qty_before    REAL NOT NULL,
  qty_after     REAL NOT NULL,
  delta         REAL NOT NULL,
  kind          TEXT NOT NULL,        -- 'sale' (delta<0) | 'arrival' (delta>0)
  price_b2b     REAL,
  price_retail  REAL
);
CREATE INDEX IF NOT EXISTS idx_ro_moves_ts      ON ro_moves (ts);
CREATE INDEX IF NOT EXISTS idx_ro_moves_product ON ro_moves (product_id);
CREATE INDEX IF NOT EXISTS idx_ro_moves_section ON ro_moves (section, ts);

-- Лог проходов (кнопка «📡 Статус»).
CREATE TABLE IF NOT EXISTS ro_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  pages        INTEGER,             -- страниц API запрошено
  products     INTEGER,             -- позиций с остатком > 0 получено
  changed      INTEGER,             -- сколько остатков изменилось
  sales_qty    REAL,
  arrivals_qty REAL,
  empty_pages  INTEGER DEFAULT 0,
  missing      INTEGER DEFAULT 0,   -- позиций ушло в 0 (пропали из выдачи ненулевых)
  ok           INTEGER DEFAULT 0
);
