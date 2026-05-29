import sql from "mssql";

let poolPromise;

export function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect({
      server: process.env.P21_SQL_HOST,
      port: Number(process.env.P21_SQL_PORT ?? 1433),
      database: process.env.P21_SQL_DB,
      user: process.env.P21_SQL_USER,
      password: process.env.P21_SQL_PASS,
      options: {
        encrypt: process.env.P21_SQL_ENCRYPT !== "false",
        trustServerCertificate: process.env.P21_SQL_TRUST_CERT !== "false",
      },
      pool: { min: 0, max: 4, idleTimeoutMillis: 30000 },
    });
  }
  return poolPromise;
}

export async function query(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  const result = await req.query(text);
  return result.recordset;
}

// Same as query() but also returns the column names in SELECT order. Use this
// when the consumer needs to preserve column order (e.g. CSV exports), since
// passing rows through Postgres jsonb loses object-key order.
export async function queryWithColumns(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  const result = await req.query(text);
  const rs = result.recordset;
  const cols = rs && rs.columns ? Object.keys(rs.columns) : (rs && rs[0] ? Object.keys(rs[0]) : []);
  return { rows: rs ?? [], columns: cols };
}
