import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "./auth";
import { AppShell } from "./components/AppShell";
import { AcceptInvite } from "./pages/AcceptInvite";
import { Activity } from "./pages/Activity";
import { Branches } from "./pages/Branches";
import { Dashboard } from "./pages/Dashboard";
import { DayClose } from "./pages/DayClose";
import { DocumentView } from "./pages/DocumentView";
import { Documents } from "./pages/Documents";
import { Expenses } from "./pages/Expenses";
import { Login } from "./pages/Login";
import { NewPurchase } from "./pages/NewPurchase";
import { NewSale } from "./pages/NewSale";
import { Parties, PartyView } from "./pages/Parties";
import { Products } from "./pages/Products";
import { Register } from "./pages/Register";
import { Reports } from "./pages/Reports";
import { Stock } from "./pages/Stock";
import { StockEntry } from "./pages/StockEntry";
import { Team } from "./pages/Team";

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;

  const first = me?.businesses[0];
  return (
    <Routes>
      <Route path="/invite" element={<AcceptInvite />} />
      {!me ? (
        <>
          <Route path="/register" element={<Register />} />
          <Route path="*" element={<Login />} />
        </>
      ) : (
        <>
          <Route path="/b/:businessId" element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="sell" element={<NewSale />} />
            <Route path="purchases/new" element={<NewPurchase />} />
            <Route path="stock" element={<Stock />} />
            <Route path="stock/entry" element={<StockEntry />} />
            <Route path="products" element={<Products />} />
            <Route path="documents" element={<Documents />} />
            <Route path="documents/:documentId" element={<DocumentView />} />
            <Route path="parties" element={<Parties />} />
            <Route path="parties/:partyId" element={<PartyView />} />
            <Route path="expenses" element={<Expenses />} />
            <Route path="reports" element={<Reports />} />
            <Route path="day-close" element={<DayClose />} />
            <Route path="branches" element={<Branches />} />
            <Route path="team" element={<Team />} />
            <Route path="activity" element={<Activity />} />
          </Route>
          <Route path="*" element={first ? <Navigate to={`/b/${first.id}`} replace /> : <NoBusiness />} />
        </>
      )}
    </Routes>
  );
}

function NoBusiness() {
  const { logout } = useAuth();
  return (
    <div className="center">
      <div className="card narrow">
        <h1>No business yet</h1>
        <p className="muted">You aren't a member of any business. Ask the owner for an invitation link.</p>
        <button className="secondary" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
