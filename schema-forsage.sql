-- Схема D1 для парсинга цен gsm-forsage.com.ua.
--
-- ⚠️ ЭТО ПАРСЕР ПОСТАВЩИКА, А НЕ КОНКУРЕНТА. Остальные четыре (m112/ekran/kspace/ukrmobil)
-- считают чужие ПРОДАЖИ по движению остатков — там таблица `*_moves` с дельтами штук.
-- Здесь смысл другой: следить за ЦЕНОЙ ЗАКУПКИ. Поэтому:
--   * вместо движений остатка — история изменений полей (`forsage_changes`), как у прайсов
--     из Google-таблиц в таблице `changes`;
--   * количества нет вообще: сайт его не отдаёт (проверено дважды, см. docs/sites_nalichie.md),
--     есть только «є/немає» → `in_stock` 1/0;
--   * ДВЕ цены: розничная и партнёрская (кабинет). Партнёрская — то, ради чего всё затевалось.
--
-- Источник — Magento GraphQL под токеном покупателя. Подтверждено 2026-08-08: под
-- `Authorization: Bearer` приходят цены кабинета (3 из 3 сошлись точно).
-- Применять: wrangler d1 execute prices_db --remote --file schema-forsage.sql

CREATE TABLE IF NOT EXISTS forsage_products (
  code          TEXT PRIMARY KEY,   -- sku Magento, «CB-00000323» / «00-00002506»
  name          TEXT NOT NULL,
  category      TEXT,               -- имя категории-листа, где товар встретился первым
  price_retail  REAL,               -- грн, розничная (regular_price)
  price_partner REAL,               -- грн, партнёрская = цена кабинета (final_price под токеном)
  in_stock      INTEGER NOT NULL DEFAULT 0,  -- 1 = IN_STOCK, 0 = OUT_OF_STOCK (общее по сайту)
  -- ⚠️ Заведена ЗАРАНЕЕ и пока НЕ заполняется. Наличие по 10 складам (Чернівці ×3,
  -- Івано-Франківськ, Кам'янець, Коломия, Київ Правий/Лівий, Львів, Тернопіль, Термінал)
  -- живёт ТОЛЬКО в HTML списка (`.multiinventory-container .inventory-item.in-stock.<код>`),
  -- в GraphQL его нет. Полный проход за ним = 862 страницы × 1.7 МБ ≈ 1.4 ГБ, то есть
  -- максимум раз в сутки, а не ежечасно. Колонка добавлена сразу, чтобы потом не мигрировать.
  -- Формат, когда дойдут руки: CSV кодов складов, где есть — «kyiv,lviv,ternopil».
  stock_cities  TEXT,
  first_seen    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forsage_products_cat ON forsage_products (category);

-- История изменений: строка ТОЛЬКО когда поле реально изменилось.
-- Одно изменение = одна строка, поэтому у товара со сменой обеих цен строк будет две.
CREATE TABLE IF NOT EXISTS forsage_changes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  code      TEXT NOT NULL,
  name      TEXT,                   -- денормализовано: отчёты строятся без join
  category  TEXT,
  field     TEXT NOT NULL,          -- 'retail' | 'partner' | 'stock'
  old_val   REAL,
  new_val   REAL
);
CREATE INDEX IF NOT EXISTS idx_forsage_changes_ts    ON forsage_changes (ts);
CREATE INDEX IF NOT EXISTS idx_forsage_changes_code  ON forsage_changes (code);
CREATE INDEX IF NOT EXISTS idx_forsage_changes_field ON forsage_changes (field, ts);

-- Лог проходов парсера (кнопка «📡 Статус парсинга»).
CREATE TABLE IF NOT EXISTS forsage_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  requests     INTEGER,             -- запросов к GraphQL
  cats         INTEGER,             -- категорий обойдено
  products     INTEGER,             -- уникальных товаров получено
  changed      INTEGER,             -- сколько полей изменилось
  price_up     INTEGER DEFAULT 0,   -- подорожало (по партнёрской)
  price_down   INTEGER DEFAULT 0,   -- подешевело
  failures     INTEGER DEFAULT 0,   -- запросов не удалось получить
  missing      INTEGER DEFAULT 0,   -- кодов из базы не встретилось в проходе
  authed       INTEGER DEFAULT 0,   -- 1 = проход был под токеном (партнёрские цены реальны)
  ok           INTEGER DEFAULT 0
);
