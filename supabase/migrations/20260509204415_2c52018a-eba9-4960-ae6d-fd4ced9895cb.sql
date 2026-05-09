
-- Purge mock/seed data, keep only real imported records.

-- Orders: keep only the 6 real PO uploads/emails; delete fake "Apex/Blueprint/etc" seeds
DELETE FROM order_acknowledgements WHERE order_id NOT IN (SELECT id FROM orders WHERE source IN ('pdf_upload','xlsx_upload','email'));
DELETE FROM orders WHERE source NOT IN ('pdf_upload','xlsx_upload','email');

-- AR aging: all rows are mock (Apex, Blueprint, etc.)
DELETE FROM collection_emails;
DELETE FROM ar_aging;

-- Damage reports: all mock (no real order_id)
DELETE FROM damage_reports;

-- Fleet loads: keep only the DAL01 loads derived from real route data
DELETE FROM fleet_loads WHERE route_code LIKE 'R-%';

-- SPIFF: all mock
DELETE FROM spiff_calculations;
DELETE FROM spiff_rules;

-- SKU crossref: all placeholder NDI- entries
DELETE FROM sku_crossref;

-- Activity events: all seeded
DELETE FROM activity_events;

-- Report runs and schedules: all seeded
DELETE FROM report_runs;
DELETE FROM report_schedules;
