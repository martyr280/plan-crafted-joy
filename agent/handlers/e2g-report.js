import { query } from "../sql.js";

// E2G Combined Report — provided verbatim by the customer.
// Returns one row per item: regular/component products (with per-location
// on-hand counts) plus kits (with derived buildable count). The `Next Due In`
// columns come from open POs running totals.
const SQL = `
USE P21;

;WITH
regular_inventory AS (
    SELECT
        a.item_id,
        GETDATE() AS Today,
        a.item_desc,
        CAST(SUM(CASE WHEN b.location_id = '21' THEN (b.qty_on_hand - b.qty_allocated) ELSE 0 END) AS VARCHAR(20)) AS Birm,
        CAST(SUM(CASE WHEN b.location_id = '41' THEN (b.qty_on_hand - b.qty_allocated) ELSE 0 END) AS VARCHAR(20)) AS Dallas,
        CAST(SUM(CASE WHEN b.location_id = '51' THEN (b.qty_on_hand - b.qty_allocated) ELSE 0 END) AS VARCHAR(20)) AS Ocala,
        SUM(CASE WHEN b.location_id IN ('21','41','51') THEN (b.qty_on_hand - b.qty_allocated) ELSE 0 END) AS Total,
        a.price10 AS [E2G Price],
        a.[weight],
        a.net_weight
    FROM dbo.inv_mast a
    LEFT JOIN dbo.inv_loc b
        ON a.inv_mast_uid = b.inv_mast_uid
    WHERE a.class_id4 IN ('REGPROD','PRDCMP')
    GROUP BY
        a.item_id,
        a.item_desc,
        a.price10,
        a.[weight],
        a.net_weight
),

comp_inv AS (
    SELECT
        c.item_id AS kit_id,
        b.component_inv_mast_uid,
        b.quantity,
        FLOOR(
            SUM(
                CASE
                    WHEN e.location_id IN ('21','41','51')
                    THEN (e.qty_on_hand - e.qty_allocated)
                    ELSE 0
                END
            ) * 1.0 / NULLIF(b.quantity, 0)
        ) AS kit_inv
    FROM dbo.assembly_hdr a
    JOIN dbo.assembly_line b
        ON a.inv_mast_uid = b.inv_mast_uid
    JOIN dbo.inv_mast c
        ON c.inv_mast_uid = a.inv_mast_uid
    JOIN dbo.inv_loc e
        ON e.inv_mast_uid = b.component_inv_mast_uid
    WHERE a.delete_flag = 'N'
      AND b.delete_flag = 'N'
      AND c.class_id4 = 'PRDKIT'
    GROUP BY
        c.item_id,
        b.component_inv_mast_uid,
        b.quantity
),

kit_inventory AS (
    SELECT
        a.kit_id AS item_id,
        GETDATE() AS Today,
        b.item_desc,
        'Kit - NA' AS Birm,
        'Kit - NA' AS Dallas,
        'Kit - NA' AS Ocala,
        MIN(a.kit_inv) AS Total,
        b.price10 AS [E2G Price],
        b.[weight],
        b.net_weight
    FROM comp_inv a
    JOIN dbo.inv_mast b
        ON a.kit_id = b.item_id
    GROUP BY
        a.kit_id,
        b.item_desc,
        b.price10,
        b.[weight],
        b.net_weight
),

combined_inventory AS (
    SELECT * FROM regular_inventory
    UNION ALL
    SELECT * FROM kit_inventory
),

VolTable AS (
    SELECT
        a.item_id,
        SUM(CASE WHEN b.location_id IN ('21','41','51')
            THEN (b.qty_on_hand - b.qty_allocated) ELSE 0 END) AS qty_avail,
        SUM(CASE WHEN b.location_id IN ('21','41','51')
            THEN b.qty_backordered ELSE 0 END) AS qty_backordered,
        SUM(CASE WHEN b.location_id IN ('21','41','51')
            THEN (b.qty_backordered - (b.qty_on_hand - b.qty_allocated)) ELSE 0 END) AS qty_behind
    FROM dbo.inv_mast a
    LEFT JOIN dbo.inv_loc b
        ON a.inv_mast_uid = b.inv_mast_uid
    WHERE a.class_id4 IN ('REGPROD','PRDCMP')
    GROUP BY a.item_id
),

POs AS (
    SELECT
        m.item_id,
        p.po_no,
        p.required_date,
        p.qty_ordered,
        SUM(p.qty_ordered) OVER (
            PARTITION BY m.item_id
            ORDER BY p.required_date, p.po_no
            ROWS UNBOUNDED PRECEDING
        ) AS running_qty
    FROM dbo.po_line p
    JOIN dbo.inv_mast m
        ON p.inv_mast_uid = m.inv_mast_uid
    WHERE p.complete = 'N'
),

NextDue AS (
    SELECT
        v.item_id,
        MIN(p.required_date) AS ReqdDate
    FROM VolTable v
    JOIN POs p
        ON v.item_id = p.item_id
    WHERE v.qty_behind > 0
      AND p.running_qty > v.qty_behind
    GROUP BY v.item_id
)

SELECT
    c.item_id,
    c.Today,
    c.item_desc,
    ISNULL(c.Birm, '') AS Birm,
    ISNULL(c.Dallas, '') AS Dallas,
    ISNULL(c.Ocala, '') AS Ocala,
    ISNULL(CAST(c.Total AS VARCHAR(20)), '') AS Total,
    ISNULL(CAST(c.[E2G Price] AS VARCHAR(20)), '') AS [E2G Price],
    ISNULL(CAST(c.[weight] AS VARCHAR(20)), '') AS [weight],
    ISNULL(CAST(c.net_weight AS VARCHAR(20)), '') AS net_weight,
    -- Raw date for Supabase indexing/sorting (NULL when no due date).
    n.ReqdDate AS next_due_date,
    -- Human display strings the report has always returned.
    ISNULL(CONVERT(VARCHAR(10), n.ReqdDate, 101), '') AS [Next Due In],
    ISNULL(CONVERT(VARCHAR(8), n.ReqdDate, 1), '') AS [Next Due In 2]
FROM combined_inventory c
LEFT JOIN NextDue n
    ON c.item_id = n.item_id
ORDER BY c.item_id;
`;

export async function e2gCombinedReport() {
  const rows = await query(SQL);
  return { rows, count: rows.length };
}
