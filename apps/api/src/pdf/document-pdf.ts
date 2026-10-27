import { amountInWords, formatPaise } from "@stockpilot/shared";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";

/**
 * Printable A4 PDFs of invoices, credit and debit notes, purchase bills and
 * payment receipts. Costs are never printed. DejaVu Sans is bundled because the
 * PDF standard fonts have no rupee sign.
 */

const FONT = fileURLToPath(new URL("../../assets/fonts/DejaVuSans.ttf", import.meta.url));
const FONT_BOLD = fileURLToPath(new URL("../../assets/fonts/DejaVuSans-Bold.ttf", import.meta.url));

export interface PdfDocument {
  type: string;
  status: string;
  number: string;
  businessDate: Date;
  gstApplied: boolean;
  interState: boolean;
  taxableTotal: number;
  taxTotal: number;
  otherCharges: number;
  roundOff: number;
  total: number;
  paidAmount: number;
  reason: string | null;
  notes: string | null;
  cancelReason: string | null;
  branch: { name: string; address: string | null; phone: string | null; gstin: string | null };
  party: { name: string; phone: string | null; gstin: string | null; address: string | null; stateCode: string | null } | null;
  toBranch: { name: string } | null;
  sourceDocument: { number: string; businessDate: Date } | null;
  createdBy: { name: string };
  lines: {
    quantity: number;
    unitPrice: number;
    discount: number;
    gstRateBps: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    lineTotal: number;
    damaged?: boolean;
    variant: { name: string; product: { name: string; hsnCode: string | null } };
    serials: { serialUnit: { imei: string; imei2: string | null } }[];
  }[];
  tenders: { method: string; amount: number; reference: string | null; party?: { name: string } | null }[];
  allocationsFrom: { amount: number; to: { id: string; number: string } }[];
  id: string;
}

const TITLES: Record<string, (gst: boolean) => string> = {
  SALE: (gst) => (gst ? "Tax Invoice" : "Bill"),
  SALE_RETURN: (gst) => (gst ? "Credit Note" : "Return Receipt"),
  PURCHASE: () => "Purchase Bill",
  PURCHASE_RETURN: () => "Debit Note",
  RECEIPT: () => "Payment Receipt",
  PAYMENT: () => "Payment Voucher",
  EXPENSE: () => "Expense Voucher",
  OPENING_STOCK: () => "Opening Stock",
  ADJUSTMENT: () => "Stock Adjustment",
  TRANSFER: () => "Stock Transfer",
  DAY_CLOSE: () => "Day Close",
};

const METHOD_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", BANK: "Bank transfer", FINANCE: "EMI / finance" };
const rs = (p: number) => formatPaise(p);
const iso = (d: Date) => d.toISOString().slice(0, 10);

interface Column {
  label: string;
  width: number;
  align?: "left" | "right";
  value: (l: PdfDocument["lines"][number], i: number) => string;
}

