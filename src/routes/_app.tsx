import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { TopBar } from "@/components/layout/TopBar";
import { AskNelsonBubble } from "@/components/ask-nelson/AskNelsonBubble";
import { BranchLogisticsPage } from "@/components/branch-logistics/BranchLogisticsPage";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function branchModule(path: string): "driver-time" | "truck-capacity" | "dispatch" | null {
  const p = path.replace(/\/+$/, "");
  if (p === "/driver-time") return "driver-time";
  if (p === "/truck-capacity") return "truck-capacity";
  if (p === "/dispatch") return "dispatch";
  return null;
}

function AppLayout() {
  const { user, loading, hasRole } = useAuth();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (!loading && !user) {
      const next = window.location.pathname + window.location.search;
      navigate({ to: "/auth", search: { next: next && next !== "/" ? next : "" } });
    }
  }, [user, loading, navigate]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  // Warehouse managers never mount the operator pages; the server enforces the same boundary.
  const isBranch = hasRole("branch_manager");
  const mod = isBranch ? branchModule(path) : null;

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar />
          <main className="flex-1 p-6 overflow-auto">
            {!isBranch ? (
              <Outlet />
            ) : mod ? (
              <BranchLogisticsPage module={mod} />
            ) : (
              <div className="max-w-md space-y-3">
                <h1 className="text-lg font-semibold">Not available</h1>
                <p className="text-sm text-muted-foreground">
                  Your account can view read-only warehouse reports only.
                </p>
                <div className="flex gap-3 text-sm">
                  <Link to="/driver-time" className="underline">
                    Driver Time
                  </Link>
                  <Link to="/truck-capacity" className="underline">
                    Truck Capacity
                  </Link>
                  <Link to="/dispatch" className="underline">
                    Dispatch
                  </Link>
                </div>
              </div>
            )}
          </main>
        </div>
        {!isBranch && <AskNelsonBubble />}
      </div>
    </SidebarProvider>
  );
}
