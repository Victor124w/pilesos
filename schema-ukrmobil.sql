-- Схема D1 для парсинга ukr-mobil.com. Повторяет kspace (schema-kspace.sql), отличия:
--   * ТРИ цены вместо одной: розничная / VIP / партнёрская (оптовая). Это единственный
--     из проверенных сайтов, который показывает опт анониму — ради этого он и интересен;
--   * помимо остатка есть qty_virtual (с учётом резервов и ожидаемых приходов),
--     incoming (сколько в пути) и incoming_date (дата ближайшего прихода);
--   * категория — готовый путь из Odoo («Все для ремонту дисплеїв / Скло дисплея / iPhone»),
--     151 штука; берётся из GraphQL, а не из обхода разделов;
--   * ключ — default_code (артикул Odoo): уникален, есть у 1834 из 1834.
--     Вариантов у товаров нет (замер: 29 из 29 — ровно один), поэтому код варианта = код товара.
-- Применять: wrangler d1 execute prices_db --remote --file schema-ukrmobil.sql

CREATE TABLE IF NOT EXISTS ukrmobil_products (
  code          TEXT PRIMARY KEY,     -- default_code (артикул Odoo)
  name          TEXT NOT NULL,
  url           TEXT,
  category      TEXT,                 -- путь категории из Odoo, через « / »
  price_retail  REAL,                 -- грн, розничная
  price_vip     REAL,                 -- грн, VIP
  price_partner REAL,                 -- грн, партнёрская (оптовая)
  qty           INTEGER NOT NULL DEFAULT 0,   -- qty_available, целый (дробных в каталоге нет)
  qty_virtual   INTEGER,              -- virtual_available: с учётом резервов и приходов
  incoming      INTEGER,              -- incoming_qty: в пути
  incoming_date TEXT,                 -- ДД.ММ.ГГГГ ближайшего прихода, NULL если не ждут
  first_seen    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ukrmobil_products_cat ON ukrmobil_products (category);

-- Журнал движений остатка: строка ТОЛЬКО когда qty изменился.
-- Цены пишем все три — по партнёрской считается оборот в оптовых деньгах.
CREATE TABLE IF NOT EXISTS ukrmobil_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  code          TEXT NOT NULL,
  name          TEXT,                 -- денормализовано: отчёты строятся без join
  category      TEXT,
  qty_before    INTEGER NOT NULL,
  qty_after     INTEGER NOT NULL,
  delta         INTEGER NOT NULL,
  kind          TEXT NOT NULL,        -- 'sale' (delta<0) | 'arrival' (delta>0)
  price_retail  REAL,
  price_partner REAL
);
CREATE INDEX IF NOT EXISTS idx_ukrmobil_moves_ts   ON ukrmobil_moves (ts);
CREATE INDEX IF NOT EXISTS idx_ukrmobil_moves_code ON ukrmobil_moves (code);
CREATE INDEX IF NOT EXISTS idx_ukrmobil_moves_cat  ON ukrmobil_moves (category, ts);

-- Лог проходов парсера (кнопка «📡 Статус парсинга»).
CREATE TABLE IF NOT EXISTS ukrmobil_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  pages        INTEGER,             -- карточек запрошено
  products     INTEGER,             -- товаров получено
  changed      INTEGER,             -- сколько остатков изменилось
  sales_qty    INTEGER,
  arrivals_qty INTEGER,
  empty_pages  INTEGER DEFAULT 0,   -- карточек не удалось получить (>0 = проход неполный)
  missing      INTEGER DEFAULT 0,   -- кодов из базы не встретилось в проходе
  ok           INTEGER DEFAULT 0
);

-- Снимки остатков утро/вечер — для «Разницы реал. сканов» и «Светофора».
CREATE TABLE IF NOT EXISTS ukrmobil_snap (
  day  TEXT    NOT NULL,   -- YYYY-MM-DD (Киев)
  kind TEXT    NOT NULL,   -- 'morning' | 'evening'
  ts   INTEGER NOT NULL,
  data TEXT    NOT NULL,   -- JSON {code: qty}
  PRIMARY KEY (day, kind)
);
