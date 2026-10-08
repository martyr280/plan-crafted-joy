// Order Mail server functions. Gate: signed-in, not branch-bound (denyLegacyBranchAccess), and
// admin OR ops_orders; [admin] functions require admin. User identity comes from the verified
// token (context.userId / claims), never from the client. Logic lives in order-mail.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { denyLegacyBranchAccess } from "@/lib/branch-guard";
import type { Actor, Ports } from "./order-mail.server";

async function ports(): Promise<Ports> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const arch = await import("./archiver.server");
  const filing = await import("./filing.server");
  const imp = await import("./importer.server");
  return {
    db: supabaseAdmin as any,
    hasRole: async (uid, role) => {
      const { data, error } = await supabaseAdmin.rpc("has_role", { _user_id: uid, _role: role as any });
      if (error) throw new Error("Unable to verify access");
      return data === true;
    },
    getSettings: arch.getArchiverSettings,
    graphConfigured: (s) => arch.graphStatus(s).configured,
    performAction: filing.performAction,
    runTick: () => arch.runArchiverTick(new Date(), "manual"),
    applyImportPlan: imp.applyImportPlan,
  };
}

type Ctx = { userId: string; claims: any };
async function setup(context: Ctx, admin = false) {
  const p = await ports();
  const s = await import("./order-mail.server");
  if (admin) await s.requireAdmin(p, context.userId);
  else await s.requireOperator(p, context.userId);
  const actor: Actor = { id: context.userId, name: String(context.claims?.email ?? context.userId) };
  return { p, s, actor };
}

const op = () => createServerFn({ method: "POST" }).middleware([denyLegacyBranchAccess]);
const team = z.string().min(1).max(100);

export const getOverview = op().handler(async ({ context }) => {
  const { p, s } = await setup(context as Ctx);
  return s.getOverview(p);
});

export const listMail = op()
  .inputValidator(z.object({ status: z.string().max(40).optional(), team: z.string().max(100).optional(), q: z.string().max(200).optional(),
    from: z.string().max(40).optional(), to: z.string().max(40).optional(), page: z.number().int().min(0).default(0),
    pageSize: z.number().int().min(1).max(100).default(50) }))
  .handler(async ({ context, data }) => {
    const { p, s } = await setup(context as Ctx);
    return s.listMail(p, data);
  });

export const getMail = op().inputValidator(z.object({ id: z.string().uuid() })).handler(async ({ context, data }) => {
  const { p, s } = await setup(context as Ctx);
  return s.getMail(p, data.id);
});

export const listRules = op().handler(async ({ context }) => {
  const { p, s } = await setup(context as Ctx);
  return s.listRules(p);
});

export const searchLearned = op()
  .inputValidator(z.object({ q: z.string().max(200).default(""), bucket: z.enum(["sender", "domain"]).optional(),
    limit: z.number().int().min(1).max(200).default(50) }))
  .handler(async ({ context, data }) => {
    const { p, s } = await setup(context as Ctx);
    return s.searchLearned(p, data);
  });

export const shadowReport = op()
  .inputValidator(z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() }))
  .handler(async ({ context, data }) => {
    const { p, s } = await setup(context as Ctx);
    return s.shadowReport(p, data);
  });

export const getSettings = op().handler(async ({ context }) => {
  const { p } = await setup(context as Ctx, true);
  return p.getSettings();
});

export const mailAction = op()
  .inputValidator(z.object({ id: z.string().uuid(), action: z.enum(["wrong_team", "archive", "restore", "also_file"]),
    toTeam: team.optional(), teams: z.array(team).max(20).optional() }))
  .handler(async ({ context, data }) => {
    const { p, s, actor } = await setup(context as Ctx);
    return s.mailAction(p, actor, data);
  });

export const setNote = op()
  .inputValidator(z.object({ id: z.string().uuid(), text: z.string().max(2000), needs_reply: z.boolean().optional() }))
  .handler(async ({ context, data }) => {
    const { p, s, actor } = await setup(context as Ctx);
    return s.setNote(p, actor, data);
  });

const contentRule = z.object({ phrase: z.string().max(400).optional(), team: z.string().max(100).optional(), scope: z.string().max(20).optional(),
  match: z.string().max(20).optional(), weight: z.number().optional(), note: z.string().max(500).optional() });