export function renderDocumentPdf(doc: PdfDocument, businessName: string): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", margin: 40, info: { Title: `${doc.number}`, Producer: "StockPilot" } });
  pdf.registerFont("body", FONT);
  pdf.registerFont("bold", FONT_BOLD);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  const left = pdf.page.margins.left;
  const width = pdf.page.width - left - pdf.page.margins.right;
  const bottom = () => pdf.page.height - pdf.page.margins.bottom;
  const title = (TITLES[doc.type] ?? (() => doc.type))(doc.gstApplied);
  const priced = ["SALE", "SALE_RETURN", "PURCHASE", "PURCHASE_RETURN"].includes(doc.type);

  // Header: the shop on the left, the document on the right.
  const top = pdf.y;
  pdf.font("bold").fontSize(16).text(businessName, left, top, { width: width * 0.6 });
  pdf.font("body").fontSize(9);
  for (const line of [doc.branch.name, doc.branch.address, doc.branch.phone && `Phone ${doc.branch.phone}`, doc.gstApplied && doc.branch.gstin && `GSTIN ${doc.branch.gstin}`]) {
    if (line) pdf.text(line, { width: width * 0.6 });
  }
  const leftEnd = pdf.y;
  pdf.font("bold").fontSize(14).text(title, left + width * 0.6, top, { width: width * 0.4, align: "right" });
  pdf.font("body").fontSize(9);
  pdf.text(doc.number, { width: width * 0.4, align: "right" });
  pdf.text(`Date ${iso(doc.businessDate)}`, { width: width * 0.4, align: "right" });
  if (doc.sourceDocument) pdf.text(`Against ${doc.sourceDocument.number} of ${iso(doc.sourceDocument.businessDate)}`, { width: width * 0.4, align: "right" });
  if (doc.gstApplied && doc.party?.stateCode) pdf.text(`Place of supply: state ${doc.party.stateCode}`, { width: width * 0.4, align: "right" });
  pdf.y = Math.max(leftEnd, pdf.y) + 10;
  pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).lineWidth(0.5).strokeColor("#999999").stroke();
  pdf.moveDown(0.5);

  if (doc.status === "CANCELLED") {
    pdf.font("bold").fontSize(11).fillColor("#a12626").text(`CANCELLED${doc.cancelReason ? `: ${doc.cancelReason}` : ""}`, left, pdf.y, { width });
    pdf.fillColor("#000000").moveDown(0.5);
  }

  if (doc.party) {
    const to = ["SALE", "SALE_RETURN", "RECEIPT"].includes(doc.type) ? (doc.type === "RECEIPT" ? "Received from" : "Bill to") : "Supplier";
    pdf.font("body").fontSize(8).fillColor("#555555").text(to, left, pdf.y);
    pdf.fillColor("#000000").font("bold").fontSize(10).text(doc.party.name);
    pdf.font("body").fontSize(9);
    for (const line of [doc.party.phone, doc.party.address, doc.party.gstin && `GSTIN ${doc.party.gstin}`]) if (line) pdf.text(line);
    pdf.moveDown(0.5);
  }
  if (doc.toBranch) pdf.font("body").fontSize(10).text(`${doc.branch.name} → ${doc.toBranch.name}`).moveDown(0.5);
  if (doc.reason) pdf.font("body").fontSize(9).text(doc.type === "PURCHASE" ? `Supplier bill ${doc.reason}` : `Reason: ${doc.reason}`).moveDown(0.5);

  if (doc.lines.length > 0) {
    const gst = doc.gstApplied && priced;
    const columns: Column[] = [
      { label: "#", width: 18, value: (_l, i) => String(i + 1) },
      {
        label: "Item",
        width: 0,
        value: (l) => {
          const ids = l.serials.map((s) => (s.serialUnit.imei2 ? `${s.serialUnit.imei} / ${s.serialUnit.imei2}` : s.serialUnit.imei));
          return [`${l.variant.product.name} · ${l.variant.name}${l.damaged ? " (damaged)" : ""}`, ids.length ? `IMEI ${ids.join(", ")}` : ""].filter(Boolean).join("\n");
        },
      },
      ...(gst ? [{ label: "HSN", width: 44, value: (l: PdfDocument["lines"][number]) => l.variant.product.hsnCode ?? "" }] : []),
      { label: "Qty", width: 30, align: "right", value: (l) => String(l.quantity) },
      ...(priced
        ? ([
            { label: "Rate", width: 66, align: "right", value: (l) => rs(l.unitPrice) },
            { label: "Disc.", width: 52, align: "right", value: (l) => (l.discount ? rs(l.discount) : "") },
          ] as Column[])
        : []),
      ...(gst
        ? ([
            { label: "Taxable", width: 70, align: "right", value: (l) => rs(l.taxableValue) },
            {
              label: "GST",
              width: 76,
              align: "right",
              value: (l) => `${l.gstRateBps / 100}%\n${l.igst ? `IGST ${rs(l.igst)}` : `${rs(l.cgst + l.sgst)}`}`,
            },
          ] as Column[])
        : []),
      ...(priced ? ([{ label: "Amount", width: 72, align: "right", value: (l) => rs(l.lineTotal) }] as Column[]) : []),
    ];
    const fixed = columns.reduce((a, c) => a + c.width, 0);
    columns.find((c) => c.label === "Item")!.width = width - fixed;

    const header = () => {
      const y = pdf.y;
      pdf.rect(left, y - 2, width, 16).fillColor("#eeeeee").fill().fillColor("#000000");
      let x = left;
      pdf.font("bold").fontSize(8);
      for (const c of columns) {
        pdf.text(c.label, x + 2, y + 1, { width: c.width - 4, align: c.align ?? "left", lineBreak: false });
        x += c.width;
      }
      pdf.y = y + 18;
    };
    header();
    pdf.font("body").fontSize(8.5);
    doc.lines.forEach((l, i) => {
      const heights = columns.map((c) => pdf.heightOfString(c.value(l, i), { width: c.width - 4 }));
      const h = Math.max(...heights) + 6;
      if (pdf.y + h > bottom() - 120) {
        pdf.addPage();
        header();
        pdf.font("body").fontSize(8.5);
      }
      const y = pdf.y;
      let x = left;
      for (const c of columns) {
        pdf.text(c.value(l, i), x + 2, y + 2, { width: c.width - 4, align: c.align ?? "left" });
        x += c.width;
      }
      pdf.y = y + h;
      pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).lineWidth(0.3).strokeColor("#cccccc").stroke();
    });
    pdf.moveDown(0.5);
  }

  // Totals, right aligned.
  const rows: [string, string, boolean?][] = [];
  if (priced && doc.gstApplied) {
    rows.push(["Taxable value", rs(doc.taxableTotal)]);
    const cgst = doc.lines.reduce((a, l) => a + l.cgst, 0);
    const sgst = doc.lines.reduce((a, l) => a + l.sgst, 0);
    const igst = doc.lines.reduce((a, l) => a + l.igst, 0);
    if (igst) rows.push(["IGST", rs(igst)]);
    if (cgst || sgst) rows.push(["CGST", rs(cgst)], ["SGST", rs(sgst)]);
  }
  if (doc.otherCharges && doc.type === "PURCHASE") rows.push(["Other charges", rs(doc.otherCharges)]);
  if (doc.roundOff) rows.push(["Round off", rs(doc.roundOff)]);
  if (doc.total) rows.push(["Total", rs(doc.total), true]);
  if (doc.otherCharges && doc.type === "RECEIPT") rows.push(["Of which fees kept by the financier", rs(doc.otherCharges)]);
  for (const t of doc.tenders) {
    const verb = ["SALE_RETURN"].includes(doc.type) ? "Refunded" : doc.type === "PURCHASE_RETURN" ? "Refund received" : "Paid";
    const by = t.method === "FINANCE" && t.party ? `${METHOD_LABEL.FINANCE} (${t.party.name})` : (METHOD_LABEL[t.method] ?? t.method);
    rows.push([`${verb} by ${by}${t.reference ? ` · ${t.reference}` : ""}`, rs(t.amount)]);
  }
  if (["SALE", "PURCHASE"].includes(doc.type) && doc.status === "POSTED" && doc.paidAmount < doc.total) {
    rows.push(["Balance due", rs(doc.total - doc.paidAmount), true]);
  }
  if (pdf.y + rows.length * 14 + 60 > bottom()) pdf.addPage();
  for (const [k, v, strong] of rows) {
    const y = pdf.y;
    pdf.font(strong ? "bold" : "body").fontSize(strong ? 10.5 : 9);
    pdf.text(k, left + width * 0.35, y, { width: width * 0.45, align: "right" });
    pdf.text(v, left + width * 0.8, y, { width: width * 0.2, align: "right" });
    pdf.y = y + (strong ? 15 : 13);
  }
  if (doc.total) pdf.moveDown(0.3).font("body").fontSize(8.5).text(amountInWords(doc.total), left, pdf.y, { width });

  const settles = doc.allocationsFrom.filter((a) => a.to.id !== doc.id);
  if (settles.length) pdf.moveDown(0.3).fontSize(8.5).text(`Settles: ${settles.map((a) => `${a.to.number} (${rs(a.amount)})`).join(", ")}`, { width });
  if (doc.notes) pdf.moveDown(0.3).fontSize(8.5).text(doc.notes, { width });

  pdf.moveDown(1.5).fontSize(7.5).fillColor("#555555");
  pdf.text(`Entered by ${doc.createdBy.name}. This is a computer-generated document.`, left, pdf.y, { width });
  pdf.end();
  return done;
}
