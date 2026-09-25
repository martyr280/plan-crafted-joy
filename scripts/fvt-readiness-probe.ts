// READ-ONLY probe: Forecast vs Tracker readiness via the real buildForecastVsTracker path.
// SELECTs only (user_roles lookup + the builder's own reads). No writes.
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { buildForecastVsTracker } from "../src/lib/truck-capacity.functions";

const { data: admins, error } = await supabaseAdmin
  .from("user_roles").select("user_id").eq("role", "admin").limit(1);
if (error || !admins?.length) throw new Error(`No admin user found: ${error?.message ?? "none"}`);
const adminUserId = admins[0]!.user_id as string;
console.log("admin user id:", adminUserId);

const input = { from: "2026-08-02", to: "2026-09-25", madeOnFrom: "2026-07-31", includeSpecial: false, hub: null };
console.log("input:", JSON.stringify(input));
const res = await buildForecastVsTracker(input, adminUserId);
console.log("rows:", res.rows.length);
console.log("readiness.overall:", JSON.stringify(res.readiness.overall, null, 2));
console.log("readiness.byHub:", JSON.stringify(res.readiness.byHub, null, 2));
