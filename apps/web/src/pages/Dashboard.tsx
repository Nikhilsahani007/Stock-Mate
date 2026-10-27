import { useBusiness } from "../components/AppShell";

export function Dashboard() {
  const { business, role } = useBusiness();
  return (
    <>
      <h1>{business!.name}</h1>
      <p className="muted">Signed in as {role!.toLowerCase().replace("_", " ")}.</p>
      <div className="grid">
        {["Today's sales", "Stock on hand", "Customer dues", "Gross profit"].map((label) => (
          <div className="card stat" key={label}>
            <span className="muted">{label}</span>
            <strong>—</strong>
          </div>
        ))}
      </div>
      <p className="muted">Sales, stock and reports arrive in the next phase.</p>
    </>
  );
}
