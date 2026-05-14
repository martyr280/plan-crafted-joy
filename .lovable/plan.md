# Plan: Automated Pricer Module

Replace the manual Pricer spreadsheet with a data-driven module. The uploaded `Pricer-202603.xlsx` is the **target output format**, not a data source — we will not import from it. All data lives in `price_list` plus a few new tables; PDFs are generated on demand to match the spreadsheet's look.

## Output spec — taken from the uploaded Pricer

**Landscape** (sales / customer care) — repeating header, one row per Short Part Number, columns:

```text
Short PN | Full PN (rep) | Description | Finishes | List | L5 | L4 | L3 | L2 | L1
```

**Portrait** (one per price level, distributed by reps to dealers at that level) — image left, Short PN + description + finish chips center, single chosen level price right. Generated one PDF per generation; the level is selected at generation time.

Both share a brand header/footer (logo, "Effective {date}", page x/y).

## Pricing model — confirmed by Kevin

Six published levels per item: **List, L1, L2, L3, L4, L5**. Five custom dealer levels exist but are never published — out of scope.

`price_list` today only has `list_price`, `dealer_cost`, `er_cost`, `e2g_price`. **L1–L5 do not exist yet** — we add them as real numeric columns on `price_list`. Initial values are entered/maintained in the SKU Families admin tab (bulk-edit grid + CSV paste). No xlsx import step.

## Color/finish rollup — confirmed pattern

Each finish is its own row in `price_list` (e.g. `PL102APN`, `PL102CGY`, `PL102CH`, …) and they share identical pricing. The pricer prints **one row per family** identified by a new `item_short` column (e.g. `PL102`, `PLTVRMETLEG`) and lists the finishes underneath as a chip strip — no manual de-duplication.

`item_short` is added as a real column on `price_list`. Population strategy:
1. **Auto-derive** — group by identical 6-level price tuple within the same `mfg`/`category`, take the longest common alphabetic prefix as the candidate `item_short`. Store on every row.
2. **Override per row** — editable in the SKU Families tab.
3. **Recompute** button to re-run the auto-derive after pricing edits.

Items that don't fit a family (singletons) get `item_short = item`.

## Images — confirmed pattern

Per-finish, served from `https://ndiofficefurniture.net/images/{FULL_SKU}.jpg` (e.g. `PL102APN.jpg`, `PLTVRMETLEGBLK.jpg`). The pricer picks the first finish in the family with a reachable image (HEAD 200) and shows it as the family thumbnail. Status (`reachable`, `not_found`) cached in `sku_image_cache` — no per-render re-probe.

The Item Images tab lists families with no reachable image and accepts a manual upload to the `pricer-images` bucket as override. **Resync** button re-probes the URL pattern.

## Pages & flows

**Route:** `/pricing/pricer` (Catalog & Pricing sidebar group)

Three tabs:

1. **Pricer Builder** — pick filters (category, mfg, optionally restrict to in-stock via `e2g_inventory_snapshot`), pick orientation. For **portrait** pick exactly one of List / L1 / L2 / L3 / L4 / L5. Click **Generate PDF**.
2. **SKU Families** — bulk-edit grid: `item`, `item_short`, `description`, six prices. Inline edit any cell. **Recompute families** runs the auto-derive. CSV paste-in for a level column when Kevin needs to bulk-update prices.
3. **Item Images** — thumbnail grid per family with status; **Probe** to recheck `ndiofficefurniture.net`; **Upload override** for families with no live image.

**Output:** PDFs land in `pricer_publications` table + `pricer-pdfs` storage bucket (signed URLs). Each row snapshots filters + orientation + level so a **Regenerate** rerun matches.

## Data changes — one migration

```text
price_list                 + item_short    TEXT     -- editable family key
                           + price_l1..l5  NUMERIC  -- new published levels
                           + index on (item_short)

sku_image_cache            full_sku TEXT PK, image_url TEXT,
                           status TEXT (reachable|not_found|error),
                           checked_at TIMESTAMPTZ

sku_family_image_overrides item_short TEXT PK, image_path TEXT,
                           uploaded_by UUID, updated_at TIMESTAMPTZ

pricer_publications        id UUID PK, name TEXT, orientation TEXT,
                           portrait_level TEXT NULL, filters JSONB,
                           pdf_path TEXT, row_count INT,
                           generated_by UUID, generated_at TIMESTAMPTZ
```

Storage: `pricer-images` (public, manual overrides), `pricer-pdfs` (private, signed URLs).

RLS: admin-write, ops_orders/ops_ar/admin read — matches existing `price_list`.

`list_price` stays as-is and is what feeds the "List" column. L1–L5 start NULL until Kevin enters them in the SKU Families tab. The Pricer Builder warns if any selected family has missing levels and offers to skip those rows.

## PDF generation

Server function `generatePricerPdf` in `src/lib/pricer.functions.ts`, admin-only via `requireSupabaseAuth` + role check:

- Pulls families matching filters with all six prices + resolved image URL.
- Renders with `@react-pdf/renderer` (pure JS, Worker-compatible). Two layout components: `PricerLandscape`, `PricerPortrait`.
- Uploads to `pricer-pdfs`, inserts `pricer_publications` row, returns signed URL.
- Header/footer + repeating table header live in the React templates and stay consistent across orientations.

## Phases

1. **Migration** — add `item_short` + `price_l1..l5`, three new tables, two buckets, RLS, index.
2. **Family rollup** — SKU Families tab with bulk-edit grid, auto-derive, override, CSV paste.
3. **Image pipeline** — `sku_image_cache`, on-demand HEAD probe of `ndiofficefurniture.net/images/{SKU}.jpg`, manual upload override.
4. **PDF generation** — `@react-pdf/renderer` landscape + portrait templates matching the uploaded Pricer's layout.
5. **Publications list** — table of past PDFs with Regenerate / Download.

## Out of scope for v1

- Importing from `Pricer-202603.xlsx` (it's a reference for output layout only).
- The five unpublished custom-dealer levels.
- Auto-emailing PDFs to dealers (download only).
- Background scheduling — generation is on-demand.