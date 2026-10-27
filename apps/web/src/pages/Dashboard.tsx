import { roleHas, todayIn } from "@stockpilot/shared";
import { Link } from "react-router";
import { useBusiness } from "../components/AppShell";
import { label, rupees } from "../components/inventory";
import { Stat } from "../components/reports";
import { useApi } from "../useApi";

interface BranchToday {
  name: string;
  invoices: number;
  billed: number;
  collected: number;
  expenses: number;
  verifiedProfit?: number;
  estimatedProfit?: number;
  unknownCostRevenue?: number;
}

export function Dashboard() {
  const { businessId, business, role } = useBusiness();
  const can = (p: Parameters<typeof roleHas>[1]) => roleHas(role!, p);
  const actions = [
    { to: "sell", label: "New sale", show: can("sale.create") },
    { to: "purchases/new", label: "New purchase", show: can("purchase.create") },
    { to: "stock/entry", label: "Opening stock", show: can("stock.adjust") },
    { to: "stock", label: "Check stock", show: can("stock.view") },
    { to: "day-close", label: "Close the day", show: can("day.close") },
  ].filter((a) => a.show);
  const today = todayIn("Asia/Kolkata");
  return (
    <>
      <h1>{business!.name}</h1>
      <p className="muted">Signed in as {label(role!)}.</p>
      {can("report.view") ? <Today businessId={businessId} today={today} /> : can("sale.create") && <MyDay businessId={businessId} />}
      <div className="grid">
        {actions.map((a) => (
          <Link key={a.to} to={a.to} className="card action">
            {a.label}
          </Link>
        ))}
      </div>
    </>
  );
}

function Today({ businessId, today }: { businessId: string; today: string }) {
  const { data } = useApi<{ branches: BranchToday[] }>(`/businesses/${businessId}/reports/branches?from=${today}&to=${today}`);
  if (!data) return null;
  const sum = (k: keyof BranchToday) => data.branches.reduce((a, b) => a + ((b[k] as number | undefined) ?? 0), 0);
  const showCost = data.branches.some((b) => b.verifiedProfit !== undefined);
  return (
    <>
      <h2>Today</h2>
      <div className="grid">
        <Stat label="Sales" value={rupees(sum("billed"))} note={`${sum("invoices")} bills`} />
        <Stat label="Collected" value={rupees(sum("collected"))} />
        {showCost && <Stat label="Verified profit" value={rupees(sum("verifiedProfit"))} />}
        {showCost && sum("estimatedProfit") !== 0 && <Stat label="Estimated profit" tone="estimated" value={rupees(sum("estimatedProfit"))} />}
        {showCost && sum("unknownCostRevenue") > 0 && <Stat label="Sales with unknown cost" tone="unknown" value={rupees(sum("unknownCostRevenue"))} />}
        <Stat label="Expenses" value={rupees(sum("expenses"))} />
      </div>
      <p>
        <Link to="reports">All reports</Link>
      </p>
    </>
  );
}

function MyDay({ businessId }: { businessId: string }) {
  const { data } = useApi<{ invoices: number; billed: number; byMethod: { method: string; amount: number }[]; onCredit: number }>(
    `/businesses/${businessId}/reports/my-day`,
  );
  if (!data) return null;
  return (
    <>
      <h2>My sales today</h2>
      <div className="grid">
        <Stat label="Billed" value={rupees(data.billed)} note={`${data.invoices} bills`} />
        {data.byMethod.map((m) => (
          <Stat key={m.method} label={label(m.method)} value={rupees(m.amount)} />
        ))}
        {data.onCredit > 0 && <Stat label="On credit" value={rupees(data.onCredit)} />}
      </div>
    </>
  );
}
