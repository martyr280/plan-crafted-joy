# Decouple E2G from the pricer; ship a dedicated E2G report

E2G is a customer, not a pricing parent. Today the E2G snapshot writes back into `price_list` (overwriting description/weight and storing `e2g_price`/`in_e2g`), and the Pricer page filters by E2G stock. We'll rip out that coupling and move E2G into a standalone report at `/reports/e2g`.

## What changes for the user

- **Pricer page** no longer mentions E2G. The "In-stock only (E2G)" filter is removed.
- **Inventory Sync** page loses the "Pricer vs E2G" compare/apply tab and the "Apply E2G values to pricer" button. The E2G snapshot panel moves out entirely.
- **New page: Reports → E2G Combined Report** (`/reports/e2g`)
  - Sync button (runs the P21 bridge job, same as today)
  - Last-synced timestamp and row count
  - Full sortable / filterable table of the snapshot (item, description, Birm / Dallas / Ocala / Total, E2G price, weight, net weight, next due date)
  - Search box and CSV download
  - Visible to admins and ops roles (matches existing snapshot RLS)
- **Cron sync** keeps working unchanged — it just populates the snapshot, no longer touches `price_list`.

## Technical details

### Database migration

Drop the pricer-side E2G columns now that nothing writes or reads them:

```sql
ALTER TABLE public.price_list
  DROP COLUMN IF EXISTS e2g_price,
  DROP COLUMN IF EXISTS e2g_weight,
  DROP COLUMN IF EXISTS in_e2g,
  DROP COLUMN IF EXISTS e2g_synced_at;
```

`public.e2g_inventory_snapshot` and its RLS policies stay as-is — that's the source for the report.

### Server / lib changes

- `src/lib/p21.server.ts`
  - Remove `applyE2GToPriceList` and its `normSku` helper (no longer needed).
  - Keep `applyE2GSnapshot` (drives the sync).
- `src/lib/p21.functions.ts`
  - Remove `applyE2GToPricer` server function and its import.
  - Keep `syncE2GReport` and `applyE2GSnapshotServerOnly` (used by the cron route).
- `src/lib/pricer.server.ts`
  - Remove the `in_stock_only` branch that queries `e2g_inventory_snapshot`. Drop the parameter from the filter type.
- `src/routes/_app.pricer.tsx`
  - Remove the "In-stock only (E2G)" switch and the state/query plumbing for it.

### Route changes

- **New** `src/routes/_app.reports.e2g.tsx`
  - Loader-less; uses `useQuery` to read `e2g_inventory_snapshot` via supabase client.
  - Sync button calls `syncE2GReport` server fn.
  - Columns + filters + CSV export as listed above.
  - Pagination (page size 100) since snapshots can be large — per workspace rules, no unbounded fetch.
- `src/routes/_app.inventory-sync.tsx`
  - Delete the E2G Combined Report card, the snapshot preview table, the "Pricer vs E2G" tab, `pricerVsE2G` memo and stats, `handleSyncE2G` / `handleApplyE2G`, and the related state.
  - Keep the rest of the inventory-sync flow intact.
- Sidebar: `Reports` already exists at `/reports`. Either add a subnav link or surface E2G as a card on the existing reports page. We'll link from `_app.reports.tsx`.

### Cron / public webhook

`src/routes/api/public/sync-e2g.ts` and `supabase/functions/sync-e2g/index.ts` keep working — they only touch `e2g_inventory_snapshot`. No code change required.

### File-touch summary

- Migration: drop 4 columns from `price_list`
- Edit: `src/lib/p21.server.ts`, `src/lib/p21.functions.ts`, `src/lib/pricer.server.ts`, `src/routes/_app.pricer.tsx`, `src/routes/_app.inventory-sync.tsx`, `src/routes/_app.reports.tsx`
- New: `src/routes/_app.reports.e2g.tsx`

## Out of scope

- Multi-customer pricing (Tier 1 / 1.5 / 2 from the earlier discussion). The E2G column alias stays in the SQL — it just lands in the snapshot table and the report, never in `price_list`.
