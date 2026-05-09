## Files to import

| File | Type | Size | Destination |
|---|---|---|---|
| NDI-E2G-20260428.xlsx | P21 inventory snapshot (Birm/Dallas/Ocala stock + price) | 4,414 rows | new `inventory_snapshots` table |
| Pricer-202603.xlsx | Master price list (multi-sheet) | ~2,500 clean rows | new `price_list` table |
| SUN_03052026_…sif | Configura design quote (293 line items, 35 rooms, 44 SKUs) | 16k lines | new `design_quotes` + `design_quote_lines` tables |
| E2G_Combined_Report.sql | P21 SQL template for the E2G report | 168 lines | `app_settings` key `p21.queries.e2g_combined` |
| 2026_Clearance_…pdf | Clearance catalog | binary | `catalogs` storage bucket + `catalogs` table |
| 2026_NDI_Worksimpli_Catalog…pdf | Main product catalog | binary | same |

## Schema additions

1. **inventory_snapshots** — `item_id`, `item_desc`, `birm_qty`, `dallas_qty`, `ocala_qty`, `total_qty`, `e2g_price`, `weight`, `net_weight`, `next_due_in`, `snapshot_date`, `source`. Indexed on `item_id` and `snapshot_date`. Logistics + orders + admin can read; admin can write.
2. **price_list** — `item`, `description`, `mfg`, `category`, `list_price`, `dealer_cost`, `er_cost`, `weight`, `cat_number`, `effective_date`. Indexed on `item`. Orders + AR + admin read; admin write.
3. **design_quotes** — `quote_name`, `source_file`, `sif_date`, `total_list`, `total_sell`, `room_count`, `line_count`, `imported_by`. Orders + admin read/write.
4. **design_quote_lines** — `quote_id`, `line_no`, `part_number`, `description`, `quantity`, `list_price`, `room`, `options` (jsonb of finish/color selections), `image_path`. Same RLS as parent.
5. **catalogs** — `name`, `kind` (catalog/clearance/spec), `file_path`, `published_date`, `pages`, `size_bytes`. All authenticated read; admin write.
6. **Storage bucket** `catalogs` (public read), then upload the 2 PDFs.
7. **app_settings** insert for `p21.queries.e2g_combined` containing the SQL.

## Data import

- Parse each xlsx with openpyxl, build bulk INSERT, run via psql.
- For Pricer, merge the **CSV** sheet (cleanest: item/desc/list/standard/er) with **Pricer Main** to attach mfg/category; dedupe by `item`.
- For SIF: parse blocks delimited by `PN=` lines, group child option records (`ON=/OD=`) into the parent line's `options` jsonb. Group room from `GC=`.
- Upload PDFs to `catalogs` bucket, write a row per file in `catalogs` table.

## UI additions

Four new routes under the authenticated app shell:

- **`/inventory`** — table of `inventory_snapshots` with search by item id/desc, location-stock columns, sort, paginate (50/page), shown latest snapshot only. Logistics + orders + admin.
- **`/pricing`** — table of `price_list` with search, sort by list/dealer/ER, paginate. Orders + AR + admin.
- **`/quotes`** — list of `design_quotes`, click to view lines grouped by room with totals. Orders + admin. "Import SIF" button (admin) accepts a `.sif` upload and runs the same parser server-side via an edge function.
- **`/catalogs`** — card grid of catalogs with thumbnail and download link. All users.

Add nav links to the existing sidebar in `_app.tsx`. All data fetching via TanStack Query in `src/hooks/`. Pagination + sort + filter per workspace rules.

## Technical notes

- Snapshot table is append-only — every re-import creates a new `snapshot_date`; UI filters to MAX(snapshot_date) per item.
- SIF parser handles the multi-segment per-item structure (a `PN=` block followed by zero or more option blocks ending at the next `PN=` or EOF). The 8 leading SIF header lines (`SF/ST/DT/TM/NR/TL/TP/TS`) populate the `design_quotes` row.
- An "Import SIF" edge function (`parse-sif`) lets ops upload more `.sif` files later without DB access.
- E2G SQL template stored in settings is referenced by the existing P21 bridge agent so the inventory snapshot can be refreshed from live P21 by submitting a `p21_bridge_jobs` row of kind `inventory_snapshot`.

## Out of scope (ask before doing)

- Auto-refresh schedule for inventory snapshots from P21.
- Linking `design_quote_lines.part_number` to `price_list.item` for live pricing rollups.