// SIF/XML parser for Orders and Logistics imports.
// SIF convention supported: pipe-delimited rows with a leading record-type code.
//   Orders:     ORD|<po_number>|<customer_id>|<customer_name>|<source>
//               LIN|<po_number>|<sku>|<qty>|<price>
//   Loads:      LOD|<route_code>|<truck_id>|<driver_name>|<departure_date YYYY-MM-DD>
//               REF|<route_code>|<p21_order_id>
// Lines beginning with '#' or empty are ignored. Header lines starting with 'H|' are ignored.
//
// XML convention supported (orders):
//   <orders><order po="PO-123" customerId="C1" customerName="Acme" source="email">
//     <line sku="ABC" qty="2" price="19.99"/></order></orders>
// XML convention supported (loads):
//   <loads><load route="RT-7" truck="T-12" driver="Jane" departure="2026-05-10">
//     <orderRef p21Id="SO-9"/></load></loads>

export type ImportKind = "orders" | "loads";

export type ParsedOrder = {
  po_number: string;
  customer_id: string | null;
  customer_name: string;
  source: string;
  line_items: { sku: string; qty: number; price: number }[];
};

export type ParsedLoad = {
  route_code: string;
  truck_id: string | null;
  driver_name: string | null;
  departure_date: string | null;
  orders: { p21_order_id: string }[];
};

export type RowError = { line: number; message: string };

export type ParseResult<T> = {
  kind: ImportKind;
  records: T[];
  errors: RowError[];
};

function num(v: string | null | undefined, line: number, field: string, errors: RowError[]): number {
  const n = Number((v ?? "").trim());
  if (!Number.isFinite(n)) {
    errors.push({ line, message: `Invalid number for ${field}: "${v}"` });
    return 0;
  }
  return n;
}

export function detectKind(text: string): ImportKind | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    if (/<orders[\s>]/i.test(trimmed)) return "orders";
    if (/<loads[\s>]/i.test(trimmed)) return "loads";
    return null;
  }
  if (/^\s*ORD\|/im.test(trimmed)) return "orders";
  if (/^\s*LOD\|/im.test(trimmed)) return "loads";
  return null;
}

export function parseSifText(text: string): ParseResult<ParsedOrder | ParsedLoad> {
  const kind = detectKind(text);
  if (!kind) {
    return { kind: "orders", records: [], errors: [{ line: 0, message: "Could not detect format. Expected SIF (ORD|/LOD|) or XML (<orders>/<loads>)." }] };
  }
  return kind === "orders"
    ? parseOrders(text)
    : parseLoads(text);
}

function parseOrders(text: string): ParseResult<ParsedOrder> {
  const errors: RowError[] = [];
  const orders = new Map<string, ParsedOrder>();
  const trimmed = text.trim();

  if (trimmed.startsWith("<")) {
    try {
      const doc = new DOMParser().parseFromString(trimmed, "application/xml");
      const parseErr = doc.getElementsByTagName("parsererror")[0];
      if (parseErr) {
        errors.push({ line: 0, message: "Invalid XML: " + parseErr.textContent?.slice(0, 200) });
        return { kind: "orders", records: [], errors };
      }
      const orderEls = Array.from(doc.getElementsByTagName("order"));
      orderEls.forEach((el, i) => {
        const po = el.getAttribute("po")?.trim();
        const customer = el.getAttribute("customerName")?.trim();
        if (!po) return errors.push({ line: i + 1, message: "Missing po attribute" });
        if (!customer) return errors.push({ line: i + 1, message: `Order ${po}: missing customerName` });
        const rec: ParsedOrder = {
          po_number: po,
          customer_id: el.getAttribute("customerId")?.trim() || null,
          customer_name: customer,
          source: el.getAttribute("source")?.trim() || "import",
          line_items: [],
        };
        Array.from(el.getElementsByTagName("line")).forEach((ln, j) => {
          const sku = ln.getAttribute("sku")?.trim();
          if (!sku) { errors.push({ line: i + 1, message: `Order ${po} line ${j + 1}: missing sku` }); return; }
          rec.line_items.push({
            sku,
            qty: num(ln.getAttribute("qty"), i + 1, `${po}.qty`, errors),
            price: num(ln.getAttribute("price"), i + 1, `${po}.price`, errors),
          });
        });
        orders.set(po, rec);
      });
    } catch (e: any) {
      errors.push({ line: 0, message: "XML parse error: " + (e.message ?? String(e)) });
    }
    return { kind: "orders", records: [...orders.values()], errors };
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    const s = raw.trim();
    if (!s || s.startsWith("#") || s.startsWith("H|")) return;
    const cols = s.split("|");
    const tag = cols[0];
    if (tag === "ORD") {
      const [, po, cid, cname, source] = cols;
      if (!po) return errors.push({ line, message: "ORD missing po_number" });
      if (!cname) return errors.push({ line, message: `ORD ${po}: missing customer_name` });
      orders.set(po, {
        po_number: po,
        customer_id: cid?.trim() || null,
        customer_name: cname,
        source: source?.trim() || "import",
        line_items: [],
      });
    } else if (tag === "LIN") {
      const [, po, sku, qty, price] = cols;
      const ord = orders.get(po);
      if (!ord) return errors.push({ line, message: `LIN references unknown PO ${po}` });
      if (!sku) return errors.push({ line, message: `LIN missing sku for PO ${po}` });
      ord.line_items.push({
        sku,
        qty: num(qty, line, "qty", errors),
        price: num(price, line, "price", errors),
      });
    } else {
      errors.push({ line, message: `Unknown record type "${tag}"` });
    }
  });

  return { kind: "orders", records: [...orders.values()], errors };
}

