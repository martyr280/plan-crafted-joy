# What the inbound traffic is telling us

## Data I looked at
- **63 inbound emails**: 23 `unknown` / 17 `logistics_update` (all needs_review) / 17 `purchase_order` (routed) / 4 `damage_report` / 1 `ar_reply`
- **23 orders**: all `pending_review`, ~7 of them with **0 line items** despite high AI confidence — extraction is silently failing on a third of POs

## Pattern 1 — The classifier is missing 4 real categories
The 23 `unknown` and a chunk of the `logistics_update` bucket aren't noise; they're work the system doesn't have a slot for.

| New category | Real examples in the inbox |
|---|---|
| **quote_request** | "Match Price Please", "specialbid quote", "26588 \| LAW OFFICES" |
| **return_request / RMA** | 3 separate "RE: RETURN" threads — wrong item + slight damage on replacement |
| **order_change** (mutates existing SO#) | "add a leg to 1382598", "ship complete instead of partial 1382582", "cancel 1382251", "remove liftgate + update ship-to 1382534" |
| **tracking_request / POD_request** | Walmart/FedEx tracking pings, "send PODs for SO# 1380952" |

Plus two auto-dismiss buckets: **auto_reply** (OOO from `gacuna@office-revolution.com`) and **marketing** (`reply@email.belnickinc.com` NRA invite).

## Pattern 2 — Internal email is being treated like external
Many `@ndiof.com` → `@ndiof.com` threads are landing in the queue ("Cubes from downtown Greenville", "2nd Dallas transfer", "Metal Finishes"). These are internal chatter, not customer requests. Need a sender-domain rule that flags `from @ndiof.com` as `internal` and routes to a separate view (or auto-dismisses unless a customer is CC'd).

## Pattern 3 — PO extraction is incomplete
7 of 23 orders have `ai_confidence ≥ 0.8` but **0 line items** (Crawford, Addus, Worthington x2, Wallace, Sheppard's, Tamela Byrd, officePRO). The classifier is happy but `parse-po` either didn't find attachments or couldn't read them. Needs a "missing line items" flag in the order review UI and a re-run button.

## Pattern 4 — Replies to acknowledgements aren't threading
Many subjects are `RE: NDI Office Furniture, LLC - Acknowledgement# 1382XXX`. We have the P21 SO# right there but we don't link the inbound email to the originating order. Should regex `Acknowledgement# (\d+)` / `SO# (\d+)` and attach the email to that order's history.

---

# Proposed changes

### A. Classifier (`supabase/functions/classify-inbound-email`)
1. Expand the enum: add `quote_request`, `return_request`, `order_change`, `tracking_request`, `auto_reply`, `marketing`, `internal`.
2. Extract `referenced_order_id` (P21 SO# / Acknowledgement#) and `change_type` (`add_line`, `cancel`, `ship_complete`, `address_change`, `remove_accessory`) when classification is `order_change`.
3. Pre-filter before AI: if `from_addr` ends `@ndiof.com` AND no external recipient → `internal`; if subject contains "Automatic reply" / "Out of office" → `auto_reply`; if `List-Unsubscribe` header present → `marketing`. Skip the LLM call for these — saves tokens.

### B. Routing (`src/lib/inbound-routing.server.ts`)
- `quote_request` → new `quotes` table (or reuse `design_quotes`), status `pending_review`.
- `return_request` → new `rma_requests` table.
- `order_change` → if `referenced_order_id` resolves to a P21 order, create an `order_change_requests` row linked to it; surface in Orders page as a yellow banner on that order.
- `tracking_request` → auto-respond: enqueue a P21 bridge `sql.select` for `oe_pick_ticket`/`shipping` info by SO#, draft a reply with tracking + POD link, queue for human send.
- `auto_reply` / `marketing` / `internal` → auto-dismiss, don't show in the main inbox view.
- All classifications: if `referenced_order_id` extracted, always append the email body to that order's activity feed.

### C. Order intake (`src/routes/_app.orders.tsx`)
- New filter chip: "Missing line items" (`jsonb_array_length(line_items) = 0`).
- Per-order "Re-run extraction" button → re-invokes `parse-po` with the original attachments.
- Show `ai_flags` count prominently — TRIANGLE/Tamela Byrd/officePRO/Sheppard's all have flags that are currently invisible.

### D. Inbox UI (`src/routes/_app.inbox.tsx`)
- Add tabs: **Needs review** (default) / **Auto-handled** / **Internal** / **Dismissed**.
- Add the new classification filters.
- On each row, if `referenced_order_id` is set, show a chip linking to that order.

### E. Schema
New migration:
- Extend `inbound_emails.classification` enum check (it's currently free text, so just docs).
- Add `inbound_emails.referenced_order_id text`, `inbound_emails.change_type text`, `inbound_emails.is_internal boolean default false`.
- New `order_change_requests` table (id, order_id, inbound_email_id, change_type, payload jsonb, status, created_at) with admin+ops_orders RLS + GRANTs.
- New `rma_requests` table (id, inbound_email_id, customer_name, original_invoice, items jsonb, reason, status) with same RLS pattern.

### F. Out of scope for this pass
- Actually executing the order changes against P21 (just capture + surface for now)
- Auto-sending tracking replies (just draft + queue)
- Full RMA workflow beyond capture

---

# Suggested rollout order
1. **Pre-filter rules** (internal / auto_reply / marketing) — instant 30% noise reduction, no schema change.
2. **Missing-line-items filter + re-run button** on Orders page — unblocks the 7 stuck orders today.
3. **Reference-order extraction** + attach to order activity feed — high-value, low-risk.
4. **New classifications + routing tables** (quote / RMA / order_change / tracking).
5. **Inbox UI tabs and chips**.

Want me to implement all five, or start with just the noise reduction + stuck-orders fixes (#1 and #2) and see the impact first?
