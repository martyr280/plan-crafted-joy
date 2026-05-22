import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/inventory")({
  beforeLoad: () => {
    throw redirect({ to: "/inventory-sync" });
  },
});