function parseLoads(text: string): ParseResult<ParsedLoad> {
  const errors: RowError[] = [];
  const loads = new Map<string, ParsedLoad>();
  const trimmed = text.trim();

  if (trimmed.startsWith("<")) {
    try {
      const doc = new DOMParser().parseFromString(trimmed, "application/xml");
      const parseErr = doc.getElementsByTagName("parsererror")[0];
      if (parseErr) {
        errors.push({ line: 0, message: "Invalid XML: " + parseErr.textContent?.slice(0, 200) });
        return { kind: "loads", records: [], errors };
      }
      Array.from(doc.getElementsByTagName("load")).forEach((el, i) => {
        const route = el.getAttribute("route")?.trim();
        if (!route) return errors.push({ line: i + 1, message: "Load missing route" });
        const rec: ParsedLoad = {
          route_code: route,
          truck_id: el.getAttribute("truck")?.trim() || null,
          driver_name: el.getAttribute("driver")?.trim() || null,
          departure_date: el.getAttribute("departure")?.trim() || null,
          orders: [],
        };
        Array.from(el.getElementsByTagName("orderRef")).forEach((r) => {
          const id = r.getAttribute("p21Id")?.trim();
          if (id) rec.orders.push({ p21_order_id: id });
        });
        loads.set(route, rec);
      });
    } catch (e: any) {
      errors.push({ line: 0, message: "XML parse error: " + (e.message ?? String(e)) });
    }
    return { kind: "loads", records: [...loads.values()], errors };
  }

  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    const s = raw.trim();
    if (!s || s.startsWith("#") || s.startsWith("H|")) return;
    const cols = s.split("|");
    const tag = cols[0];
    if (tag === "LOD") {
      const [, route, truck, driver, departure] = cols;
      if (!route) return errors.push({ line, message: "LOD missing route_code" });
      if (departure && !/^\d{4}-\d{2}-\d{2}$/.test(departure.trim())) {
        errors.push({ line, message: `LOD ${route}: departure must be YYYY-MM-DD` });
      }
      loads.set(route, {
        route_code: route,
        truck_id: truck?.trim() || null,
        driver_name: driver?.trim() || null,
        departure_date: departure?.trim() || null,
        orders: [],
      });
    } else if (tag === "REF") {
      const [, route, p21] = cols;
      const lod = loads.get(route);
      if (!lod) return errors.push({ line, message: `REF references unknown route ${route}` });
      if (!p21) return errors.push({ line, message: `REF missing p21_order_id for route ${route}` });
      lod.orders.push({ p21_order_id: p21 });
    } else {
      errors.push({ line, message: `Unknown record type "${tag}"` });
    }
  });

  return { kind: "loads", records: [...loads.values()], errors };
}