export const createContentRule = op().inputValidator(contentRule).handler(async ({ context, data }) => {
  const { p, s, actor } = await setup(context as Ctx);
  return s.createContentRule(p, actor, data);
});
export const updateContentRule = op().inputValidator(contentRule.extend({ id: z.string().min(1).max(100) })).handler(async ({ context, data }) => {
  const { p, s, actor } = await setup(context as Ctx);
  return s.updateContentRule(p, actor, data);
});
export const disableContentRule = op().inputValidator(z.object({ id: z.string().min(1).max(100) })).handler(async ({ context, data }) => {
  const { p, s, actor } = await setup(context as Ctx);
  return s.disableContentRule(p, actor, data.id);
});
export const createInternalRoute = op()
  .inputValidator(z.object({ address: z.string().max(320).optional(), team: z.string().max(100).optional(), note: z.string().max(500).optional() }))
  .handler(async ({ context, data }) => {
    const { p, s, actor } = await setup(context as Ctx);
    return s.createInternalRoute(p, actor, data);
  });
export const disableInternalRoute = op().inputValidator(z.object({ address: z.string().min(3).max(320) })).handler(async ({ context, data }) => {
  const { p, s, actor } = await setup(context as Ctx);
  return s.disableInternalRoute(p, actor, data.address);
});
export const createMultiRoute = op()
  .inputValidator(z.object({ kind: z.string().max(20).optional(), value: z.string().max(400).optional(), teams: z.array(team).max(20).optional(),
    scope: z.string().max(20).optional(), match: z.string().max(20).optional(), note: z.string().max(500).optional() }))
  .handler(async ({ context, data }) => {
    const { p, s, actor } = await setup(context as Ctx);
    return s.createMultiRoute(p, actor, data);
  });
export const disableMultiRoute = op().inputValidator(z.object({ id: z.string().min(1).max(100) })).handler(async ({ context, data }) => {
  const { p, s, actor } = await setup(context as Ctx);
  return s.disableMultiRoute(p, actor, data.id);
});

export const previewRule = op()
  .inputValidator(z.object({ phrase: z.string().min(1).max(400), scope: z.string().max(20).optional(), match: z.string().max(20).optional() }))
  .handler(async ({ context, data }) => {
    const { p, s } = await setup(context as Ctx);
    return s.previewRule(p, data);
  });

export const teachSender = op().inputValidator(z.object({ address: z.string().max(320), team })).handler(async ({ context, data }) => {
  const { p, s, actor } = await setup(context as Ctx);
  return s.teachSender(p, actor, data);
});

export const forgetLearned = op()
  .inputValidator(z.object({ bucket: z.enum(["sender", "domain"]), key: z.string().min(1).max(320) }))
  .handler(async ({ context, data }) => {
    const { p, s, actor } = await setup(context as Ctx, true);
    return s.forgetLearned(p, actor, data);
  });

export const updateSettings = op().inputValidator(z.record(z.string(), z.unknown())).handler(async ({ context, data }) => {
  const { p, s, actor } = await setup(context as Ctx, true);
  return s.updateSettings(p, actor, data);
});

export const updateMailbox = op()
  .inputValidator(z.object({ id: z.string().uuid(), enabled: z.boolean().optional(), start_at: z.string().max(40).nullable().optional(),
    label: z.string().max(100).optional() }))
  .handler(async ({ context, data }) => {
    const { p, s, actor } = await setup(context as Ctx, true);
    return s.updateMailbox(p, actor, data);
  });

export const runSweepNow = op().handler(async ({ context }) => {
  const { p, s, actor } = await setup(context as Ctx, true);
  return s.runSweepNow(p, actor);
});

export const importDesktop = op()
  .inputValidator(z.object({ files: z.array(z.object({ name: z.string().max(200), text: z.string() })).max(10),
    removeLearned: z.array(z.string().max(330)).max(500).optional(), apply: z.boolean() }))
  .handler(async ({ context, data }) => {
    const { p, s, actor } = await setup(context as Ctx, true);
    return s.importDesktop(p, actor, data);
  });

export const probeArchive = op().handler(async ({ context }) => {
  const { p, s, actor } = await setup(context as Ctx, true);
  return s.probeArchive(p, actor);
});
