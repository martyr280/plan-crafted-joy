export interface LineIdentity {
  customer_id?: string | null;
  order_no?: string | number | null;
  item_id?: string | null;
  last_invoice_date?: string | null;
  invoice_date?: string | null;
  qty_ordered?: number | string | null;
  extended_price?: number | string | null;
  flags?: unknown;
  po_no?: string | null;
  item_desc?: string | null;
  writing_rep?: string | null;
}

// SQL log_spiff_line_edit mirrors this format: customer|order|[oe_line_no|]item|date|qty|price.
// Nulls are empty; dates are YYYY-MM-DD; numeric trailing fractional zeros are removed.
// No PO, description, writing rep or generated UUID participates in identity.
function numericText(value: number | string | null | undefined): string {
  if (value == null) return "";
  let text = String(value);
  // Expand JS exponent notation to PostgreSQL numeric text without rounding.
  if (/e/i.test(text)) {
    const [mantissa, exponent] = text.toLowerCase().split("e");
    const negative = mantissa.startsWith("-");
    const unsigned = negative ? mantissa.slice(1) : mantissa;
    const [whole, fraction = ""] = unsigned.split(".");
    const digits = whole + fraction;
    const position = whole.length + Number(exponent);
    text = (negative ? "-" : "") + (position <= 0
      ? "0." + "0".repeat(-position) + digits
      : position >= digits.length ? digits + "0".repeat(position - digits.length)
      : digits.slice(0, position) + "." + digits.slice(position));
  }
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