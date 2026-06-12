# Rework the Inventory Sync page

## Why change it

The current page shows three tabs derived from raw set-differences:

- **Missing pricing** — useful but unranked.
- **Missing on web** — dumps thousands of SKUs the company never intended to sell online (discontinued, special-order, internal items). Mostly noise.
- **Description mismatch** — uses a loose word-overlap score that fires on real differences and on benign rewording alike. Mostly false positives.

Every row weighs the same. Nothing tells you what to fix first, and there's no price-vs-pricer signal at all.

## What the page should do

A single ranked worklist — "items most worth acting on, top first" — with two pivots:

1. **Add to website** — SKUs you sell, are flagged web-sellable, and are not on ndiof.com.
2. **Review pricing** — SKUs where the website price disagrees with the current pricer list price.

Both lists ranked by **sales velocity** (last 90 days revenue) so the top of the page is always the items losing real money.

## Page layout

```text
┌─────────────────────────────────────────────────────────────────┐
│ Inventory Sync                                  [Run full crawl]│
│ Last crawl: 2h ago · 4,812 SKUs on web · 18,330 in pricer       │
├─────────────────────────────────────────────────────────────────┤
│  KPI strip                                                      │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐  │
│  │ Missing from │ Price        │ Out of stock │ Stale (no    │  │
│  │ website      │ mismatches   │ on web       │ image/desc)  │  │
│  │  142         │  37          │  88          │  61          │  │
│  │ $1.2M/yr     │ $480K/yr     │ $310K/yr     │ $90K/yr      │  │
│  └──────────────┴──────────────┴──────────────┴──────────────┘  │
│  (each card = annualized revenue at risk from top-90d sales)    │
├─────────────────────────────────────────────────────────────────┤
│  Tabs: [Add to website (142)] [Price review (37)]               │
│        [Stock & content (149)]                                  │
│                                                                 │
│  Filters: [Manufacturer ▾] [Category ▾] [Min 90-day sales ▾]    │
│           [✓ Only web-sellable]  [Search…]      [Export CSV]    │
│                                                                 │
│  Table (sortable, paginated, 50/page):                          │
│  Rank│ SKU      │ Description       │ 90d sales │ List $ │Action│
│   1  │ ABC-123  │ 1/2" Brass elbow  │   $14,210 │ $42.50 │ View │
│   2  │ DEF-456  │ …                 │ …         │ …      │ View │
└─────────────────────────────────────────────────────────────────┘
```

## Tabs

### 1. Add to website (primary)
- Source: in `price_list`, **not** in `website_items`, AND `web_sellable = true`.
- Columns: SKU, Description, Mfg, Category, 90-day units sold, 90-day revenue, List price, Last sold date, "View in pricer" link.
- Default sort: 90-day revenue ↓.

### 2. Price review
- Source: SKUs present in both, where `abs(website_price − list_price) > $1 OR > 2%`.
- **Blocked today** — `website_items` has no price column. The page renders an empty state with a "Re-crawl with prices" CTA until phase 2 ships.

### 3. Stock & content
- One unified list of "listing is broken" rows ranked by 90-day revenue:
  - Out of stock on web (`in_stock = false`)
  - Missing image (`image_url is null`)
  - Missing/short description (< 20 chars)
  - Stale crawl (> 30 days old) — informational badge
- One row per SKU with a chip set showing which problems apply.

## Removed
- The "Description mismatch" tab — Jaccard < 0.3 is noise. If we want this back later, it should be reframed as "website description shorter than catalog" or use embeddings.
- The undifferentiated "missing on web" dump — replaced by the web-sellable filtered Add-to-website tab.

## Data we need to add

Two small backend additions, both required for the velocity ranking that the user picked:

1. **`price_list.web_sellable boolean default true`** with an admin toggle. Migration adds the column; bulk-edit UI is a follow-up — for v1 we treat all rows as sellable unless category matches a blocklist (e.g. "Special Order", "Discontinued", "Internal").
2. **`sku_sales_rollup` materialized view / table** keyed by `sku`, with `units_90d`, `revenue_90d`, `last_sold_at`. Refreshed daily by a small server function that reads the same P21 source the sales page already uses. Without this, "rank by sales velocity" can't render.

If either is unavailable at runtime, the page falls back to ranking by list price and shows a banner explaining sales data isn't loaded yet.

## Implementation phases

1. **Phase 1 — UI restructure on existing data**
   - New KPI strip (counts only, no $ until rollup exists).
   - Tab 1 ("Add to website") and Tab 3 ("Stock & content") wired to existing tables.
   - Drop the mismatch tab.
   - Filters, pagination, sortable columns, CSV export per tab.
2. **Phase 2 — Sales velocity**
   - Migration: create `sku_sales_rollup` + refresh server function.
   - Add 90-day sales/revenue columns and switch default sort to revenue.
   - Annualized $-at-risk in KPI cards.
3. **Phase 3 — Web-sellable flag**
   - Migration: add `web_sellable` column + category-based seed.
   - Inline toggle on each row to mark "not for web" and remove it from the list.
4. **Phase 4 — Price discrepancy**
   - Update the Firecrawl extractor to pull list price from product pages.
   - Wire Tab 2 once `website_items.price` exists.

## Files touched (phase 1)
- `src/routes/_app.inventory-sync.tsx` — rewrite (keep crawl trigger + load logic, replace memoized diff and render).
- No backend changes in phase 1.

## Open question for the user before build
- For phase 1's "web-sellable" exclusion, is there a **category name list** you want hard-coded as the initial blocklist (e.g. "Special Order", "Discontinued")? If unsure, I'll start with no blocklist and we'll tune after seeing the first run.
