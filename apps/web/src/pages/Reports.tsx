import { roleHas, type Permission } from "@stockpilot/shared";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Branch, Confidence } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText } from "../components/Field";
import { ConfidenceTag, label, rupees } from "../components/inventory";
import { RangePicker, ReportTable, Stat, pct, presets, rate, type Column, type ColumnHelpers, type Range } from "../components/reports";
import { useApi } from "../useApi";

const TABS: { key: string; label: string; needs: Permission[]; ranged: boolean }[] = [
  { key: "sales", label: "Sales", needs: ["report.view"], ranged: true },
  { key: "profit", label: "Profit", needs: ["report.view", "cost.view"], ranged: true },
  { key: "collections", label: "Collections", needs: ["report.view"], ranged: true },
  { key: "stock", label: "Stock", needs: ["stock.view"], ranged: false },
  { key: "dues", label: "Dues", needs: ["report.view"], ranged: false },
  { key: "gst", label: "GST", needs: ["report.view"], ranged: true },
  { key: "branches", label: "Branches", needs: ["report.view"], ranged: true },
];

export function Reports() {
  const { businessId, role } = useBusiness();
  const tabs = TABS.filter((t) => t.needs.every((p) => roleHas(role!, p)));
  const [params, setParams] = useSearchParams();
  const tab = tabs.find((t) => t.key === params.get("tab")) ?? tabs[0];
  const month = presets().find((p) => p.key === "month")!;
  const [range, setRange] = useState<Range>({ from: params.get("from") ?? month.from, to: params.get("to") ?? month.to });
  const [branchId, setBranchId] = useState(params.get("branchId") ?? "");
  const { data: branchData } = useApi<{ branches: Branch[] }>(`/businesses/${businessId}/branches`);
  const branches = branchData?.branches ?? [];

  if (!tab) return <p className="muted">Reports aren't available for your role.</p>;

  const query = new URLSearchParams({ ...(tab.ranged ? range : {}), ...(branchId ? { branchId } : {}) }).toString();
  const path = `/businesses/${businessId}/reports/${tab.key}?${query}`;
  const file = `${tab.key}-${tab.ranged ? `${range.from}-to-${range.to}` : "today"}`;
  const select = (key: string) => setParams({ tab: key, ...range, ...(branchId ? { branchId } : {}) });

  return (
    <>
      <h1>Reports</h1>
      <div className="tabs no-print" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={t.key === tab.key} className={t.key === tab.key ? "" : "secondary"} onClick={() => select(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="row no-print">
        {tab.ranged && <RangePicker value={range} onChange={setRange} />}
        {branches.length > 1 && (
          <label className="field">
            <span>Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">All my branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="secondary" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {tab.key === "sales" && <SalesReport path={path} file={file} />}
      {tab.key === "profit" && <ProfitReport path={path} file={file} />}
      {tab.key === "collections" && <CollectionsReport path={path} file={file} />}
      {tab.key === "stock" && <StockReport path={path} file={file} />}
      {tab.key === "dues" && <DuesReport path={path} file={file} />}
      {tab.key === "gst" && <GstReport path={path} file={file} />}
      {tab.key === "branches" && <BranchesReport path={path} file={file} />}
    </>
  );
}

interface ReportProps {
  path: string;
  file: string;
}

function useReport<T>(path: string) {
  const { data, error } = useApi<T>(path);
  return { data, error: error ? <ErrorText error={error} /> : null };
}

type Named = { name: string; units: number; netSales: number };

function SalesReport({ path, file }: ReportProps) {
  const { data, error } = useReport<{
    totals: { invoices: number; units: number; netSales: number; tax: number; billed: number; paidAtCounter: number; onCredit: number };
    cancelled: { count: number; total: number };
    byDay: { date: string; invoices: number; billed: number; netSales: number }[];
    byBranch: { name: string; invoices: number; billed: number; netSales: number }[];
    byBrand: Named[];
    byCategory: Named[];
    topProducts: Named[];
  }>(path);
  if (!data) return error;
  const t = data.totals;
  const named = (h: ColumnHelpers<Named>) => [h.num("Units", (r) => r.units), h.money("Net sales", (r) => r.netSales)];
  return (
    <>
      <div className="grid">
        <Stat label="Billed" value={rupees(t.billed)} note={`${t.invoices} bills · ${t.units} items`} />
        <Stat label="Net sales (before GST)" value={rupees(t.netSales)} note={t.tax ? `GST ${rupees(t.tax)}` : undefined} />
        <Stat label="Paid at the counter" value={rupees(t.paidAtCounter)} />
        <Stat label="Left on credit" value={rupees(t.onCredit)} />
      </div>
      {data.cancelled.count > 0 && (
        <p className="muted">
          {data.cancelled.count} cancelled bill{data.cancelled.count === 1 ? "" : "s"} ({rupees(data.cancelled.total)}) not counted.
        </p>
      )}
      <ReportTable
        title="By day"
        file={`${file}-by-day`}
        rows={data.byDay}
        columns={(h) => [{ label: "Date", cell: (r) => r.date }, h.num("Bills", (r) => r.invoices), h.money("Net sales", (r) => r.netSales), h.money("Billed", (r) => r.billed)]}
      />
      {data.byBranch.length > 1 && (
        <ReportTable
          title="By branch"
          file={`${file}-by-branch`}
          rows={data.byBranch}
          columns={(h) => [{ label: "Branch", cell: (r) => r.name }, h.num("Bills", (r) => r.invoices), h.money("Net sales", (r) => r.netSales), h.money("Billed", (r) => r.billed)]}
        />
      )}
      <ReportTable title="Top products" file={`${file}-top-products`} rows={data.topProducts} columns={(h) => [{ label: "Product", cell: (r) => r.name }, ...named(h)]} />
      <ReportTable title="By brand" file={`${file}-by-brand`} rows={data.byBrand} columns={(h) => [{ label: "Brand", cell: (r) => r.name }, ...named(h)]} />
      <ReportTable title="By category" file={`${file}-by-category`} rows={data.byCategory} columns={(h) => [{ label: "Category", cell: (r) => r.name }, ...named(h)]} />
    </>
  );
}

interface Bucket {
  lines: number;
  units: number;
  revenue: number;
  cost: number;
  profit: number;
}
interface ProfitGroup {
  name: string;
  verified: Bucket;
  estimated: Bucket;
  unknown: { lines: number; units: number; revenue: number };
}

function ProfitReport({ path, file }: ReportProps) {
  const { data, error } = useReport<ProfitGroup & {
    expenses: { total: number; byCategory: { category: string; total: number }[] };
    otherCosts: { stockLoss: number; priceVariance: number; cashShortage: number };
    verifiedAfterExpenses: number;
    byBrand: ProfitGroup[];
    byProduct: ProfitGroup[];
    missingCosts: { documentId: string; number: string; date: string; product: string; quantity: number; revenue: number; serials: string | null }[];
  }>(path);
  if (!data) return error;
  const { verified, estimated, unknown, otherCosts } = data;
  const groupCols = (name: string) => (h: ColumnHelpers<ProfitGroup>) => [
    { label: name, cell: (r: ProfitGroup) => r.name },
    h.money("Verified profit", (r) => r.verified.profit),
    { label: "Margin", cell: (r: ProfitGroup) => pct(r.verified.profit, r.verified.revenue), num: true },
    h.money("Estimated profit", (r) => r.estimated.profit),
    h.money("Sales with unknown cost", (r) => r.unknown.revenue),
  ];
  return (
    <>
      <p className="muted">
        Profit is shown in three separate parts and never added together. Verified uses costs from purchase bills; estimated uses costs typed in for opening
        stock; for unknown-cost sales only the sale value is known.
      </p>
      <div className="grid">
        <Stat label="Verified profit" value={rupees(verified.profit)} note={`${pct(verified.profit, verified.revenue)} on ${rupees(verified.revenue)} sales`} />
        <Stat
          label="Estimated profit"
          tone="estimated"
          value={rupees(estimated.profit)}
          note={`${pct(estimated.profit, estimated.revenue)} on ${rupees(estimated.revenue)} sales`}
        />
        <Stat label="Sales with unknown cost" tone="unknown" value={rupees(unknown.revenue)} note={`${unknown.units} item${unknown.units === 1 ? "" : "s"}, profit not known`} />
        <Stat label="Verified profit after expenses" value={rupees(data.verifiedAfterExpenses)} note="Estimated profit not included" />
      </div>
      <ReportTable
        title="Expenses and losses"
        file={`${file}-expenses`}
        rows={[
          ...data.expenses.byCategory.map((e) => ({ name: label(e.category), amount: e.total })),
          { name: "Stock written off", amount: otherCosts.stockLoss },
          { name: "Cost differences on cancellations", amount: otherCosts.priceVariance },
          { name: "Cash shortage (excess if negative)", amount: otherCosts.cashShortage },
        ].filter((r) => r.amount !== 0)}
        empty="No expenses or losses in this period."
        columns={(h) => [{ label: "Item", cell: (r) => r.name }, h.money("Amount", (r) => r.amount)]}
      />
      <ReportTable title="By brand" file={`${file}-by-brand`} rows={data.byBrand} columns={groupCols("Brand")} />
      <ReportTable title="By product" file={`${file}-by-product`} rows={data.byProduct} columns={groupCols("Product")} />
      <ReportTable
        title="Sales with a missing cost"
        file={`${file}-missing-costs`}
        rows={data.missingCosts}
        empty="Every sale in this period has a cost."
        columns={(h) => [
          { label: "Bill", cell: (r) => <Link to={`../documents/${r.documentId}`}>{r.number}</Link>, csv: (r) => r.number },
          { label: "Date", cell: (r) => r.date },
          { label: "Product", cell: (r) => r.product },
          { label: "IMEI", cell: (r) => r.serials ?? "" },
          h.num("Qty", (r) => r.quantity),
          h.money("Sale value", (r) => r.revenue),
        ]}
      />
      {data.missingCosts.length > 0 && (
        <p className="muted small">These were entered as opening stock without a cost, so their profit can't be known. Enter opening stock with a cost estimate to avoid this.</p>
      )}
    </>
  );
}

interface MethodRow {
  method: string;
  atCounter: number;
  receipts: number;
  collected: number;
  paidOut: number;
  net: number;
}

function CollectionsReport({ path, file }: ReportProps) {
  const { data, error } = useReport<{
    totals: { atCounter: number; receipts: number; collected: number; paidOut: number };
    byMethod: MethodRow[];
    byDay: { date: string; in: number; out: number }[];
  }>(path);
  if (!data) return error;
  return (
    <>
      <div className="grid">
        <Stat label="Collected" value={rupees(data.totals.collected)} note={`${rupees(data.totals.atCounter)} at the counter, ${rupees(data.totals.receipts)} from dues`} />
        <Stat label="Paid out" value={rupees(data.totals.paidOut)} note="Suppliers and expenses" />
        <Stat label="Net" value={rupees(data.totals.collected - data.totals.paidOut)} />
      </div>
      <ReportTable
        title="By payment method"
        file={`${file}-by-method`}
        rows={data.byMethod}
        columns={(h) => [
          { label: "Method", cell: (r) => label(r.method) },
          h.money("At the counter", (r) => r.atCounter),
          h.money("Dues received", (r) => r.receipts),
          h.money("Paid out", (r) => r.paidOut),
          h.money("Net", (r) => r.net),
        ]}
      />
      <ReportTable
        title="By day"
        file={`${file}-by-day`}
        rows={data.byDay}
        columns={(h) => [{ label: "Date", cell: (r) => r.date }, h.money("In", (r) => r.in), h.money("Out", (r) => r.out), h.money("Net", (r) => r.in - r.out)]}
      />
    </>
  );
}

function StockReport({ path, file }: ReportProps) {
  const { data, error } = useReport<{
    asOf: string;
    byBranch: { name: string; units: number; items: number; retailValue: number; value?: number; verifiedValue?: number; estimatedValue?: number; unknownCostUnits?: number }[];
    byCategory: { name: string; units: number; retailValue: number; value?: number }[];
    lowStock: { branch: string; product: string; quantity: number; reorderLevel: number }[];
    inTransit: { transfers: number; units: number; value?: number };
    deviceAging: { label: string; devices: number; value?: number }[];
    oldestDevices: { imei: string; product: string; branch: string; days: number; unitCost?: number; costConfidence?: Confidence }[];
  }>(path);
  if (!data) return error;
  const showCost = data.byBranch.some((b) => b.value !== undefined) || data.inTransit.value !== undefined;
  const total = (k: "units" | "retailValue" | "value" | "verifiedValue" | "estimatedValue" | "unknownCostUnits") => data.byBranch.reduce((a, b) => a + (b[k] ?? 0), 0);
  return (
    <>
      <p className="muted">Stock on hand now ({data.asOf}).</p>
      <div className="grid">
        <Stat label="Items in stock" value={total("units")} />
        {showCost && <Stat label="Value at cost" value={rupees(total("value"))} note={`${rupees(total("verifiedValue"))} verified`} />}
        {showCost && total("estimatedValue") > 0 && <Stat label="Of which estimated" tone="estimated" value={rupees(total("estimatedValue"))} />}
        {showCost && total("unknownCostUnits") > 0 && <Stat label="Items with unknown cost" tone="unknown" value={total("unknownCostUnits")} note="Not in the value" />}
        <Stat label="Value at sale price" value={rupees(total("retailValue"))} />
        {data.inTransit.transfers > 0 && (
          <Stat label="In transit" value={`${data.inTransit.units} items`} note={showCost ? rupees(data.inTransit.value) : `${data.inTransit.transfers} transfers`} />
        )}
      </div>
      {data.byBranch.length > 1 && (
        <ReportTable
          title="By branch"
          file={`${file}-by-branch`}
          rows={data.byBranch}
          columns={(h) => [
            { label: "Branch", cell: (r) => r.name },
            h.num("Items", (r) => r.units),
            ...(showCost ? [h.money("Value at cost", (r) => r.value)] : []),
            h.money("At sale price", (r) => r.retailValue),
          ]}
        />
      )}
      <ReportTable
        title="By category"
        file={`${file}-by-category`}
        rows={data.byCategory}
        columns={(h) => [
          { label: "Category", cell: (r) => r.name },
          h.num("Items", (r) => r.units),
          ...(showCost ? [h.money("Value at cost", (r) => r.value)] : []),
          h.money("At sale price", (r) => r.retailValue),
        ]}
      />
      <ReportTable
        title="Low stock"
        file={`${file}-low-stock`}
        rows={data.lowStock}
        empty="Nothing is at or below its reorder level."
        columns={(h) => [{ label: "Product", cell: (r) => r.product }, { label: "Branch", cell: (r) => r.branch }, h.num("On hand", (r) => r.quantity), h.num("Reorder at", (r) => r.reorderLevel)]}
      />
      <ReportTable
        title="Phone age (days since it came in)"
        rows={data.deviceAging}
        columns={(h) => [{ label: "Age", cell: (r) => r.label }, h.num("Phones", (r) => r.devices), ...(showCost ? [h.money("Value at cost", (r) => r.value)] : [])]}
      />
      <ReportTable
        title="Oldest phones in stock"
        file={`${file}-oldest-phones`}
        rows={data.oldestDevices}
        empty="No phones in stock."
        columns={(h) => [
          { label: "IMEI", cell: (r) => r.imei },
          { label: "Product", cell: (r) => r.product },
          { label: "Branch", cell: (r) => r.branch },
          h.num("Days", (r) => r.days),
          ...(showCost
            ? [{ label: "Cost", cell: (r: (typeof data.oldestDevices)[number]) => <>{rupees(r.unitCost)} <ConfidenceTag value={r.costConfidence} /></>, money: (r: (typeof data.oldestDevices)[number]) => r.unitCost, num: true }]
            : []),
        ]}
      />
    </>
  );
}

interface PartyDue {
  partyId: string;
  name: string;
  phone: string | null;
  balance: number;
  oldestOpen: string | null;
}
interface DueSide {
  totalDue: number;
  advances: number;
  aging: { label: string; amount: number }[];
  parties: PartyDue[];
}

function DuesReport({ path, file }: ReportProps) {
  const { data, error } = useReport<{ asOf: string; customers: DueSide; suppliers: DueSide }>(path);
  if (!data) return error;
  const partyCols = (owes: string) => (h: ColumnHelpers<PartyDue>) => [
    { label: "Name", cell: (r: PartyDue) => <Link to={`../parties/${r.partyId}`}>{r.name}</Link>, csv: (r: PartyDue) => r.name },
    { label: "Mobile", cell: (r: PartyDue) => r.phone ?? "" },
    h.money(owes, (r) => r.balance),
    { label: "Oldest unpaid bill", cell: (r: PartyDue) => r.oldestOpen ?? "" },
  ];
  return (
    <>
      <p className="muted">Balances now ({data.asOf}). A negative balance is an advance.</p>
      <div className="grid">
        <Stat label="Customers owe you" value={rupees(data.customers.totalDue)} note={data.customers.advances ? `${rupees(data.customers.advances)} advances held` : undefined} />
        <Stat label="You owe suppliers" value={rupees(data.suppliers.totalDue)} note={data.suppliers.advances ? `${rupees(data.suppliers.advances)} paid in advance` : undefined} />
      </div>
      <ReportTable title="Customer dues by age" rows={data.customers.aging} columns={(h) => [{ label: "Unpaid for", cell: (r) => r.label }, h.money("Amount", (r) => r.amount)]} />
      <ReportTable title="Customers" file={`${file}-customers`} rows={data.customers.parties} empty="No customer owes anything." columns={partyCols("Owes you")} />
      <ReportTable title="Supplier dues by age" rows={data.suppliers.aging} columns={(h) => [{ label: "Unpaid for", cell: (r) => r.label }, h.money("Amount", (r) => r.amount)]} />
      <ReportTable title="Suppliers" file={`${file}-suppliers`} rows={data.suppliers.parties} empty="You owe no supplier anything." columns={partyCols("You owe")} />
    </>
  );
}

interface TaxLine {
  rate: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
}
interface GstBranch {
  branchId: string;
  name: string;
  gstin: string | null;
  gstEnabled: boolean;
  outward: TaxLine[];
  inward: TaxLine[];
  outputTax: number;
  inputTax: number;
  netTax: number;
  b2b: { invoices: number; taxable: number; tax: number };
  b2c: { invoices: number; taxable: number; tax: number };
  hsn: (TaxLine & { hsn: string; units: number })[];
  b2bInvoices: { documentId: string; number: string; date: string; party: string; gstin: string; interState: boolean; taxable: number; tax: number; total: number }[];
  documents: { first: string; last: string; issued: number; cancelled: number } | null;
}

function taxCols<T extends TaxLine>(h: ColumnHelpers<T>): Column<T>[] {
  return [h.money("Taxable value", (r) => r.taxable), h.money("CGST", (r) => r.cgst), h.money("SGST", (r) => r.sgst), h.money("IGST", (r) => r.igst), h.money("Total tax", (r) => r.tax)];
}

function GstReport({ path, file }: ReportProps) {
  const { data, error } = useReport<{ branches: GstBranch[] }>(path);
  if (!data) return error;
  if (data.branches.length === 0) {
    return <p className="muted">No branch has GST invoicing switched on. Turn it on for a branch under Branches to issue tax invoices.</p>;
  }
  return (
    <>
      <p className="muted">
        A summary to hand to your accountant for GSTR-1 and GSTR-3B. Check it against your filing; it does not include credit carried forward from earlier
        months.
      </p>
      {data.branches.map((b) => {
        const f = `${file}-${b.name.replace(/\W+/g, "-").toLowerCase()}`;
        return (
          <div key={b.branchId} className="card report-block">
            <h2>
              {b.name} <span className="muted">· GSTIN {b.gstin ?? "not set"}</span>
            </h2>
            <div className="grid">
              <Stat label="Output tax (on sales)" value={rupees(b.outputTax)} />
              <Stat label="Input credit (on purchases)" value={rupees(b.inputTax)} />
              <Stat label={b.netTax >= 0 ? "Net tax payable" : "Credit to carry forward"} value={rupees(Math.abs(b.netTax))} />
            </div>
            <ReportTable title="Sales by rate" file={`${f}-outward`} rows={b.outward} columns={(h) => [{ label: "Rate", cell: (r) => rate(r.rate) }, ...taxCols(h)]} />
            <ReportTable
              title="Registered (B2B) and unregistered (B2C) buyers"
              rows={[
                { name: "B2B (buyer has GSTIN)", ...b.b2b },
                { name: "B2C", ...b.b2c },
              ]}
              columns={(h) => [{ label: "Buyers", cell: (r) => r.name }, h.num("Invoices", (r) => r.invoices), h.money("Taxable value", (r) => r.taxable), h.money("Tax", (r) => r.tax)]}
            />
            <ReportTable
              title="B2B invoices"
              file={`${f}-b2b-invoices`}
              rows={b.b2bInvoices}
              empty="No invoices to GST-registered buyers."
              columns={(h) => [
                { label: "Invoice", cell: (r) => <Link to={`../documents/${r.documentId}`}>{r.number}</Link>, csv: (r) => r.number },
                { label: "Date", cell: (r) => r.date },
                { label: "Buyer", cell: (r) => r.party },
                { label: "GSTIN", cell: (r) => r.gstin },
                { label: "Supply", cell: (r) => (r.interState ? "Inter-state" : "Intra-state") },
                h.money("Taxable value", (r) => r.taxable),
                h.money("Tax", (r) => r.tax),
                h.money("Invoice value", (r) => r.total),
              ]}
            />
            <ReportTable
              title="HSN summary"
              file={`${f}-hsn`}
              rows={b.hsn}
              columns={(h) => [{ label: "HSN", cell: (r) => r.hsn || "Not set" }, { label: "Rate", cell: (r) => rate(r.rate) }, h.num("Qty", (r) => r.units), ...taxCols(h)]}
            />
            <ReportTable title="Purchases by rate (input credit)" file={`${f}-inward`} rows={b.inward} columns={(h) => [{ label: "Rate", cell: (r) => rate(r.rate) }, ...taxCols(h)]} />
            {b.documents && (
              <p className="muted small">
                Invoices issued {b.documents.first} to {b.documents.last}: {b.documents.issued}, of which {b.documents.cancelled} cancelled.
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

interface BranchRow {
  name: string;
  invoices: number;
  billed: number;
  netSales: number;
  collected: number;
  expenses: number;
  stockUnits: number;
  verifiedProfit?: number;
  estimatedProfit?: number;
  unknownCostRevenue?: number;
  verifiedAfterExpenses?: number;
  stockValue?: number;
}

function BranchesReport({ path, file }: ReportProps) {
  const { data, error } = useReport<{ branches: BranchRow[] }>(path);
  if (!data) return error;
  const showCost = data.branches.some((b) => b.verifiedProfit !== undefined);
  return (
    <ReportTable
      title="Branch comparison"
      file={file}
      rows={data.branches}
      columns={(h) => [
        { label: "Branch", cell: (r: BranchRow) => r.name },
        h.num("Bills", (r) => r.invoices),
        h.money("Net sales", (r) => r.netSales),
        h.money("Collected", (r) => r.collected),
        h.money("Expenses", (r) => r.expenses),
        ...(showCost
          ? [
              h.money("Verified profit", (r) => r.verifiedProfit),
              h.money("Estimated profit", (r) => r.estimatedProfit),
              h.money("Unknown-cost sales", (r) => r.unknownCostRevenue),
              h.money("Verified after expenses", (r) => r.verifiedAfterExpenses),
              h.money("Stock at cost", (r) => r.stockValue),
            ]
          : []),
        h.num("Items in stock", (r) => r.stockUnits),
      ]}
    />
  );
}
