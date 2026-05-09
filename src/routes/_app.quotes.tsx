import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { FileText, MapPin } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_app/quotes")({ component: QuotesPage });

function QuotesPage() {
  const [quotes, setQuotes] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [lines, setLines] = useState<any[]>([]);
  const [loadingLines, setLoadingLines] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("design_quotes").select("*").order("created_at", { ascending: false });
      setQuotes(data ?? []);
    })();
  }, []);

  useEffect(() => {
    if (!selected) { setLines([]); return; }
    (async () => {
      setLoadingLines(true);
      const { data } = await supabase
        .from("design_quote_lines")
        .select("*")
        .eq("quote_id", selected.id)
        .order("line_no")
        .limit(2000);
      setLines(data ?? []);
      setLoadingLines(false);
    })();
  }, [selected]);

  const grouped = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const l of lines) {
      const k = l.room || "Unassigned";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(l);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [lines]);

  function money(v: any) { return v == null ? "—" : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`; }

  return (
    <div>
      <ModuleHeader
        title="Design Quotes"
        description="Imported Configura SIF design quotes by room and line."
      />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quote</TableHead>
              <TableHead>SIF Date</TableHead>
              <TableHead>Rooms</TableHead>
              <TableHead>Lines</TableHead>
              <TableHead>Total</TableHead>
              <TableHead>Imported</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {quotes.length === 0 && (<TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No quotes imported yet.</TableCell></TableRow>)}
            {quotes.map((q) => (
              <TableRow key={q.id} className="cursor-pointer" onClick={() => setSelected(q)}>
                <TableCell className="font-medium"><FileText className="w-4 h-4 inline mr-2 text-muted-foreground" />{q.quote_name}</TableCell>
                <TableCell>{q.sif_date ?? "—"}</TableCell>
                <TableCell>{q.room_count}</TableCell>
                <TableCell>{q.line_count}</TableCell>
                <TableCell className="font-semibold">{money(q.total_list)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatDistanceToNow(new Date(q.created_at), { addSuffix: true })}</TableCell>
                <TableCell><Button size="sm" variant="ghost">View</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-3xl overflow-y-auto">
          {selected && (
            <>
              <SheetHeader><SheetTitle>{selected.quote_name}</SheetTitle></SheetHeader>
              <div className="mt-2 mb-4 flex gap-2 flex-wrap text-xs">
                <Badge variant="outline">{selected.room_count} rooms</Badge>
                <Badge variant="outline">{selected.line_count} lines</Badge>
                <Badge variant="outline">{money(selected.total_list)} list</Badge>
                {selected.sif_date && <Badge variant="outline">SIF {selected.sif_date}</Badge>}
              </div>
              {loadingLines && <p className="text-sm text-muted-foreground">Loading lines…</p>}
              <div className="space-y-6">
                {grouped.map(([room, items]) => {
                  const subtotal = items.reduce((s, l) => s + (Number(l.list_price) || 0) * (Number(l.quantity) || 0), 0);
                  return (
                    <div key={room}>
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-semibold text-sm flex items-center gap-1"><MapPin className="w-3 h-3" /> {room}</h3>
                        <span className="text-xs text-muted-foreground">{items.length} lines · {money(subtotal)}</span>
                      </div>
                      <Card>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-20">Part</TableHead>
                              <TableHead>Description</TableHead>
                              <TableHead className="w-12">Qty</TableHead>
                              <TableHead className="w-20">List</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {items.map((l) => (
                              <TableRow key={l.id}>
                                <TableCell className="font-mono text-xs">{l.part_number}</TableCell>
                                <TableCell className="text-sm">
                                  {l.description}
                                  {Array.isArray(l.options) && l.options.length > 0 && (
                                    <div className="mt-1 flex gap-1 flex-wrap">
                                      {l.options.map((o: any, i: number) => (
                                        <Badge key={i} variant="outline" className="text-[10px]">{o.desc ?? o.name}</Badge>
                                      ))}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell>{l.quantity}</TableCell>
                                <TableCell>{money(l.list_price)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </Card>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
