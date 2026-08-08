-- Добавляем цены в ДОЛЛАРАХ. Базовая валюта магазина — USD, гривна витринная
-- (курс из GraphQL currency.exchange_rates, на 2026-08-08 = 45.2).
-- Доллар первичен: 23.5 × 45.2 = 1062.20 ровно, поэтому храним его как основу,
-- а гривну считаем. Владелец сравнивает с нашей номенклатурой в $ (iCracked_SKU кол. K).
ALTER TABLE forsage_products ADD COLUMN price_retail_usd REAL;
ALTER TABLE forsage_products ADD COLUMN price_partner_usd REAL;
