-- Схема D1 для парсинга каталога m112.com.ua (продажи/приходы по часам)
-- Применять: npx wrangler d1 execute prices_db --remote --file scripts/m112/schema-m112.sql

-- Текущий снимок каждого товара (upsert только изменившихся)
CREATE TABLE IF NOT EXISTS m112_products (
  product_id  TEXT PRIMARY KEY,     -- data-product-id с сайта
  name        TEXT NOT NULL,
  url         TEXT,
  top_section TEXT,                 -- верхний раздел (корень каталога), напр. 'displei'
  section_name TEXT,                -- человекочитаемое имя раздела
  brand       TEXT,                 -- бренд/модель из названия (второй уровень)
  price       REAL,
  q_dnepr     INTEGER DEFAULT 0,
  q_kiev      INTEGER DEFAULT 0,
  q_odesa     INTEGER DEFAULT 0,
  q_lvov      INTEGER DEFAULT 0,
  q_partner   INTEGER DEFAULT 0,
  q_total     INTEGER DEFAULT 0,
  first_seen  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_m112_products_section ON m112_products (top_section);
CREATE INDEX IF NOT EXISTS idx_m112_products_brand   ON m112_products (brand);

-- Журнал часовых движений остатка (строка ТОЛЬКО когда q_total изменился)
CREATE TABLE IF NOT EXISTS m112_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,     -- время скана (unix)
  product_id  TEXT NOT NULL,
  name        TEXT,                 -- денормализовано для отчётов без join
  top_section TEXT,
  section_name TEXT,
  brand       TEXT,
  qty_before  INTEGER NOT NULL,
  qty_after   INTEGER NOT NULL,
  delta       INTEGER NOT NULL,     -- qty_after - qty_before
  kind        TEXT NOT NULL,        -- 'sale' (delta<0) | 'arrival' (delta>0)
  price       REAL                  -- цена на момент движения (для выручки)
);
CREATE INDEX IF NOT EXISTS idx_m112_moves_ts       ON m112_moves (ts);
CREATE INDEX IF NOT EXISTS idx_m112_moves_pid      ON m112_moves (product_id);
CREATE INDEX IF NOT EXISTS idx_m112_moves_sec_ts   ON m112_moves (top_section, ts);

-- Лог проходов парсера (для «когда последний скан» в боте)
CREATE TABLE IF NOT EXISTS m112_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  pages        INTEGER,             -- скачано страниц
  products     INTEGER,             -- уникальных товаров в проходе
  changed      INTEGER,             -- сколько остатков изменилось
  sales_qty    INTEGER,             -- суммарно продано за проход
  arrivals_qty INTEGER,             -- суммарно поступило за проход
  empty_pages  INTEGER DEFAULT 0,   -- страниц не отдалось даже после повтора (>0 = троттлинг)
  ok           INTEGER DEFAULT 0    -- 1 = проход без потерь страниц
);

-- Реальные снимки остатков (утро/вечер) для кнопки «Разница реал. сканов»
-- data = JSON {product_id: q_total} всех товаров (компактный блоб, ~350КБ).
CREATE TABLE IF NOT EXISTS m112_snap (
  day  TEXT    NOT NULL,   -- YYYY-MM-DD (Киев)
  kind TEXT    NOT NULL,   -- 'morning' (первый полный скан дня)
  ts   INTEGER NOT NULL,
  data TEXT    NOT NULL,
  PRIMARY KEY (day, kind)
);
