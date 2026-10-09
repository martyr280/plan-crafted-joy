import { createFileRoute } from "@tanstack/react-router";
import { OrderMailPage } from "@/components/order-mail/OrderMailPage";
import { useModuleView } from "@/lib/usage-log";

export const Route = createFileRoute("/_app/order-mail")({
  head: () => ({
    meta: [
      { title: "Order Mail — Nelson AI for NDI" },
      { name: "description", content: "Review how the shared order mailbox is sorted into team folders, with shadow-mode corrections and agreement tracking." },
      { property: "og:title", content: "Order Mail — Nelson AI for NDI" },
      { property: "og:description", content: "Review how the shared order mailbox is sorted into team folders, with shadow-mode corrections and agreement tracking." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  useModuleView("order-mail");
  return <OrderMailPage />;
}
