# TASKS — pilesos (парсеры в GitHub Actions)

## В работе

### 1.1 🔴 ukrmobil: GraphQL переехал на admin-ukr-mobile.com.ua
- [x] Найдена причина: старый адрес admin-new.dashboard-soft.com отдаёт 301, POST превращается в GET без тела — «Syntax Error: Unexpected <EOF>». Падает с 05.10.2026.
- [x] Новый адрес в `ukrmobil-scrape.mjs`, локально прошли 30 карточек без сбоев (23.10.2026).
- [ ] Выкатить (push в main) и проверить полный прогон в Actions.

### 1.2 🔴 forsage: Cloudflare закрыл /graphql (403)
- [ ] Ждёт решения Виктора. С 16.10.2026 `/graphql` отвечает 403 «Attention Required | Cloudflare» и с раннеров, и с домашнего IP; сайт и REST-вход открыты. Обходить защиту не будем — варианты: попросить у Форсажа прайс/API для партнёра или выключить workflow до решения.
