## What's broken

1. **The Inbox page renders the global "Try Again / Go home" error boundary** — that screen comes from `src/router.tsx` `DefaultErrorComponent`, which fires whenever the route throws during render or hits an unhandled promise. The two real triggers in `_app.inbox.tsx`:
   - `formatDistanceToNow(new Date(r.received_at))` and `r.status.replace(...)` blow up if those fields are ever missing/invalid.
   - The detail sheet does `Object.keys(selected.ai_extracted)` and `(selected.ai_flags as any[]).map(...)` — both crash if the column comes back as `null` (jsonb columns are nullable in the type).
   No try/catch on the render path, so any throw escapes to the route boundary instead of staying as a toast.

2. **Inbound emails are not being parsed end-to-end.** The 4 real emails in the table are sitting at `status = "classified"` — a value no current code writes. They were never routed because the webhook handler in `src/routes/api/public/inbound-email.ts` calls the classifier as **fire-and-forget** (`fetch(...).then(routeEmail).catch(...)`). On Cloudflare Workers, the request context terminates as soon as the handler returns its `Response.json(...)`, so the classify+route promise is killed mid-flight. Result: row gets created at `received`, sometimes flips to a half-state, never reaches `routed` / `needs_review`. New rows behave the same way.

3. **PDFs on inbound POs are ignored.** When `routeEmail` creates an `orders` row from a `purchase_order` classification, it only passes the email body. Even though we just taught `parse-po` to read PDFs, the inbound pipeline never invokes it — so an email with a PDF PO attached lands in Orders with empty/garbage line items.

4. **Status filter mismatch.** The UI Select offers `received | needs_review | routed | dismissed | error`, but the DB also contains `classified` (legacy) and the new flow can land in other states. Filtering hides those rows entirely.

## Plan

### A. Stop the inbox page from blowing up

In `src/routes/_app.inbox.tsx`:
- Wrap every render-time field access with safe accessors:
  - `formatDistanceToNow(r.received_at ? new Date(r.received_at) : new Date())` and fall back to `"—"` if invalid.
  - `String(r.status ?? "unknown").replace(/_/g, " ")`.
  - In the detail sheet: treat `ai_extracted`, `ai_flags`, `attachments` as possibly null — `const flags = Array.isArray(selected.ai_flags) ? selected.ai_flags : []` etc.
- Add a per-route `errorComponent` so even if something throws we render an inline "Could not load inbox — Retry" card instead of the full-screen boundary, and we surface `error.message` so the next debug pass is faster.

### B. Fix the parsing pipeline (the real "not parsing" bug)

Rewrite the `inbound-email` POST handler to **await** the classification + routing instead of fire-and-forget:
- Call `classify-inbound-email` synchronously, then call `routeEmail` synchronously, then return the response. Total time is well under the Worker's 30s budget for a single email.
- If classification or routing fails, write `status = "error"` + `error = message` and still return 200 to the webhook so Resend doesn't retry forever.
- Remove the legacy `received` / `classified` ambiguity — every row exits the handler as one of: `routed`, `needs_review`, `error`, `dismissed`.

### C. Wire PDF attachments into PO parsing

In the same handler, when classification is `purchase_order`:
- Detect PDF attachments on `inbound_emails.attachments` (filename ends in `.pdf` or content type contains `pdf`).
- Fetch each attachment from Resend's URL (Resend returns a signed URL on the attachment payload; if not present, base64 is already inline).
- Invoke the existing `parse-po` edge function with `{ email_content: body_text, attachments: [...] }` (it already accepts the new shape and verifies prices against `price_list`).
- Use the richer `parse-po` result for the `orders` row (`line_items`, `ai_confidence`, `ai_flags` including any "SKU not in price list" / "price differs from list" flags) instead of the lighter classification extraction.

### D. Backfill + UI cleanup

- Reclassify the 4 stuck `classified` rows by triggering the new pipeline once (one-shot SQL update to `received` + a small server-fn helper "process now" button on the detail sheet, admin only).
- Add `received` and `classified` to the status `Select` and `STATUS_COLORS`, and surface a `received → process now` action so an admin can manually retry a stuck row.
- Show the attachment list in the detail sheet (filename + size) so reviewers can see what came in.

## Out of scope

- Other inbound providers (only Resend is wired up today).
- OCR for scanned-image PDFs beyond what Gemini handles.
- Auto-promoting an order to P21 from the inbox (still requires the human review step in `/orders`).
