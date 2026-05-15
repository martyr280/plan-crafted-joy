import { Link, useRouterState } from "@tanstack/react-router";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarHeader } from "@/components/ui/sidebar";
import { LayoutDashboard, FileInput, BarChart3, Truck, Receipt, BadgeDollarSign, FileBarChart, AlertTriangle, Settings, ScrollText, Network, Inbox, Webhook, Package, Tag, Layers, BookOpen } from "lucide-react";
import { Logo } from "@/components/shared/Logo";

const groups = [
  {
    label: "Overview",
    items: [{ title: "Dashboard", url: "/", icon: LayoutDashboard }],
  },
  {
    label: "Intake",
    items: [
      { title: "Inbound Email", url: "/inbox", icon: Inbox },
      { title: "Order Intake", url: "/orders", icon: FileInput },
      { title: "Design Quotes", url: "/quotes", icon: Layers },
    ],
  },
  {
    label: "Catalog & Pricing",
    items: [
      { title: "Inventory", url: "/inventory-sync", icon: Package },
      { title: "Pricing", url: "/pricing", icon: Tag },
      { title: "Pricer", url: "/pricer", icon: FileBarChart },
      { title: "Catalogs", url: "/catalogs", icon: BookOpen },
    ],
  },
  {
    label: "Fulfillment",
    items: [
      { title: "Sales", url: "/sales", icon: BarChart3 },
      { title: "Logistics", url: "/logistics", icon: Truck },
      { title: "Damage Tracker", url: "/damage", icon: AlertTriangle },
    ],
  },
  {
    label: "Finance",
    items: [
      { title: "AR & Collections", url: "/ar", icon: Receipt },
      { title: "SPIFF", url: "/spiff", icon: BadgeDollarSign },
    ],
  },
  {
    label: "Insights",
    items: [
      { title: "Reports", url: "/reports", icon: FileBarChart },
      { title: "Audit Log", url: "/audit", icon: ScrollText },
    ],
  },
  {
    label: "System",
    items: [
      { title: "P21 Bridge", url: "/bridge", icon: Network },
      { title: "Webhook Debug", url: "/webhooks", icon: Webhook },
      { title: "Settings", url: "/settings", icon: Settings },
    ],
  },
];

export function AppSidebar() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (u: string) => u === "/" ? path === "/" : path.startsWith(u);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <img
            src={nelsonAiLogo}
            alt="Nelson AI"
            width={32}
            height={32}
            className="w-8 h-8 rounded-md shrink-0 shadow-[var(--shadow-soft)]"
          />
          <div className="flex flex-col group-data-[collapsible=icon]:hidden leading-tight">
            <span className="text-sm font-bold tracking-tight text-sidebar-foreground">Nelson AI</span>
            <span className="text-[11px] text-sidebar-foreground/60">for NDI Office Furniture</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((g) => (
          <SidebarGroup key={g.label}>
            <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((it) => (
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
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
