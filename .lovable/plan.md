## Context

After looking at the data:

- `price_list`: 3,033 rows — pricer XLSX, has list price (e.g. $159, $519).
- `catalog_items`: 0 rows — empty. Drop from comparison.
- `e2g_inventory_snapshot`: 4,414 rows — P21 truth with description, qty, weight, and `e2g_price` (= P21 `price10` tier, ~$36 / $126 / $143). Overlap with pricer: 1,022 SKUs.

`e2g_price` is **not** a list price — it's a dealer/cost-tier price. Overwriting `price_list.list_price` with it would corrupt list pricing. The plan keeps both prices and lets E2G own everything else.

## What gets built

### 1. Schema change on `price_list`

Add three columns so E2G data lives next to the pricer's list price without overwriting it:

- `e2g_price numeric` — P21 `price10` from the latest E2G snapshot.
- `e2g_weight numeric` — P21 weight (replaces the old `weight` column for E2G-sourced rows).
- `in_e2g boolean default false` — true when the SKU exists in the latest E2G snapshot.
- `e2g_synced_at timestamptz` — when this row was last touched by an E2G sync.

`list_price` stays untouched. Existing `weight`/`description` get overwritten on apply (E2G wins).

### 2. New server function `applyE2GToPriceList`

Called from the UI button. In one transaction-equivalent batch it:

- For every SKU in `e2g_inventory_snapshot`:
  - If a `price_list` row exists (matched by uppercased, whitespace-stripped SKU): overwrite `description`, `e2g_weight`, `e2g_price`; set `in_e2g = true`, `e2g_synced_at = now()`. Leave `list_price`, `dealer_cost`, `er_cost`, `mfg`, `category`, `cat_number` alone.
  - If no `price_list` row exists: insert a new row with `item`, `description`, `e2g_price`, `e2g_weight`, `in_e2g = true`. `list_price` left null (operator can fill it later).
- For every SKU **not** in the snapshot: set `in_e2g = false` (keeps the row, just flags it as not on E2G/P21).

Server function uses `supabaseAdmin` (admin-only RLS already on `price_list`), batched in 500-row chunks. Returns `{ updated, inserted, flaggedMissing }`.

### 3. New "Pricer vs E2G" tab on `/inventory-sync`

Adds a 4th tab next to the existing three. Shows per-SKU diffs computed client-side from the data already loaded:

| Column | Source |
|---|---|
| SKU | both |
| Pricer desc | `price_list.description` |
| E2G desc | `e2g_inventory_snapshot.item_desc` |
| List price | `price_list.list_price` (unchanged) |
| E2G price | `e2g_inventory_snapshot.e2g_price` |
| Pricer weight | `price_list.weight` |
| E2G weight | `e2g_inventory_snapshot.weight` |
| Status | `match` / `desc differs` / `weight differs` / `missing in pricer` / `missing in E2G` |

Header has:

- Filter input + status filter chips (reuse existing pattern).
- Stat row: total compared, matches, diffs, E2G-only, pricer-only.
- **"Apply E2G values to pricer"** button → confirmation dialog → calls `applyE2GToPriceList` → toast with counts → reloads.
- CSV export of the diff.

The existing "On website, no pricing" and "In pricer/catalog, not on website" tabs keep working — `catalog_items` is dropped from the join since it's empty (graceful: if catalog rows reappear later, code still handles them, just no UI surface).

### 4. Activity log entry

Each apply writes one `activity_events` row (`event_type = "e2g.apply_to_pricer"`, message with counts) so admins can audit when pricer data was overwritten.

## What's deliberately NOT in scope

- No automatic apply on every sync — explicit button only. Easy to flip later if you want it.
- `list_price` is never modified. If you later decide E2G price IS your list price, we add one more button.
- `catalog_items` is left untouched (empty table, no UI).

## Technical details

- Files touched: `src/lib/p21.functions.ts` (new fn), `src/lib/p21.server.ts` (impl), `src/routes/_app.inventory-sync.tsx` (new tab + handler).
- Migration adds 4 columns on `price_list` — nullable, safe on existing data.
- SKU matching: `UPPER(REGEXP_REPLACE(item, '\s+', '', 'g'))` — same normalization already used in the page.
- Batching: 500 rows per upsert, 90 s server-fn budget is plenty (≤ 5k rows).
- RLS unchanged — admin-only writes, ops-roles still read.

```text
┌──────────────────────────────────────────────────────────┐
│  /inventory-sync                                         │
│  ┌─[E2G card]────────────────────────[Sync E2G report]─┐ │
│  │ Last synced … · 4,414 items                         │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─[Snapshot preview]───────────────────────────[CSV]──┐ │
│  └─────────────────────────────────────────────────────┘ │
│  Tabs: no-pricing | not-on-web | desc-mismatch |         │
│        ▶ Pricer vs E2G ◀  ← new                          │
│  ┌────────────────────────[Apply E2G values to pricer]─┐ │
│  │ 1,022 matched · 412 diff · 3,392 E2G-only · ...     │ │
│  │ table…                                              │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```
