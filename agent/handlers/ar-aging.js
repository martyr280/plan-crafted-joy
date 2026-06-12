import { query } from "../sql.js";

export async function arAging() {
  // P21 AR open items live on dbo.invoice_hdr where invoice_balance > 0.
  // There is no dbo.ar_open_items table in this database.
  const rows = await query(`
    SELECT
      ih.customer_id,
      c.customer_name,
      c.email_address                       AS customer_email,
      ih.invoice_no                         AS invoice_number,
      ih.invoice_balance                    AS amount_due,
      ih.due_date,
      DATEDIFF(day, ih.due_date, GETDATE()) AS days_past_due
    FROM dbo.invoice_hdr ih
    JOIN dbo.customer    c ON c.customer_id = ih.customer_id
    WHERE ih.invoice_balance > 0
      AND ih.delete_flag = 'N'
  `);
  return { rows, count: rows.length };
}
