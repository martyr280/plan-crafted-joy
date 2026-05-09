## Problem

Order intake flags SKUs as "not in catalog" whenever they're missing from the `price_list` table. But `price_list` is just the 3,033-row pricer XLSX. The actual catalog PDFs (`2026 NDI WorkSimpli Catalog` ~25 MB, `2026 Clearance List` ~5 MB) live in the `catalogs` storage bucket and are **never parsed**. Result: every SKU that exists in the printed catalog but wasn't typed into the pricer comes back as "unknown."

To fix this we need to actually read the PDF text, pull out every `SKU + description (+ list price if present)` row, and use that as the source of truth for "is this a real NDI part?"

## Plan

### A. New table: `catalog_items`

```
catalog_id uuid (fk → catalogs.id)
sku text                       -- normalized, upper-case, trimmed
description text
list_price numeric null
page int null
mfg text null                  -- inferred from section header when possible
raw text                       -- raw line for debugging
unique (catalog_id, sku)
```

Indexed on `sku` for fast `IN (...)` lookups.

### B. Ingestion edge function: `ingest-catalog`

Called when an admin uploads a catalog (and once now, manually, to backfill the 2 existing PDFs).

For each catalog:
1. Download PDF from `catalogs` storage bucket (service role).
2. Split into page batches (Gemini handles ~50 pages at a time reliably; 25 MB / ~hundreds of pages ⇒ chunked by page range using `pdf-lib` to slice the PDF into smaller PDFs).
3. For each chunk, send to `google/gemini-2.5-flash` via Lovable AI gateway as a PDF `image_url` with a tool-call schema:
   ```
   extract_catalog_rows({ rows: [{ sku, description, list_price?, mfg?, page? }] })
   ```
   System prompt: "You are reading an NDI furniture catalog. Extract every product row — part number / SKU, description, list price if shown, and the section's manufacturer if there's a header. Skip headers, footers, page numbers, marketing copy."
4. Upsert the rows into `catalog_items` (chunked inserts of ~500).
5. Update `catalogs.pages` with the real page count and write an `activity_events` row with how many SKUs were extracted.

Run as a background job (`EdgeRuntime.waitUntil`) since a 25 MB PDF will take minutes. Show progress on the Catalogs page (status: pending / parsing / ready / error + sku_count).

### C. Hook into `parse-po` price verification

Today `parse-po` only queries `price_list`. Update it to also query `catalog_items` for every SKU on the PO:

- **In price_list AND catalog_items** → green, verify price as today.
- **Only in catalog_items** → "Found in catalog (no contract price on file)" — informational flag, not an error. Still allow submission.
- **Not in either** → keep current "SKU not found" hard flag.

Drop the confidence-knockdown when the SKU is at least in the catalog.

### D. UI updates

- `/orders` review table: replace the binary `list $ / not in catalog` cell with three states: contract price / catalog only / unknown, with a tooltip showing which catalog and page.
- `/catalogs`: show parsing status badge + "Re-parse" admin button.
- `/inventory` or new `/products`: optional later — surface `catalog_items` as a searchable browse page so reps can look things up.

### E. Backfill

After deploy, manually trigger `ingest-catalog` once for the two existing PDFs (`2026 NDI WorkSimpli Catalog`, `2026 Clearance List`).

## Out of scope

- OCR for purely scanned/image catalogs (Gemini handles embedded text + reasonable image text already; if a catalog is fully scanned and that fails, we add a Tesseract pass later).
- Image extraction per SKU.
- Auto-syncing catalog list_price into `price_list` (kept separate — pricer XLSX remains the source of truth for actual sell pricing).

## Technical notes

- PDF chunking: use `pdf-lib` (Worker-safe, pure JS) to copy page ranges into smaller PDF buffers before base64-encoding for Gemini. Keeps each request under the model's input cap.
- Gemini call: `model: "google/gemini-2.5-flash"`, tool-choice forced to `extract_catalog_rows`.
- Normalization: SKUs upper-cased, whitespace stripped, trailing punctuation removed before insert and before lookup. Same normalizer used in `parse-po`.
- Worker time budget: ingestion runs as a background job that processes one chunk per invocation and re-enqueues itself via `p21_bridge_jobs`-style row, so a single Worker request never has to finish the whole 25 MB catalog.
