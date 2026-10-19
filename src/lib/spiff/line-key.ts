export interface LineIdentity {
  customer_id?: string | null;
  order_no?: string | number | null;
  item_id?: string | null;
  last_invoice_date?: string | null;
  invoice_date?: string | null;
  qty_ordered?: number | string | null;
  extended_price?: number | string | null;
  flags?: unknown;
}

// SQL log_spiff_line_edit mirrors this format: customer|order|[oe_line_no|]item|date|qty|price.
// Nulls are empty; dates are YYYY-MM-DD; numeric trailing fractional zeros are removed.
// No PO, description, writing rep or generated UUID participates in identity.
function numericText(value: number | string | null | undefined): string {
  if (value == null) return "";
  const text = String(value);
  const normalized = text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  return Number(normalized) === 0 ? "0" : normalized;
}

export function lineKey(line: LineIdentity): string {
  const flags = line.flags;
  const oeLine = flags && typeof flags === "object" && "oe_line_no" in flags ? flags.oe_line_no : null;
  return [
    line.customer_id ?? "",
    line.order_no ?? "",
    ...(oeLine == null || oeLine === "" ? [] : [String(oeLine)]),
    line.item_id ?? "",
    (line.last_invoice_date ?? line.invoice_date ?? "").slice(0, 10),
    numericText(line.qty_ordered),
    numericText(line.extended_price),
  ].join("|");
}