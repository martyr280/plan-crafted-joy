// PDF templates for the Pricer module. React-pdf renders in the Worker runtime.
import React from "react";
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { LEVEL_LABEL, type PricerRow, type PriceLevel } from "./pricer.server";

const COLOR_BORDER = "#cccccc";
const COLOR_HEADER = "#1f2937";
const COLOR_HEADER_TEXT = "#ffffff";
const COLOR_MUTED = "#666666";

const landscapeStyles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 40, paddingHorizontal: 24, fontSize: 8, fontFamily: "Helvetica" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 10, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: COLOR_BORDER },
  title: { fontSize: 14, fontWeight: 700 },
  subtitle: { fontSize: 8, color: COLOR_MUTED, marginTop: 2 },
  table: { borderWidth: 1, borderColor: COLOR_BORDER },
  thead: { flexDirection: "row", backgroundColor: COLOR_HEADER },
  th: { color: COLOR_HEADER_TEXT, padding: 4, fontSize: 8, fontWeight: 700 },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: COLOR_BORDER },
  td: { padding: 4, fontSize: 8 },
  tdRight: { padding: 4, fontSize: 8, textAlign: "right" },
  finishes: { color: COLOR_MUTED, fontSize: 7, marginTop: 1 },
  footer: { position: "absolute", bottom: 16, left: 24, right: 24, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: COLOR_MUTED },
});

const portraitStyles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 40, paddingHorizontal: 32, fontSize: 10, fontFamily: "Helvetica" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: COLOR_BORDER },
  title: { fontSize: 16, fontWeight: 700 },
  subtitle: { fontSize: 9, color: COLOR_MUTED, marginTop: 2 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: COLOR_BORDER, paddingVertical: 8, alignItems: "center" },
  imageCell: { width: 80, height: 80, marginRight: 12, justifyContent: "center", alignItems: "center", borderWidth: 0.5, borderColor: COLOR_BORDER },
  image: { width: 76, height: 76, objectFit: "contain" },
  imagePlaceholder: { fontSize: 7, color: COLOR_MUTED },
  bodyCell: { flex: 1 },
  short: { fontSize: 12, fontWeight: 700 },
  desc: { fontSize: 9, marginTop: 2 },
  finishes: { fontSize: 8, color: COLOR_MUTED, marginTop: 4 },
  priceCell: { width: 90, alignItems: "flex-end" },
  priceLabel: { fontSize: 8, color: COLOR_MUTED },
  price: { fontSize: 14, fontWeight: 700, marginTop: 2 },
  footer: { position: "absolute", bottom: 16, left: 32, right: 32, flexDirection: "row", justifyContent: "space-between", fontSize: 8, color: COLOR_MUTED },
});

function fmtMoney(v: number | null): string {
  if (v == null) return "—";
  return `$${Number(v).toFixed(2)}`;
}

const COL_WIDTHS_LANDSCAPE = ["10%", "10%", "26%", "18%", "6%", "6%", "6%", "6%", "6%", "6%"];

