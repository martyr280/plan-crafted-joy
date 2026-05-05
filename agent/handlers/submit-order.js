import { query } from "../sql.js";

// payload: { customerId, poNumber, lines: [{ sku, qty, unitPrice }] }
export async function submitOrder(payload) {
  const { customerId, poNumber, lines } = payload;
  if (!customerId || !Array.isArray(lines) || lines.length === 0) {
    throw new Error("customerId and lines[] are required");
  }
  // TODO: replace with the real P21 order-creation stored procedure / API.
  // This is a placeholder that returns a fake order number so the bridge can be
  // tested end-to-end before the production sproc is wired up.
  const rows = await query("SELECT GETDATE() AS now");
  const fakeOrderNo = `P21-${Math.floor(Math.random() * 900000 + 100000)}`;
  return { p21_order_id: fakeOrderNo, submitted_at: rows[0].now, customerId, poNumber, lineCount: lines.length };
}
