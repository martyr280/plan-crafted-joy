import { Link, useRouterState } from "@tanstack/react-router";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarHeader } from "@/components/ui/sidebar";
import { Building2, LayoutDashboard, FileInput, BarChart3, Truck, Receipt, BadgeDollarSign, FileBarChart, AlertTriangle, Settings, ScrollText, Network, Inbox, Webhook, Package, Tag, Layers, BookOpen } from "lucide-react";

const items = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Inbound Email", url: "/inbox", icon: Inbox },
  { title: "Order Intake", url: "/orders", icon: FileInput },
  { title: "Design Quotes", url: "/quotes", icon: Layers },
  { title: "Inventory", url: "/inventory", icon: Package },
  { title: "Pricing", url: "/pricing", icon: Tag },
  { title: "Catalogs", url: "/catalogs", icon: BookOpen },
  { title: "Inventory Sync", url: "/inventory-sync", icon: RefreshCw },
  { title: "Sales", url: "/sales", icon: BarChart3 },
  { title: "Logistics", url: "/logistics", icon: Truck },
  { title: "AR & Collections", url: "/ar", icon: Receipt },
  { title: "SPIFF", url: "/spiff", icon: BadgeDollarSign },
  { title: "Reports", url: "/reports", icon: FileBarChart },
  { title: "Damage Tracker", url: "/damage", icon: AlertTriangle },
  { title: "Audit Log", url: "/audit", icon: ScrollText },
  { title: "P21 Bridge", url: "/bridge", icon: Network },
  { title: "Webhook Debug", url: "/webhooks", icon: Webhook },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (u: string) => u === "/" ? path === "/" : path.startsWith(u);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-2">
          <div className="w-8 h-8 rounded-md bg-accent flex items-center justify-center shrink-0">
            <Building2 className="w-5 h-5 text-accent-foreground" />
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-bold text-sidebar-foreground">NDI Ops Hub</span>
            <span className="text-xs text-sidebar-foreground/60">Apex AI Advisors</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((it) => (
                <SidebarMenuItem key={it.url}>
                  <SidebarMenuButton asChild isActive={isActive(it.url)} tooltip={it.title}>
                    <Link to={it.url}>
                      <it.icon className="w-4 h-4" />
                      <span>{it.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
