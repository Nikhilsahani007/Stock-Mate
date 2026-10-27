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

  const links = [
    { to: "", label: "Home", show: true },
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
          <NavLink key={l.to} to={l.to} end={l.to === ""}>
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
