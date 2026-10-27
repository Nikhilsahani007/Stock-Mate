import { roleHas, type Role } from "@stockpilot/shared";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth";
import { TrialBanner } from "./TrialBanner";

export function useBusiness() {
  const { businessId } = useParams();
  const { me } = useAuth();
  const business = me?.businesses.find((b) => b.id === businessId);
  return { businessId: businessId!, business, role: business?.role as Role | undefined };
}

export function AppShell() {
  const { me, logout } = useAuth();
  const { businessId, business, role } = useBusiness();
  const navigate = useNavigate();

  if (!business || !role) {
    return (
      <div className="center">
        <p className="muted">Business not found.</p>
      </div>
    );
  }

  const can = (p: Parameters<typeof roleHas>[1]) => roleHas(role, p);
  const links = [
    { to: "", label: "Home", show: true, primary: true },
    { to: "sell", label: "Sell", show: can("sale.create"), primary: true },
    { to: "purchases/new", label: "Buy", show: can("purchase.create"), primary: true },
    { to: "stock", label: "Stock", show: can("stock.view"), primary: true },
    { to: "documents", label: "Bills", show: true, primary: true },
    { to: "reports", label: "Reports", show: can("report.view") || can("stock.view"), primary: true },
    { to: "day-close", label: "Day close", show: can("day.close") || can("report.view") },
    { to: "stock/entry", label: "Stock entry", show: can("stock.adjust") || can("stock.transfer") },
    { to: "purchases/return", label: "Supplier return", show: can("purchase.create") },
    { to: "products", label: "Products", show: can("stock.view") },
    { to: "parties", label: "Customers", show: can("party.manage") },
    { to: "expenses", label: "Expenses", show: can("expense.record") },
    { to: "branches", label: "Branches", show: true },
    { to: "team", label: "Team", show: roleHas(role, "member.read") },
    { to: "activity", label: "Activity", show: roleHas(role, "audit.read") },
  ].filter((l) => l.show);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">StockPilot</span>
        {me!.businesses.length > 1 ? (
          <select
            aria-label="Business"
            value={businessId}
            onChange={(e) => void navigate(`/b/${e.target.value}`)}
          >
            {me!.businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="business-name">{business.name}</span>
        )}
        <span className="spacer" />
        <span className="muted user-name">{me!.user.name}</span>
        <button className="link" onClick={() => void logout().then(() => navigate("/"))}>
          Sign out
        </button>
      </header>
      <nav className="sidenav" aria-label="Main">
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.to === "" || l.to === "stock"} className={l.primary ? "primary" : "secondary-link"}>
            {l.label}
          </NavLink>
        ))}
      </nav>
      <main className="content">
        <TrialBanner access={business.access} />
        <Outlet />
      </main>
    </div>
  );
}
