import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  askNelson,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
} from "@/lib/ask-nelson.functions";

export function useConversations() {
  const fn = useServerFn(listConversations);
  return useQuery({
    queryKey: ["ask-nelson", "conversations"],
    queryFn: () => fn(),
  });
}

export function useConversation(id: string | null) {
  const fn = useServerFn(getConversation);
  return useQuery({
    queryKey: ["ask-nelson", "conversation", id],
    queryFn: () => fn({ data: { id: id! } }),
    enabled: !!id,
  });
}

export function useCreateConversation() {
  const fn = useServerFn(createConversation);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ask-nelson", "conversations"] }),
  });
}

export function useDeleteConversation() {
  const fn = useServerFn(deleteConversation);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ask-nelson"] }),
  });
}

export function useAskNelson(conversationId: string | null) {
  const fn = useServerFn(askNelson);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { message: string; escalate?: boolean }) =>
      fn({ data: { conversationId: conversationId!, message: vars.message, escalate: vars.escalate } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ask-nelson", "conversation", conversationId] });
      qc.invalidateQueries({ queryKey: ["ask-nelson", "conversations"] });
    },
  });
}
