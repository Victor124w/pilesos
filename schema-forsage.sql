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
  -- ⚠️ ДОЛЛАР ПЕРВИЧЕН: базовая валюта магазина — USD (`currency.base_currency_code`),
  -- гривна витринная и считается по курсу (45.2 на 08.08): 23.5 $ × 45.2 = 1062.20 грн ровно.
  -- Скрап идёт с заголовком `Content-Currency: USD`, гривна вычисляется в парсере.
  -- Владелец сравнивает с нашей номенклатурой в $ (iCracked_SKU кол. K), поэтому доллар нужен.
  price_retail_usd  REAL,           -- $, розничная
  price_partner_usd REAL,           -- $, партнёрская = цена кабинета
  price_retail  REAL,               -- грн, = price_retail_usd × курс
  price_partner REAL,               -- грн, = price_partner_usd × курс
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
  -- ⚠️ Цены здесь в ДОЛЛАРАХ. Гривну писать нельзя: при смене курса все гривневые цены
  -- сдвинулись бы разом и дали 43 тысячи ложных «изменений». В долларе такого не бывает.
  old_val   REAL,
  new_val   REAL
);
CREATE INDEX IF NOT EXISTS idx_forsage_changes_ts    ON forsage_changes (ts);
CREATE INDEX IF NOT EXISTS idx_forsage_changes_code  ON forsage_changes (code);
CREATE INDEX IF NOT EXISTS idx_forsage_changes_field ON forsage_changes (field, ts);

-- Пропавшие коды: те, что есть в `forsage_products`, но не встретились в проходе.
-- ⚠️ Разовое отсутствие ничего не значит — Magento сам отдаёт то полный каталог, то на сотню
-- позиций меньше при нулевых сбоях запросов (10.08: 0 → 853 → 1 за соседние часы). Смысл
-- имеет только СЕРИЯ: строка живёт, пока код отсутствует, встретился снова — удаляется.
-- Почему не `last_seen` в `forsage_products`: «видели» на каждый товар в каждом проходе —
-- это 43 000 записей в час вместо нынешних десятков. Пишем пропавших, их единицы-сотни.
-- Отдельным файлом эта же таблица лежит в migrate-forsage-missing.sql (применена 2026-08-10).
CREATE TABLE IF NOT EXISTS forsage_missing (
  code           TEXT PRIMARY KEY,
  name           TEXT,                  -- денормализовано: отчёты строятся без join
  category       TEXT,
  first_missing  INTEGER NOT NULL,      -- начало ТЕКУЩЕЙ серии отсутствия
  last_missing   INTEGER NOT NULL,
  misses         INTEGER NOT NULL DEFAULT 1  -- проходов подряд без него
);
CREATE INDEX IF NOT EXISTS idx_forsage_missing_misses ON forsage_missing (misses);

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
