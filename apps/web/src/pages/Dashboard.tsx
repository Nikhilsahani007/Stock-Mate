import { roleHas } from "@stockpilot/shared";
import { Link } from "react-router";
import { useBusiness } from "../components/AppShell";

export function Dashboard() {
  const { business, role } = useBusiness();
  const actions = [
    { to: "sell", label: "New sale", show: roleHas(role!, "sale.create") },
    { to: "purchases/new", label: "New purchase", show: roleHas(role!, "purchase.create") },
    { to: "stock/entry", label: "Opening stock", show: roleHas(role!, "stock.adjust") },
    { to: "stock", label: "Check stock", show: roleHas(role!, "stock.view") },
  ].filter((a) => a.show);
  return (
    <>
      <h1>{business!.name}</h1>
      <p className="muted">Signed in as {role!.toLowerCase().replace("_", " ")}.</p>
      <div className="grid">
        {actions.map((a) => (
          <Link key={a.to} to={a.to} className="card action">
            {a.label}
          </Link>
        ))}
      </div>
      <p className="muted">Reports (sales, collections, verified and estimated profit, stock value) and day close arrive in the next phase.</p>
    </>
  );
}
