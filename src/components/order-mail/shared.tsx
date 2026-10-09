import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Inbox } from "lucide-react";

export const EMPTY_MAIL = "No mail yet — Order Mail starts once the mailbox is connected and enabled.";

export type Mode = "SHADOW" | "LIVE" | "PAUSED";

export function Empty({ children = EMPTY_MAIL }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
      <Inbox className="h-6 w-6" aria-hidden />
      <p>{children}</p>
    </div>
  );
}

/** Server functions return `{ ok:false, errors }` for validation problems. */
export function errorsOf(r: unknown): string[] {
  const x = r as { ok?: boolean; errors?: string[] } | null;
  return x && x.ok === false ? (x.errors ?? ["Refused"]) : [];
}

export function Errors({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <ul className="space-y-0.5 text-xs text-destructive" role="alert">
      {list.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

export function SourceBadge({ source }: { source: string | null | undefined }) {
  const web = source === "web";
  return (
    <Badge variant={web ? "default" : "secondary"} className="text-[10px]">
      {web ? "web" : "desktop"}
    </Badge>
  );
}

export const fmt = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Chicago" }) : "—";

/** Button that opens a confirm dialog; `onConfirm` runs only after the explicit Confirm click. */
export function ConfirmButton({
  label,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  disabled,
  variant = "outline",
  size = "sm",
}: {
  label: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  variant?: "outline" | "default" | "destructive" | "secondary";
  size?: "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setOpen(false);
                await onConfirm();
              }}
            >
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
