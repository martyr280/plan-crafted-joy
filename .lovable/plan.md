## Goal

Make Order Intake automatically (1) parse any PDF attachments on incoming POs and (2) cross-check every line item's unit price against the master `price_list` table, surfacing mismatches as AI flags before a human reviews.

## Current state

- `parse-po` edge function only accepts a text email body. It has no awareness of attachments and no price validation.
- `/orders` UI calls `parse-po` with a single textarea of pasted email content.
- `inbound-email` webhook already captures `attachments` (jsonb) on `inbound_emails` rows but they are not threaded into PO parsing.
- `price_list` table is populated (3,033 rows) but unused by the order flow.

## Changes

### 1. PDF-aware parsing in `parse-po`

- Accept new payload shape: `{ email_content, attachments?: [{ filename, content_type, url | base64 }] }`.
- For any attachment whose content_type is `application/pdf` (or filename ends in `.pdf`):
  - Fetch/decode bytes, then call Lovable AI Gateway with `google/gemini-2.5-flash` using the PDF as an `image_url`-style file input (Gemini supports PDF natively as inline data). Extract text + tables.
  - Concatenate extracted PDF text into the prompt context alongside the email body.
- Keep the existing `extract_po` tool-call schema; AI now sees email + PDF text together.

### 2. Price verification step (server-side, in `parse-po`)

After AI returns `parsed.line_items`:
- Query `price_list` for every distinct `sku` in one `in()` call (limit explicit, no default cap).
- For each line:
  - If SKU not found → push flag `{ field: "line[i].sku", issue: "SKU not in price list", suggestion: "Verify part number" }`.
  - If found and `unit_price` differs from `list_price` (or `dealer_cost`, configurable — default compare to `list_price`) by more than 1¢ → push flag `{ field: "line[i].unit_price", issue: "Price $X on PO vs $Y list", suggestion: "Confirm contract pricing" }`.
  - Attach `price_list_match: { list_price, dealer_cost, mfg, description }` onto the line item so the review UI can show it.
- Lower `parsed.confidence` proportionally when >20% of lines have price flags.

### 3. Orders UI updates (`src/routes/_app.orders.tsx`)

- "Parse Email PO" dialog: add a file input that accepts `.pdf` (multi). Files are base64-encoded client-side and sent in the `attachments` array.
- Line items table in the review sheet: add a "List $" column and show a yellow row highlight when `price_list_match` is missing or the price differs.

### 4. Inbound email path

When an inbound email row is converted to an order, pass through `inbound_emails.attachments` to `parse-po` so emails that arrive via Resend webhook with PDF attachments get the same treatment automatically.

## Out of scope

- OCR for scanned/image-only PDFs beyond what Gemini handles natively.
- Auto-correcting prices (we only flag; humans approve).
- Bulk re-validation of historical orders.
