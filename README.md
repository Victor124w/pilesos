# pilesos — часовой парсер каталога m112.com.ua

Раз в час обходит **весь каталог** m112.com.ua (~32 000 товаров, 11 разделов) и пишет
**изменения остатков** в Cloudflare D1 (та же база, что у бота @Star_ScreamBOT).
Падение остатка = продажа, рост = приход. Часовая частота ловит компенсирующие
движения (продали и приняли в один день), которые суточный срез скрыл бы.

**Публичный репозиторий специально** — у публичных репо Actions-минуты безлимитны
(полный проход ~20–25 мин × 24ч не влезает в 2000 мин приватного репо). Секретов в
коде нет — они в зашифрованных **Actions Secrets** (в публичном репо не раскрываются).

## Что делает каждый час (`.github/workflows/scan.yml`)
1. `run.mjs` — скрап каталога → diff со снимком в D1 → пишет только изменившиеся товары
   (`m112_products`) и движения (`m112_moves`, продажи/приходы).
2. `build-stock.mjs` — собирает xlsx текущих остатков (32k строк тяжело для free-воркера),
   грузит в Telegram → `file_id` кладёт в D1 (`settings.m112_stock_fileid`), служебное
   сообщение удаляет. Бот отдаёт остатки по этому `file_id` мгновенно, без генерации.

Отчёт «Продажи/Поступления» бот собирает сам на лету (лёгкий SQL-агрегат).

## Настройка (один раз)
1. Создать **публичный** репозиторий на GitHub с именем `pilesos`, залить туда содержимое
   этой папки (`scrape.mjs`, `d1.mjs`, `run.mjs`, `build-stock.mjs`, `package.json`,
   `.github/workflows/scan.yml`, `schema-m112.sql`, `README.md`).
   ```bash
   cd C:/Users/Victor/Prices/pilesos
   git init && git add . && git commit -m "m112 hourly scraper"
   git branch -M main
   git remote add origin https://github.com/<логин>/pilesos.git
   git push -u origin main
   ```
2. Схема таблиц уже применена к D1. (Если новая база — применить `schema-m112.sql`.)
3. **Settings → Secrets and variables → Actions → New repository secret**, добавить 5
   (реальные значения — в приватном `bot/CONTEXT.md`, НЕ коммитить их сюда):
   | Secret | Что это |
   |---|---|
   | `CF_ACCOUNT_ID` | Cloudflare Account ID |
   | `CF_DATABASE_ID` | ID базы D1 `prices_db` |
   | `CF_API_TOKEN` | токен Cloudflare с правом **D1:Edit** |
   | `BOT_TOKEN` | токен бота Telegram |
   | `ADMIN_CHAT_ID` | chat_id админа (куда грузится файл остатков) |
4. Проверить: вкладка **Actions → m112 hourly scan → Run workflow**. Дальше сам в :05 каждого часа.

> ⚠️ Первый проход = baseline (снимок ~32k товаров, движений нет). Продажи/приходы
> появляются со второго часа. Проход ~20–25 мин (сайт троттлит — идём последовательно).

## Локальный запуск
```bash
export CF_ACCOUNT_ID=… CF_DATABASE_ID=… CF_API_TOKEN=…
node run.mjs                     # полный проход, пишет в D1
node run.mjs --dry               # скрап+diff без записи
node run.mjs --roots tachskrini  # один раздел (тест)
export BOT_TOKEN=… ADMIN_CHAT_ID=…
node build-stock.mjs             # пересобрать остатки → file_id в D1
```
