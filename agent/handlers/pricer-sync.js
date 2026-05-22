import { query } from "../sql.js";

// Pricer Sync — pulls the full pricer dataset from P21 for 9 specific suppliers.
// Returns one row per item_id (per supplier_part_no). The app upserts these
// into the public.price_list table.
const SQL = `
USE P21;

SELECT
     inv_mast.item_id                    AS [Item #]
    ,inv_mast.item_desc                 AS [Description]
    ,list_price                         AS [List Price]
    ,cost                               AS [Std Cost]
    ,price1                             AS [L1 Price]
    ,price2                             AS [L2 Price]
    ,price3                             AS [L3 Price]
    ,price4                             AS [L4 Price]
    ,price5                             AS [L5 Price]
    ,price7                             AS [Showroom]
    ,vendor.vendor_name                 AS [Vendor]
    ,inventory_supplier.supplier_part_no AS [Vendor Part #]
FROM inv_mast
LEFT JOIN inventory_supplier
    ON inv_mast.inv_mast_uid = inventory_supplier.inv_mast_uid
LEFT JOIN vendor
    ON inventory_supplier.supplier_id = vendor.vendor_id
WHERE inv_mast.delete_flag = 'N'
    AND inv_mast.product_type = 'R'
    AND inventory_supplier.supplier_id IN
    (
        '13085',
        '15589',
        '15351',
        '13290',
        '17099',
        '14922',
        '15242',
        '13314',
        '13068'
    )
ORDER BY inv_mast.item_id
`;

export async function pricerSync(/* payload */) {
  const rows = await query(SQL);
  return { rows, count: rows.length };
}
