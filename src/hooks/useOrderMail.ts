// TanStack Query wrappers around the Order Mail server functions. Pages never fetch directly.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import * as om from "@/lib/archiver/order-mail.functions";

const K = "order-mail";

function q<T>(key: unknown[], fn: (a: any) => Promise<T>, data?: unknown, enabled = true) {
  return { queryKey: [K, ...key], queryFn: () => fn(data === undefined ? undefined : { data }), enabled };
}

export const useOmOverview = () => useQuery(q(["overview"], useServerFn(om.getOverview)));
export const useOmTeams = () => useQuery(q(["teams"], useServerFn(om.listTeams)));
export const useOmMail = (f: {
  status?: string;
  team?: string;
  q?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}) => useQuery(q(["mail", f], useServerFn(om.listMail), f));
export const useOmMailDetail = (id: string | null) =>
  useQuery(q(["mail-detail", id], useServerFn(om.getMail), { id }, !!id));
export const useOmNeedsReply = () => useQuery(q(["needs-reply"], useServerFn(om.listNeedsReply)));
export const useOmRules = () => useQuery(q(["rules"], useServerFn(om.listRules)));
export const useOmLearned = (f: { q: string; bucket?: "sender" | "domain"; limit: number }) =>
  useQuery(q(["learned", f], useServerFn(om.searchLearned), f));
export const useOmShadow = () => useQuery(q(["shadow"], useServerFn(om.shadowReport), {}));
export const useOmSettings = (enabled: boolean) =>
  useQuery(q(["settings"], useServerFn(om.getSettings), undefined, enabled));

function useM<V>(fn: any, data = true) {
  const call = useServerFn(fn) as (a: any) => Promise<any>;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => call(data ? { data: v } : undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: [K] }),
  });
}

export const useOmMailAction = () => useM<{ id: string; action: "wrong_team" | "archive" | "restore" | "also_file"; toTeam?: string; teams?: string[] }>(om.mailAction);
export const useOmSetNote = () => useM<{ id: string; text: string; needs_reply?: boolean }>(om.setNote);
export const useOmTeach = () => useM<{ address: string; team: string }>(om.teachSender);
export const useOmCreateContent = () => useM<Record<string, unknown>>(om.createContentRule);
export const useOmCreateInternal = () => useM<Record<string, unknown>>(om.createInternalRoute);
export const useOmCreateMulti = () => useM<Record<string, unknown>>(om.createMultiRoute);
export const useOmDisableContent = () => useM<{ id: string }>(om.disableContentRule);
export const useOmDisableInternal = () => useM<{ address: string }>(om.disableInternalRoute);
export const useOmDisableMulti = () => useM<{ id: string }>(om.disableMultiRoute);
export const useOmPreview = () => {
  const call = useServerFn(om.previewRule) as (a: any) => Promise<any>;
  return useMutation({ mutationFn: (v: { phrase: string; scope?: string; match?: string }) => call({ data: v }) });
};
export const useOmForget = () => useM<{ bucket: "sender" | "domain"; key: string }>(om.forgetLearned);
export const useOmUpdateSettings = () => useM<Record<string, unknown>>(om.updateSettings);
export const useOmUpdateMailbox = () => useM<{ id: string; enabled?: boolean; start_at?: string | null }>(om.updateMailbox);
export const useOmSweepNow = () => useM<void>(om.runSweepNow, false);
export const useOmProbe = () => useM<void>(om.probeArchive, false);
export const useOmImport = () => useM<{ files: Array<{ name: string; text: string }>; removeLearned?: string[]; apply: boolean }>(om.importDesktop);
