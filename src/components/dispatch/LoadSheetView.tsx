import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildLoadSheet, type LoadSheetInputStop } from "@/lib/dispatch/loadsheet";
import { formatEstPallets, formatPalletTotal } from "@/lib/truck-capacity/est-pallets";

/** Warehouse print view. Held stops are excluded before the estimate is summed. */
export function LoadSheetView({
  stops,
}: {
  stops: Array<LoadSheetInputStop & { state?: string | null }>;
}) {
  const sheet = buildLoadSheet(stops);
  return (
    <div data-testid="load-sheet">
      <Card className="overflow-hidden">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">Load</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="w-16">ST</TableHead>
              <TableHead className="w-28">Order</TableHead>
              <TableHead className="w-28 whitespace-normal text-right">Estimated pallets</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sheet.stops.map((s, i) => (
              <TableRow key={i}>
                <TableCell>{s.loadOrder}</TableCell>
                <TableCell className="break-words">{s.customerName ?? "—"}</TableCell>
                <TableCell>{s.state ?? "—"}</TableCell>
                <TableCell className="truncate">{s.orderNo ?? "—"}</TableCell>
                <TableCell className="text-right">{formatEstPallets(s.estPallets)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Load sheet is delivery order reversed — last stop loads first. Held stops are excluded.
        Estimated pallet total: {formatPalletTotal(sheet.totals.palletTotal)}.
      </p>
    </div>
  );
}
