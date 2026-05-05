import { query } from "../sql.js";

export async function ping() {
  const rows = await query("SELECT GETDATE() AS server_time, @@VERSION AS version");
  return { ok: true, ...rows[0] };
}
