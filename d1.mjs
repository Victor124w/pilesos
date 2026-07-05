// Обёртка над D1 HTTP API (Cloudflare REST). Для парсера в GitHub Actions / локально.
// Нужны env: CF_ACCOUNT_ID, CF_DATABASE_ID, CF_API_TOKEN

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DB = process.env.CF_DATABASE_ID;
const TOKEN = process.env.CF_API_TOKEN;

function assertEnv() {
  const miss = ['CF_ACCOUNT_ID', 'CF_DATABASE_ID', 'CF_API_TOKEN'].filter(k => !process.env[k]);
  if (miss.length) throw new Error('Нет env: ' + miss.join(', '));
}

const ENDPOINT = () =>
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`;

// Один SQL-запрос с параметрами (? placeholders). Возвращает массив строк результата.
export async function d1(sql, params = []) {
  assertEnv();
  const r = await fetch(ENDPOINT(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const j = await r.json();
  if (!j.success) throw new Error('D1 error: ' + JSON.stringify(j.errors || j));
  return j.result?.[0]?.results ?? [];
}

// Экранирование значения для инлайна в SQL (D1 лимитит bound-параметры ~100/запрос).
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Пакетная вставка инлайн-значениями чанками по rowsPerStmt строк.
// rows — массив массивов значений; cols — имена столбцов.
export async function bulkInsert(table, cols, rows, { conflict = '', rowsPerStmt = 150 } = {}) {
  if (!rows.length) return 0;
  let done = 0;
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const chunk = rows.slice(i, i + rowsPerStmt);
    const values = chunk.map(r => `(${r.map(sqlVal).join(',')})`).join(',');
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values} ${conflict}`;
    await d1(sql);
    done += chunk.length;
  }
  return done;
}
