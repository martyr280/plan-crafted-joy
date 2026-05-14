// Thin createServerFn shells. KEEP THIS FILE FREE OF TOP-LEVEL SERVER-ONLY
// IMPORTS — the Vite splitter only stubs `.handler()` bodies, it does NOT
// remove unused top-level imports. Any top-level `supabaseAdmin` import
// (direct or transitive through `./p21.server`) would leak into the client
// bundle and explode at evaluation time because `client.server.ts` reads
// `SUPABASE_SERVICE_ROLE_KEY` from `process.env`.
//
// Pattern: each handler dynamically imports `./p21.server` (and anything
// else server-only) inside its body. Those dynamic imports are stripped
// along with the handler body during the client-side splitter pass.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const EnqueueSchema = z.object({
  kind: z.string().min(1).max(64),
  payload: z.record(z.string(), z.any()).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

export const enqueueP21Job = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => EnqueueSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin, runJob } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    return runJob(data.kind, data.payload, data.timeoutMs);
  });

export const getBridgeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertAdmin, getBridgeStatusServer } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    return getBridgeStatusServer();
  });

export const retryBridgeJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ jobId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin, retryBridgeJobServer } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    return retryBridgeJobServer(data.jobId);
  });

const SalesSchema = z.object({
  repCode: z.string().nullable().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const fetchSalesData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => SalesSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin, fetchSalesDataServer } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    return fetchSalesDataServer(data);
  });

export const syncArAging = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertAdmin, syncArAgingServer } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    return syncArAgingServer();
  });

export const testP21ApiConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertAdmin, runJob } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { result } = await runJob("p21.api.test", {}, 30000);
    return result as { ok: boolean; baseUrl: string; tokenPrefix: string; fetchedAt: string };
  });

const ODataQuerySchema = z
  .object({
    $filter: z.string().max(2000).optional(),
    $select: z.string().max(500).optional(),
    $orderby: z.string().max(200).optional(),
    $top: z.number().int().min(1).max(5000).optional(),
    $skip: z.number().int().min(0).optional(),
    $count: z.boolean().optional(),
  })
  .strict();

const QueryViewSchema = z.object({
  view: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_]+$/, "view must be alphanumeric/underscore"),
  query: ODataQuerySchema.optional(),
});

export const queryP21View = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => QueryViewSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { assertAdmin, runJob } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { result } = await runJob("p21.api.query", data, 60000);
    return result as { rows: any[]; count: number };
  });

export const syncE2GReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertAdmin, applyE2GSnapshot } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    return applyE2GSnapshot();
  });

const SubmitSchema = z.object({
  orderId: z.string().uuid(),
});

export const submitOrderToP21 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => SubmitSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { submitOrderToP21Server } = await import("./p21.server");
    return submitOrderToP21Server(data.orderId, context.userId, context.supabase);
  });
