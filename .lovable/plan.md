# Sync ndiof.com Inventory with Pricer & Catalog

Connect Firecrawl, crawl every product page on ndiof.com, store SKU + description + image + stock status, then reconcile against `price_list` (pricer XLSX) and `catalog_items` (parsed catalog PDFs).

## A. Firecrawl connection
1. Use `standard_connectors--connect` with `connector_id: firecrawl`. Once linked, `FIRECRAWL_API_KEY` is available to server functions.
2. Verify availability via `fetch_secrets`.

## B. Database
New table `website_items` (SKU-level snapshot of ndiof.com):
- `sku` (PK with `crawl_id`), `family`, `name`, `description`, `image_url`, `detail_url`, `brand`, `category`, `in_stock` (bool), `stock_text`, `crawled_at`, `crawl_id`.

New table `website_crawls`:
- `id`, `started_at`, `completed_at`, `status` (`running|completed|failed`), `pages_crawled`, `skus_found`, `error`, `triggered_by`.

RLS: read for any authenticated ops role; write admin-only (matches existing catalog tables).

## C. Edge function `crawl-website`
- Background job pattern (job row + `EdgeRuntime.waitUntil`).
- Step 1 — **map**: `firecrawl.map('https://www.ndiof.com', { limit: 5000, includeSubdomains: false })` to get every URL, then filter to `/itemdetail/...` (single SKU) and `/itemoptions/?familyName=...` (variant family) URLs. Also include `/catsearch/...` listing pages as a fallback to capture SKUs that aren't surfaced by map.
- Step 2 — **batch scrape** in chunks of ~50 URLs using `firecrawl.batchScrape(urls, { formats: ['markdown'], onlyMainContent: true })`.
- Step 3 — parse each result with a deterministic regex pass (SKU/brand/description follow a fixed pattern shown on listing pages: `## <name>` / `SKU: <sku>` / `Brand: <brand>` / in-stock label). For variant family pages, follow the embedded `/itemdetail/SKU` links.
- Step 4 — upsert into `website_items` keyed on `sku`; update progress on `website_crawls` every batch.
- **Skip JS-rendered prices** (per user choice). Stock label is in static HTML so we keep it.

## D. Reconciliation view
Server function `getInventoryReconciliation` joins three sources by normalized SKU (upper-trim, strip spaces/dashes optional alias):

```text
website_items   ─┐
price_list      ─┼─► reconciliation rows
catalog_items   ─┘
```

Categories surfaced:
1. **On website but not in pricer/catalog** — needs pricing setup.
2. **In pricer/catalog but not on website** — needs to be added/published on ndiof.com.
3. **Mismatch** — same SKU, but description differs significantly (token Jaccard < 0.5) or brand mismatch. Price-mismatch row is reserved for a future pass when prices are scraped.

## E. UI — new route `/inventory-sync`
- Header card: last crawl timestamp, totals (website / pricer / catalog), counts per discrepancy bucket.
- "Run full crawl" button (admin only) + live progress bar polling `website_crawls`.
- Tabbed table (TanStack Query, paginated, sortable, filterable per workspace rules):
  - Tab 1 — Missing from pricer/catalog
  - Tab 2 — Missing from website
  - Tab 3 — Description mismatch
- Each row links to the ndiof.com detail page and shows source data side-by-side.
- CSV export per tab.
- Add nav entry under Catalogs section.

## F. Scheduling (optional, admin toggle)
`pg_cron` weekly job hitting `/api/public/hooks/crawl-website` (apikey auth) so the snapshot stays fresh without manual runs.

## Out of scope
- Scraping JS-rendered prices (revisit later with `waitFor` + JS rendering).
- Auto-pushing fixes back to ndiof.com.
- Image diffing.

## Technical notes
- Firecrawl SDK: `@mendable/firecrawl-js` (server-only, never expose key to client).
- All Firecrawl calls happen in the edge function; frontend only reads `website_items` / `website_crawls` via TanStack Query hooks in `src/hooks/`.
- Normalize SKU = `sku.trim().toUpperCase()` consistent with `parse-po`.
- Crawl is idempotent: each run gets a new `crawl_id`; upsert by `sku` keeps the latest snapshot, and we retain prior crawl history in `website_crawls` for auditing.
