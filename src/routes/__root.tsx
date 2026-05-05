import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import appCss from "../styles.css?url";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "NDI Ops Hub" },
      { name: "description", content: "NDI internal operations platform — orders, AR, logistics, SPIFF, reports." },
      { property: "og:title", content: "NDI Ops Hub" },
      { name: "twitter:title", content: "NDI Ops Hub" },
      { property: "og:description", content: "NDI internal operations platform — orders, AR, logistics, SPIFF, reports." },
      { name: "twitter:description", content: "NDI internal operations platform — orders, AR, logistics, SPIFF, reports." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/a68c3570-5568-40c4-9c08-0cc1dda6ba60/id-preview-2c7ed15d--8f98c139-aabe-4588-ba0d-f1c274f9fea8.lovable.app-1778011263842.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/a68c3570-5568-40c4-9c08-0cc1dda6ba60/id-preview-2c7ed15d--8f98c139-aabe-4588-ba0d-f1c274f9fea8.lovable.app-1778011263842.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootShell,
  component: () => <Outlet />,
  notFoundComponent: () => (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-primary">404</h1>
        <p className="mt-2 text-muted-foreground">Page not found</p>
        <a href="/" className="mt-4 inline-block text-accent hover:underline">Go home</a>
      </div>
    </div>
  ),
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <AuthProvider>
          {children}
          <Toaster richColors position="top-right" />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}
