// Разовый повтор обхода сайта при обрыве связи (решение владельца 2026-09-25).
//
// Сайт не ответил / сбросил соединение → ждём 10 минут и обходим ОДИН раз заново.
// Снова не отдал → падаем как раньше (GitHub пришлёт письмо), следующий слот через 2 часа.
//
// ⚠️ Оборачивать ТОЛЬКО обход сайта, а не весь проход. До обхода в D1 ничего не записано,
// поэтому повтор безопасен. Повтор записи мог бы задвоить продажи/изменения.
//
// ⚠️ Повторяем только СЕТЕВЫЕ беды. «Сайт ответил, но разбор сломался» (вёрстка поменялась,
// неверный логин, цены кабинета не пришли) сам не починится — там повтор лишь на 10 минут
// откладывает письмо, а для логина Форсажа ещё и лишняя попытка входа в кабинет.

const NET = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|socket hang up|other side closed|terminated|network|sitemap\.xml не получен|HTTP 5\d\d/i;

export function isNetworkError(e) {
  const parts = [e?.message, e?.code, e?.cause?.message, e?.cause?.code];
  return NET.test(parts.filter(Boolean).join(' '));
}

const DELAY_MS = Number(process.env.SITE_RETRY_MS || 10 * 60 * 1000);

export async function withSiteRetry(fn, log = console.log) {
  try {
    return await fn();
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const why = [e?.message, e?.cause?.code || e?.cause?.message].filter(Boolean).join(' / ');
    log(`⚠️ связь с сайтом оборвалась: ${why}. Повтор через ${Math.round(DELAY_MS / 60000)} мин …`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
    log('▸ повтор: обход сайта заново (последняя попытка в этом слоте)');
    return await fn();
  }
}
