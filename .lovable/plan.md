
# NDI Ops Hub — Build Plan

A role-based internal operations platform with 6 modules. Built on TanStack Start + Lovable Cloud (Supabase) + Lovable AI Gateway. P21 (VPN-only SQL) and Samsara stubbed at the server-function boundary; OpenAI-equivalent flows wired live via Lovable AI.

## Scope decisions (from your answers)

- **Full build**: scaffold + all 6 module pages with working UI, schema, RLS, seed data, and server functions.
- **AI live** (PO parser + collection email generator) via Lovable AI Gateway (no API key needed).
- **P21 + Samsara stubbed**: server functions return realistic seed/cached data with `// TODO: replace with P21 SQL` markers. Swappable later when VPN credentials are available.
- **Design tokens**: navy `#1E3A5F` primary, orange `#F97316` accent, success/warning/danger as specified, Inter, `rounded-lg`, dark mode supported.

## Build phases

### Phase 1 — Foundation
- Enable Lovable Cloud (Supabase) + Lovable AI.
- Apply design tokens to `src/styles.css` (navy/orange semantic colors in oklch, Inter via Google Fonts).
- App shell: collapsible sidebar nav (Home, Orders, Sales, Logistics, AR, SPIFF, Reports, Damage, Settings), top bar with user menu + role badge, dark-mode toggle.
- Auth: email/password + Google sign-in. `/auth` route. `_authenticated` layout route gating all app pages.

### Phase 2 — Roles & schema
- `app_role` enum: `admin`, `ops_orders`, `ops_ar`, `ops_logistics`, `ops_reports`, `sales_rep`.
- `user_roles` table + `has_role()` security-definer function (per Lovable role pattern).
- `profiles` table (display_name, sales_rep_code, avatar).
- All tables from spec: `orders`, `sku_crossref`, `order_acknowledgements`, `spiff_rules`, `spiff_calculations`, `ar_aging`, `collection_emails`, `fleet_loads`, `damage_reports`, `report_schedules`, `report_runs`, `sales_cache`, `activity_events` (for the home feed).
- RLS per module (orders: ops_orders+admin; AR: ops_ar+admin; sales_rep sees own rep_code only; etc.).
- Seed data: ~40 orders across statuses, 25 AR invoices across buckets, 6 fleet loads, 12 damage reports, 8 SPIFF rules, 5 report schedules, sample SKU crossref rows, 30 activity events.

### Phase 3 — Home Dashboard (`/`)
- 5 KPI cards (review queue + oldest age, AR reminders today, active loads + capacity, open damage, week-over-week orders).
- Activity feed (last 20 events with icons + relative timestamps).

### Phase 4 — Module 1: Order Intake (`/orders`, `/orders/:id`, `/orders/import`)
- Stats ribbon, "New Order", "Import SIF/XML" buttons.
- Review queue table with confidence color chips (green/yellow/red), filters, flag indicators.
- Order detail drawer: editable line items, AI flag explanations, Approve+Submit / Reject buttons.
- Server fns:
  - `parsePOFromText` — **live**: Lovable AI Gateway (`google/gemini-3-flash-preview`) with structured tool-call schema returning `{customer_name, po_number, ship_to, line_items[], confidence, flags[]}`. Pre-checks `sku_crossref` for fuzzy matches.
  - `submitOrderToP21` — **stubbed**: simulates P21 call, assigns fake `p21_order_id`, marks `submitted_to_p21`, generates acknowledgement row.
  - `parseSifFile` / `parseXmlFile` — text parsers with same review pipeline.
- Learning loop: when CS rep manually maps a competitor SKU, insert into `sku_crossref` with `source='ai_learned'`.
- Duplicate detection on customer_id + po_number.

### Phase 5 — Module 2: Sales Dashboard (`/sales`)
- Daily/Weekly/Monthly toggle, rep filter (sales_rep role auto-locked to own).
- KPI cards (net sales, orders, new customers, returns), trend chart (Recharts), top customers + top products tables, CSV export.
- Server fn `fetchSalesData` — **stubbed P21**: returns deterministic synthetic data per rep+date range, cached in `sales_cache`. Marked TODO for live P21 SQL.

