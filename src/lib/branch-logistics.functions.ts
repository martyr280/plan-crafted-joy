import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Identity from the verified bearer; scope resolved server-side from DB roles + mapping.
export const getBranchLogisticsReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        module: z.enum(["driver-time", "truck-capacity", "dispatch"]),
        weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        routeId: z.string().uuid().optional(),
        runId: z.string().uuid().optional(),
      })
      .strict()
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { readBranchLogistics } = await import("./branch-logistics.server");
    return readBranchLogistics(context.userId, data);
  });
