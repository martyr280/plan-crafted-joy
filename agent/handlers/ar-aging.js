import { query } from "../sql.js";

export async function arAging() {
  // TODO: replace with the real P21 AR aging source.
  const rows = await query(`
    SELECT
      ar.customer_id,
      c.customer_name,
      c.email_address                AS customer_email,
      ar.invoice_no                  AS invoice_number,
      ar.amount_due,
      ar.due_date,
      DATEDIFF(day, ar.due_date, GETDATE()) AS days_past_due
    FROM ar_open_items ar
    JOIN customer c ON c.customer_id = ar.customer_id
    WHERE ar.amount_due > 0
  `);
  return { rows, count: rows.length };
}
