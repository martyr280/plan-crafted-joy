// Manual P21 truck-capacity snapshot runner.
//
// Usage (from repo root):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... P21_BRIDGE_SECRET=... \
//     bun run scripts/tc-run-snapshot.ts [orders|transfers]
//
// Runs the same runP21Snapshot() the nightly cron uses, then queries the
// resulting demand rows for a sanity readout of projected_capacity_frac.
import { runP21Snapshot } from "../src/lib/truck-capacity.server";
import { supabaseAdmin } from "../src/integrations/supabase/client.server";

type Kind = "orders" | "transfers";

async function main() {
  const kind = ((process.argv[2] as Kind | undefined) ?? "orders") as Kind;
  if (kind !== "orders" && kind !== "transfers") {
    throw new Error(`invalid kind: ${kind} (expected "orders" or "transfers")`);
  }

  const startedAt = new Date();
  console.log(`Running P21 ${kind} snapshot at ${startedAt.toISOString()}…`);
  const result = await runP21Snapshot({ kind, timeoutMs: 180_000 });

  console.log(JSON.stringify({
    ok: result.ok,
    kind: result.kind,
    rowsPulled: result.rowsPulled,
    snapshotsWritten: result.snapshotsWritten,
    unmatchedRouteCodes: result.unmatchedRouteCodes,
    skipped: result.skipped,
    error: result.error ?? null,
  }, null, 2));

  if (!result.ok) {
    console.error("Snapshot failed — aborting sanity readout.");
    process.exit(1);
  }

  // Sanity readout — pull rows inserted since we started the run.
  const { data: newRows, error } = await supabaseAdmin
    .from("truck_capacity_p21_demand")
    .select("route_id, ship_date, projected_capacity_frac, total_cube_ft, total_weight_lbs, est_pallets, order_count")
    .gte("created_at", startedAt.toISOString())
    .limit(50000);
  if (error) throw new Error(`readout query failed: ${error.message}`);

  const rows = newRows ?? [];
  const withFrac = rows.filter((r) => r.projected_capacity_frac != null);
  const fracs = withFrac.map((r) => Number(r.projected_capacity_frac));
  const min = fracs.length ? Math.min(...fracs) : null;
  const max = fracs.length ? Math.max(...fracs) : null;
  const avg = fracs.length ? fracs.reduce((a, b) => a + b, 0) / fracs.length : null;
  const capped = fracs.filter((f) => f >= 1.499999).length;

  // Map route_id → code for readability.
  const routeIds = Array.from(new Set(withFrac.map((r) => r.route_id)));
  const { data: routeRows } = await supabaseAdmin
    .from("truck_capacity_routes").select("id, code, hub").in("id", routeIds);
  const codeById = new Map((routeRows ?? []).map((r) => [r.id, `${r.code} · ${r.hub}`]));

  const top5 = [...withFrac]
    .sort((a, b) => Number(b.projected_capacity_frac) - Number(a.projected_capacity_frac))
    .slice(0, 5)
    .map((r) => ({
      route: codeById.get(r.route_id) ?? r.route_id,
      ship_date: r.ship_date,
      projected_capacity_frac: Number(r.projected_capacity_frac).toFixed(3),
      total_cube_ft: r.total_cube_ft,
      total_weight_lbs: r.total_weight_lbs,
      est_pallets: r.est_pallets,
      order_count: r.order_count,
    }));

  console.log("\nSanity readout:");
  console.log(JSON.stringify({
    demandRowsWritten: rows.length,
    rowsWithProjection: withFrac.length,
    projectedFracMin: min?.toFixed(3) ?? null,
    projectedFracMax: max?.toFixed(3) ?? null,
    projectedFracAvg: avg?.toFixed(3) ?? null,
    rowsAtCap_1_5: capped,
    top5ByProjectedFrac: top5,
  }, null, 2));

  // Plausibility check.
  const warnings: string[] = [];
  if (fracs.length === 0) {
    warnings.push("No rows have projected_capacity_frac — every route still lacks cube/weight/pallets full-truck targets, OR nothing matched.");
  } else {
    if (avg != null && avg < 0.02) warnings.push(`Average projection is ${avg.toFixed(3)} — implausibly low; check that total_cube_ft / total_weight_lbs are actually populated.`);
    if (max != null && max >= 1.5 && capped / fracs.length > 0.5) warnings.push(`>50% of rows hit the 1.5 cap — full-truck targets are likely too small.`);
    if (min != null && min > 0.9) warnings.push(`Minimum projection ${min.toFixed(3)} is suspiciously high — every day looks near-capacity.`);
  }
  if (result.unmatchedRouteCodes.length > 0) {
    warnings.push(`Unmatched route codes still present: ${result.unmatchedRouteCodes.join(", ")} — map or exclude them in Settings.`);
  }
  if (warnings.length === 0) {
    console.log("\nPlausibility: OK — no red flags.");
  } else {
    console.log("\nPlausibility WARNINGS:");
    for (const w of warnings) console.log(`  • ${w}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
