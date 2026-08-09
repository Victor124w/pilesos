-- Схема D1 для парсинга цен раздела запчастей aks.ua.
--
-- ⚠️ Тип парсера — как у Форсажа и uparts: цена + «є/немає», количеств сайт не отдаёт
-- (разобрано 2026-08-09, см. docs/sites_nalichie.md: ни data-max, ни степпера, ни разбивки
-- по магазинам — только InStock/OutOfStock в JSON-LD). Значит продажи по нему считать
-- нельзя, таблицы движений нет, есть история изменений полей.
--
-- Отличие от uparts: у товара ДВЕ цены — текущая и «стара ціна» (перечёркнутая).
-- Вторая есть не у всех и означает акцию магазина, а не опт.
--
-- ⏰ Прогон РАЗ В НЕДЕЛЮ (решение владельца 2026-08-09): полный проход ~1700 страниц
-- и ~625 МБ трафика, потому что сайт не отдаёт сжатие вовсе. Раз в 2 часа, как остальные
-- конкуренты, это дало бы 7.5 ГБ в сутки с чужого сервера.
--
-- Применять: wrangler d1 execute prices_db --remote --file schema-aks.sql

CREATE TABLE IF NOT EXISTS aks_products (
  code        TEXT PRIMARY KEY,   -- «Код товару» = числовой id сайта, напр. 446513
  name        TEXT NOT NULL,
  -- Слаг категории, в которой товар встретился ПЕРВЫМ при обходе. Товары пересекаются
  -- между категориями (`displei-ekran` и `displei-ekrany` — разные разделы сайта),
  -- поэтому это «одна из», а не единственная категория товара.
  category    TEXT,
  price       REAL,               -- грн, текущая; NULL = цены нет (бывает у снятых с продажи)
  old_price   REAL,               -- грн, перечёркнутая «стара ціна»; NULL, если акции нет
  in_stock    INTEGER NOT NULL DEFAULT 0,   -- 1 = есть, 0 = немає (класс `inactive` в листинге)
  url         TEXT,
  first_seen  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aks_products_cat ON aks_products (category);

-- История изменений: строка ТОЛЬКО когда поле реально изменилось.
CREATE TABLE IF NOT EXISTS aks_changes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  code      TEXT NOT NULL,
  name      TEXT,                 -- денормализовано: отчёты строятся без join
  category  TEXT,
  field     TEXT NOT NULL,        -- 'price' | 'stock'
  old_val   REAL,
  new_val   REAL
);
CREATE INDEX IF NOT EXISTS idx_aks_changes_ts    ON aks_changes (ts);
CREATE INDEX IF NOT EXISTS idx_aks_changes_code  ON aks_changes (code);
CREATE INDEX IF NOT EXISTS idx_aks_changes_field ON aks_changes (field, ts);

-- Лог проходов парсера (кнопка «📡 Статус парсинга»).
CREATE TABLE IF NOT EXISTS aks_scans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  requests       INTEGER,
  pages          INTEGER,         -- страниц реально обойдено
  -- ⚠️ Независимого счётчика товаров у сайта НЕТ (число в meta description — рекламный
  -- текст, а не счётчик). Поэтому сверяем не товары, а СТРАНИЦЫ: сколько обещала пагинация
  -- против того, сколько удалось пройти. Расхождение = проход неполный.
  expected_pages INTEGER,
  products       INTEGER,
  changed        INTEGER,
  price_up       INTEGER DEFAULT 0,
  price_down     INTEGER DEFAULT 0,
  stock_chg      INTEGER DEFAULT 0,
  failures       INTEGER DEFAULT 0,
  missing        INTEGER DEFAULT 0,   -- кодов из базы не встретилось в проходе
  mb             INTEGER DEFAULT 0,   -- скачано мегабайт (сжатия у сайта нет — цифра крупная)
  ok             INTEGER DEFAULT 0
);
