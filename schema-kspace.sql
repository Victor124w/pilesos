-- Схема D1 для парсинга kspace-parts.com.ua. Повторяет ekran (schema-ekran.sql), отличия:
--   * ключ — code («Код товару» на сайте): уникален, проверено 6216 из 6216, 4-6 цифр.
--     Вариантов/модификаций у товаров нет — цвет заведён отдельным товаром со своим кодом,
--     поэтому предложений (offer_id), как у ekran, здесь не существует;
--   * qty ЦЕЛЫЙ (INTEGER): дробных остатков по всему каталогу нет;
--   * складов нет — одна колонка qty;
--   * qty=0 — легальное состояние, а не «товар исчез»: половина каталога (3040 из 6216)
--     лежит с нулём и со страницы не пропадает. Решение владельца 2026-08-07:
--     нули храним в снимке (иначе возврат товара в продажу выглядел бы как новая позиция),
--     а в xlsx остатков не выводим.
-- Применять: wrangler d1 execute prices_db --remote --file schema-kspace.sql

CREATE TABLE IF NOT EXISTS kspace_products (
  code        TEXT PRIMARY KEY,     -- «Код товару» с сайта
  name        TEXT NOT NULL,
  url         TEXT,
  section     TEXT,                 -- верхний раздел каталога (один из ROOTS)
  price       REAL,                 -- розничная, грн. (оптовую аноним не видит — решение 07.08)
  qty         INTEGER NOT NULL DEFAULT 0,
  first_seen  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kspace_products_section ON kspace_products (section);

-- Журнал движений остатка: строка ТОЛЬКО когда qty изменился.
CREATE TABLE IF NOT EXISTS kspace_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  code        TEXT NOT NULL,
  name        TEXT,                 -- денормализовано: отчёты строятся без join
  section     TEXT,
  qty_before  INTEGER NOT NULL,
  qty_after   INTEGER NOT NULL,
  delta       INTEGER NOT NULL,
  kind        TEXT NOT NULL,        -- 'sale' (delta<0) | 'arrival' (delta>0)
  price       REAL                  -- цена на момент движения (для выручки)
);
CREATE INDEX IF NOT EXISTS idx_kspace_moves_ts   ON kspace_moves (ts);
CREATE INDEX IF NOT EXISTS idx_kspace_moves_code ON kspace_moves (code);
CREATE INDEX IF NOT EXISTS idx_kspace_moves_sec  ON kspace_moves (section, ts);

-- Лог проходов парсера (кнопка «📡 Статус парсинга»).
CREATE TABLE IF NOT EXISTS kspace_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  pages        INTEGER,             -- страниц запрошено
  products     INTEGER,             -- товаров в проходе
  changed      INTEGER,             -- сколько остатков изменилось
  sales_qty    INTEGER,
  arrivals_qty INTEGER,
  empty_pages  INTEGER DEFAULT 0,   -- страниц не удалось получить (>0 = проход неполный)
  missing      INTEGER DEFAULT 0,   -- кодов из базы не встретилось в проходе
  ok           INTEGER DEFAULT 0
);

-- Снимки остатков утро/вечер — для «Разницы реал. сканов» и «Светофора».
CREATE TABLE IF NOT EXISTS kspace_snap (
  day  TEXT    NOT NULL,   -- YYYY-MM-DD (Киев)
  kind TEXT    NOT NULL,   -- 'morning' | 'evening'
  ts   INTEGER NOT NULL,
  data TEXT    NOT NULL,   -- JSON {code: qty}
  PRIMARY KEY (day, kind)
);
