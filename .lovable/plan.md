# Sidebar Refactor — Group by Business Process

Today the sidebar is a flat list of 18 items in no particular order. We'll keep every existing route but group them into collapsible sections that mirror how the business actually flows: intake → quoting/pricing → fulfillment → money → insight → admin.

## Proposed groups

**Overview**
- Dashboard

**Intake**
- Inbound Email
- Order Intake
- Design Quotes

**Catalog & Pricing**
- Inventory
- Inventory Sync
- Pricing
- Catalogs

**Fulfillment**
- Sales
- Logistics
- Damage Tracker

**Finance**
- AR & Collections
- SPIFF

**Insights**
- Reports
- Audit Log

**System**
- P21 Bridge
- Webhook Debug
- Settings

## Implementation notes (technical)

- Edit `src/components/layout/AppSidebar.tsx` only.
- Replace the single `items` array with a `groups` array: `{ label, items: [...] }`.
- Render one `<SidebarGroup>` per group with `<SidebarGroupLabel>` = group label, preserving icons, `tooltip`, and `isActive` logic.
- Keep `collapsible="icon"` behavior — group labels hide automatically when sidebar collapses to icon mode.
- No route changes, no renames, no new pages. Pure presentational regroup.

## Open question

Two items I'd like to confirm before implementing:
1. Is **Inventory Sync** correctly placed under Catalog & Pricing, or do you want it under System (since it's the E2G integration)?
2. Should **Audit Log** sit under Insights or under System?

If you have no preference I'll go with the layout above.
