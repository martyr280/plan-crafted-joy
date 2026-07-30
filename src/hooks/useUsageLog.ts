import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getUsageOverview, listUsageEvents } from "@/lib/usage-log.functions";

export function useUsageOverview(range: { from?: string; to?: string }) {
  const fn = useServerFn(getUsageOverview);
  return useQuery({
    queryKey: ["usage", "overview", range],
    queryFn: () => fn({ data: range }),
  });
}

export function useUsageEvents(filters: {
  page: number;
  pageSize: number;
  userId?: string;
  eventType?: "login" | "module_view" | "feature_action";
  module?: string;
  from?: string;
  to?: string;
}) {
  const fn = useServerFn(listUsageEvents);
  return useQuery({
    queryKey: ["usage", "events", filters],
    queryFn: () => fn({ data: filters }),
  });
}
