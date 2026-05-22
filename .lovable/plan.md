# Replace Pricer Source with P21 SQL

Replace the existing `price_list` data source with a new P21 SQL query that runs through the P21 bridge. Add a "Sync Pricer from P21" admin button and a nightly cron job.

## What this changes

- The pricer page (`/pricer`) and pricing page (`/pricing`) keep reading from the `price_list` table — nothing in the UI consumer code changes.
- `price_list` is now repopulated from a single P21 SQL query (regular products from 9 specific suppliers) instead of any prior XLSX import flow.
- Sync runs two ways: manually (admin button on `/pricer`) and nightly via Supabase cron.

## Column mapping (P21 SQL → `price_list`)

| P21 column                          | `price_list` column   |
|-------------------------------------|-----------------------|
| `inv_mast.item_id`                  | `item`                |
| `inv_mast.item_desc`                | `description`         |
| `list_price`                        | `list_price`          |
| `cost`                              | `dealer_cost`         |
| `price1`–`price5`                   | `price_l1`–`price_l5` |
| `price7` (Showroom)                 | `price_showroom` (NEW)|
| `vendor.vendor_name`                | `mfg`                 |
| `inventory_supplier.supplier_part_no` | `cat_number`        |

`source` is set to `'p21_sql'` on every synced row. After sync, `recomputeFamilies()` runs to refresh `item_short`.

If `dealer_cost`, `cat_number`, or `mfg` are wrong targets, say so before approving and I'll adjust.

## Phases

### Phase 1 — Database

Add one column to `price_list`:

```sql
ALTER TABLE public.price_list ADD COLUMN IF NOT EXISTS price_showroom numeric;
```

### Phase 2 — Bridge handler (Node agent)

New file `agent/handlers/pricer-sync.js` containing the supplied SQL verbatim. Returns `{ rows, count }`. Registered in `agent/handlers/index.js` under kind `"pricer.sync"`. The agent must be redeployed via the existing GitHub release workflow for the new handler to be available.

### Phase 3 — Server function

New `syncPricerFromP21` in `src/lib/p21.functions.ts`:
1. Admin-only.
2. `runJob("pricer.sync", {}, 120000)` — bridge fetches rows from P21.
3. Upsert into `price_list` on `item` (unique index already exists), mapping columns per the table above, setting `source = 'p21_sql'`.
4. Delete rows where `source = 'p21_sql'` and `item NOT IN (synced items)` so removed SKUs disappear.
5. Call `recomputeFamilies()`.
6. Insert an `activity_events` row: `pricer.synced` with row count.
7. Return `{ imported, removed, families_updated }`.

### Phase 4 — UI

On `/pricer` (admin only): add a "Sync from P21" button next to the existing header actions. Uses TanStack Query mutation + Sonner toast. Disables while running. Invalidates pricer queries on success.

### Phase 5 — Scheduled sync

New public route `src/routes/api/public/hooks/sync-pricer.ts`:
- Validates `apikey` header against `SUPABASE_ANON_KEY`.
- Calls `applyPricerSyncServerOnly()` (a `createServerOnlyFn` wrapper around the same logic).
- Returns `{ imported, removed }`.

Cron job (created via `supabase--insert`, not migration — stable URL pattern):
```sql
select cron.schedule(
  'sync-pricer-nightly',
  '0 6 * * *',  -- 06:00 UTC nightly
  $$ select net.http_post(
       url := 'https://project--8f98c139-aabe-4588-ba0d-f1c274f9fea8.lovable.app/api/public/hooks/sync-pricer',
       headers := '{"Content-Type":"application/json","apikey":"<ANON_KEY>"}'::jsonb,
       body := '{}'::jsonb
     ) $$
);
```

## Out of scope

- No changes to pricer family logic, image cache, PDF export, or order pricing lookups.
- No removal of existing `price_list` rows from other sources unless they happen to share an `item` value (upserted).
- No new admin role; reuses existing `admin` checks.

## Files touched

- `supabase/migrations/<new>.sql` — add `price_showroom`
- `agent/handlers/pricer-sync.js` (new)
- `agent/handlers/index.js` — register `pricer.sync`
- `src/lib/p21.functions.ts` — `syncPricerFromP21`, `applyPricerSyncServerOnly`
- `src/lib/p21.server.ts` — `applyPricerSync()` helper
- `src/routes/_app.pricer.tsx` — Sync button
- `src/routes/api/public/hooks/sync-pricer.ts` (new) — cron endpoint
- Cron job inserted via `supabase--insert`
