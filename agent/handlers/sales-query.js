import { query } from "../sql.js";

// payload: { repCode?: string, dateFrom: 'YYYY-MM-DD', dateTo: 'YYYY-MM-DD' }
export async function salesQuery(payload) {
  const { repCode = null, dateFrom, dateTo } = payload;
  if (!dateFrom || !dateTo) throw new Error("dateFrom and dateTo are required");

  // TODO: replace with the real P21 view/table for invoiced sales.
  // Common P21 starting points: invoice_hdr, invoice_line, customer, salesrep.
  const rows = await query(
    `
    SELECT
      ih.salesrep_id          AS rep_code,
      ih.customer_id          AS customer_id,
      c.customer_name         AS customer_name,
      SUM(il.extended_price)  AS net_sales,
      COUNT(DISTINCT ih.invoice_no) AS order_count
    FROM invoice_hdr ih
    JOIN invoice_line il ON il.invoice_no = ih.invoice_no
    JOIN customer c      ON c.customer_id = ih.customer_id
    WHERE ih.invoice_date >= @dateFrom
      AND ih.invoice_date <  DATEADD(day, 1, @dateTo)
      AND (@repCode IS NULL OR ih.salesrep_id = @repCode)
    GROUP BY ih.salesrep_id, ih.customer_id, c.customer_name
    ORDER BY net_sales DESC
    `,
    { repCode, dateFrom, dateTo }
  );
  return { rows, count: rows.length };
}