### Phase 6 — Module 3: Logistics (`/logistics`)
- Active loads as cards with capacity bars (color-coded), order count, driver/route/truck.
- Load detail drawer with full manifest.
- Samsara photo viewer (search by order # / pick ticket) — uses placeholder image URLs from seed data.
- Damage log table with filters.
- Server fns `syncFleetLoads`, `fetchSamsaraDocs` — stubbed.

### Phase 7 — Module 4: AR & Collections (`/ar`)
- 5 aging bucket cards with totals.
- Accounts table with bucket filter, action buttons (Send Reminder / View History / Escalate).
- Global automation toggle for 31–60 day bucket.
- Reminder template editor with live preview for selected customer.
- Server fns:
  - `syncArAging` — **stubbed P21** (refreshes seed).
  - `generateCollectionEmail` — **live AI**: takes template + customer context, returns personalized email body (≤150 words, non-threatening).
  - `sendCollectionReminder` — logs to `collection_emails`, updates `ar_aging.collection_status` + `last_contacted_at`.

### Phase 8 — Module 5: SPIFF (`/spiff`)
- Quarter selector, "Run Calculation" (admin/ops_ar only), results table with status badges.
- Rules manager (full CRUD on `spiff_rules`).
- Approval workflow: draft → pending_approval → approved (admin) → CSV export.
- Server fn `runSpiffCalculation` joins stubbed P21 sales against rules, writes `spiff_calculations`.

### Phase 9 — Module 6: Reports (`/reports`)
- Schedules table, "Run Now" buttons, run history with download links.
- Template editor with token chips (`{{product_name}}`, `{{clearance_price}}`, etc.).
- New-report wizard (multi-step form).
- Server fn `runReport` — **stubbed**: writes a generated CSV/HTML to `report-outputs` storage bucket, logs to `report_runs`.

### Phase 10 — Damage Tracker (`/damage`) & Settings (`/settings`)
- Damage tracker: RMA log table, photo viewer, analytics by route/dealer/installer.
- Settings tabs: Integrations (P21/Samsara/AI status indicators), Report Templates, SPIFF Rules, SKU Cross-Reference (with CSV import), User Management (admin only — invite, role assignment, deactivate).

## Technical notes

```text
src/
├── routes/
│   ├── __root.tsx                 (shell + providers)
│   ├── index.tsx                  (Home dashboard, gated)
│   ├── auth.tsx
│   ├── _authenticated.tsx         (layout: sidebar + auth gate via beforeLoad)
│   ├── _authenticated.orders.tsx
│   ├── _authenticated.orders.$id.tsx
│   ├── _authenticated.orders.import.tsx
│   ├── _authenticated.sales.tsx
│   ├── _authenticated.logistics.tsx
│   ├── _authenticated.ar.tsx
│   ├── _authenticated.spiff.tsx
│   ├── _authenticated.reports.tsx
│   ├── _authenticated.damage.tsx
│   └── _authenticated.settings.tsx
├── server/
│   ├── orders.functions.ts        (parsePO live AI, submitOrder stub)
│   ├── ar.functions.ts            (syncArAging stub, generate+send reminder live AI)
│   ├── sales.functions.ts         (fetchSalesData stub + cache)
│   ├── logistics.functions.ts     (sync fleet, samsara stub)
│   ├── spiff.functions.ts         (run calculation)
│   ├── reports.functions.ts       (run report, storage)
│   └── *.server.ts                (P21/Samsara client stubs with TODOs)
└── components/
    ├── layout/AppSidebar.tsx, TopBar.tsx
    ├── orders/ReviewQueue.tsx, OrderDetailDrawer.tsx, ConfidenceBadge.tsx
    ├── ar/AgingBucketCards.tsx, RemindersTable.tsx, TemplateEditor.tsx
    ├── logistics/LoadCard.tsx, CapacityBar.tsx, SamsaraViewer.tsx
    ├── spiff/RulesManager.tsx, CalculationsTable.tsx
    ├── reports/ScheduleList.tsx, TemplateTokenEditor.tsx, NewReportWizard.tsx
    ├── damage/DamageLog.tsx
    └── shared/KpiCard.tsx, ActivityFeed.tsx, RoleBadge.tsx
```

- All AI calls go through server functions (never client-direct), with proper 429/402 error surfacing as toasts.
- Stubs in `*.server.ts` files are clearly commented and isolated so swapping in real P21 SQL / Samsara HTTP later is a single-file change per integration.
- Realtime subscription on `activity_events` so the home feed updates live.

## Out of scope (for now)
- Real Epicor P21 VPN connection (Cloudflare Workers cannot terminate a VPN — needs a separate Node host or P21 REST proxy; flagged in Settings → Integrations).
- Real Samsara API token wiring (UI ready; just needs `SAMSARA_API_TOKEN` secret + flip stub to live).
- Inbound email polling for POs (UI accepts pasted email body / file upload; mailbox poller needs an external service like Postmark inbound + webhook).

## After approval
On switching to build mode I'll execute the phases in order, enabling Cloud first, then schema + auth, then UI module-by-module so each is testable.