function LandscapeDoc({ rows, name, generatedAt }: { rows: PricerRow[]; name: string; generatedAt: string }) {
  return (
    <Document>
      <Page size="LETTER" orientation="landscape" style={landscapeStyles.page}>
        <View style={landscapeStyles.header} fixed>
          <View>
            <Text style={landscapeStyles.title}>NDI Office Furniture — Pricer</Text>
            <Text style={landscapeStyles.subtitle}>{name} · All published levels</Text>
          </View>
          <View>
            <Text style={landscapeStyles.subtitle}>Effective {generatedAt}</Text>
          </View>
        </View>

        <View style={landscapeStyles.table}>
          <View style={landscapeStyles.thead} fixed>
            {["Short PN", "Full PN", "Description", "Finishes", "List", "L5", "L4", "L3", "L2", "L1"].map((h, i) => (
              <Text key={h} style={[landscapeStyles.th, { width: COL_WIDTHS_LANDSCAPE[i], textAlign: i >= 4 ? "right" : "left" }]}>{h}</Text>
            ))}
          </View>
          {rows.map((r) => (
            <View key={r.item_short} style={landscapeStyles.tr} wrap={false}>
              <Text style={[landscapeStyles.td, { width: COL_WIDTHS_LANDSCAPE[0] }]}>{r.item_short}</Text>
              <Text style={[landscapeStyles.td, { width: COL_WIDTHS_LANDSCAPE[1] }]}>{r.rep_item}</Text>
              <Text style={[landscapeStyles.td, { width: COL_WIDTHS_LANDSCAPE[2] }]}>{r.description ?? "—"}</Text>
              <Text style={[landscapeStyles.td, { width: COL_WIDTHS_LANDSCAPE[3] }]}>{r.finishes.join(" · ") || "—"}</Text>
              <Text style={[landscapeStyles.tdRight, { width: COL_WIDTHS_LANDSCAPE[4] }]}>{fmtMoney(r.list_price)}</Text>
              <Text style={[landscapeStyles.tdRight, { width: COL_WIDTHS_LANDSCAPE[5] }]}>{fmtMoney(r.l5)}</Text>
              <Text style={[landscapeStyles.tdRight, { width: COL_WIDTHS_LANDSCAPE[6] }]}>{fmtMoney(r.l4)}</Text>
              <Text style={[landscapeStyles.tdRight, { width: COL_WIDTHS_LANDSCAPE[7] }]}>{fmtMoney(r.l3)}</Text>
              <Text style={[landscapeStyles.tdRight, { width: COL_WIDTHS_LANDSCAPE[8] }]}>{fmtMoney(r.l2)}</Text>
              <Text style={[landscapeStyles.tdRight, { width: COL_WIDTHS_LANDSCAPE[9] }]}>{fmtMoney(r.l1)}</Text>
            </View>
          ))}
        </View>

        <View style={landscapeStyles.footer} fixed>
          <Text>NDI Office Furniture · Confidential</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

function PortraitDoc({ rows, name, level, generatedAt }: { rows: PricerRow[]; name: string; level: PriceLevel; generatedAt: string }) {
  const levelKey = level === "list" ? "list_price" : (level as "l1" | "l2" | "l3" | "l4" | "l5");
  return (
    <Document>
      <Page size="LETTER" style={portraitStyles.page}>
        <View style={portraitStyles.header} fixed>
          <View>
            <Text style={portraitStyles.title}>NDI Office Furniture — Pricer</Text>
            <Text style={portraitStyles.subtitle}>{name} · {LEVEL_LABEL[level]} pricing</Text>
          </View>
          <View>
            <Text style={portraitStyles.subtitle}>Effective {generatedAt}</Text>
          </View>
        </View>

        {rows.map((r) => {
          const price = (r as any)[levelKey] as number | null;
          return (
            <View key={r.item_short} style={portraitStyles.row} wrap={false}>
              <View style={portraitStyles.imageCell}>
                {r.image_url ? <Image style={portraitStyles.image} src={r.image_url} /> : <Text style={portraitStyles.imagePlaceholder}>No image</Text>}
              </View>
              <View style={portraitStyles.bodyCell}>
                <Text style={portraitStyles.short}>{r.item_short}</Text>
                <Text style={portraitStyles.desc}>{r.description ?? "—"}</Text>
                {r.finishes.length > 0 && <Text style={portraitStyles.finishes}>Finishes: {r.finishes.join(" · ")}</Text>}
              </View>
              <View style={portraitStyles.priceCell}>
                <Text style={portraitStyles.priceLabel}>{LEVEL_LABEL[level]}</Text>
                <Text style={portraitStyles.price}>{fmtMoney(price)}</Text>
              </View>
            </View>
          );
        })}

        <View style={portraitStyles.footer} fixed>
          <Text>NDI Office Furniture · Confidential</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderPricerPdf(opts: {
  rows: PricerRow[];
  name: string;
  orientation: "landscape" | "portrait";
  level: PriceLevel | null;
}): Promise<Buffer> {
  const generatedAt = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const doc = opts.orientation === "landscape"
    ? <LandscapeDoc rows={opts.rows} name={opts.name} generatedAt={generatedAt} />
    : <PortraitDoc rows={opts.rows} name={opts.name} level={opts.level ?? "list"} generatedAt={generatedAt} />;
  return await renderToBuffer(doc);
}
