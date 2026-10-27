import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api, type SerialUnit, type StockRow } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText } from "../components/Field";
import { BranchSelect, ConfidenceTag, label, rupees, useBranchChoice } from "../components/inventory";
import { useApi } from "../useApi";

interface History {
  unit: SerialUnit;
  history: { businessDate: string; branch: string; quantity: number; isReversal: boolean; value?: number; document: { id: string; type: string; number: string; status: string } }[];
}

export function Stock() {
  const { businessId } = useBusiness();
  const { branches, branchId, setBranchId } = useBranchChoice(businessId);
  const [q, setQ] = useState("");
  const { data, error } = useApi<{ rows: StockRow[] }>(branchId ? `/businesses/${businessId}/stock?branchId=${branchId}&q=${encodeURIComponent(q)}` : "");
  const [lookup, setLookup] = useState<History | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const rows = data?.rows ?? [];
  const showCost = rows.some((r) => r.value !== undefined);
  const totalValue = rows.reduce((a, r) => a + (r.value ?? 0), 0);

  async function onLookup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const id = String(new FormData(e.currentTarget).get("imei") ?? "").trim();
    if (!id) return;
    try {
      setLookup(await api<History>(`/businesses/${businessId}/stock/serials/${encodeURIComponent(id)}`));
      setLookupError(null);
    } catch (err) {
      setLookup(null);
      setLookupError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Stock</h1>
      <div className="row">
        <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
        <label className="field grow">
          <span>Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Product, SKU or barcode" />
        </label>
      </div>
      <ErrorText error={error} />
      {showCost && (
        <p className="muted">
          Stock value at cost: <strong>{rupees(totalValue)}</strong>
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">On hand</th>
              <th className="num">Sale price</th>
              {showCost && <th className="num">Avg cost</th>}
              {showCost && <th className="num">Value</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.variantId} className={r.quantity <= r.reorderLevel ? "low" : undefined}>
                <td>
                  {r.productName} <span className="muted">· {r.variantName}</span>
                  {r.isSerialized && <span className="tag">IMEI</span>}
                </td>
                <td className="num">
                  {r.quantity}
                  {r.quantity <= r.reorderLevel && r.reorderLevel > 0 && <span className="tag warn">Reorder</span>}
                </td>
                <td className="num">{rupees(r.salePrice)}</td>
                {showCost && (
                  <td className="num">
                    {rupees(r.averageCost)} {r.quantity > 0 && <ConfidenceTag value={r.costConfidence} />}
                  </td>
                )}
                {showCost && <td className="num">{rupees(r.value)}</td>}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nothing in stock here yet. Add a purchase or opening stock.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form className="card" onSubmit={onLookup}>
        <h2>Find a device</h2>
        <div className="row">
          <input name="imei" aria-label="IMEI or serial" placeholder="Scan or type an IMEI" inputMode="numeric" />
          <button>Look up</button>
        </div>
        <ErrorText error={lookupError} />
        {lookup && (
          <>
            <p>
              <strong>
                {lookup.unit.productName} · {lookup.unit.variantName}
              </strong>{" "}
              <span className="tag">{label(lookup.unit.status)}</span>
              {lookup.unit.unitCost !== undefined && <span className="muted"> Cost {rupees(lookup.unit.unitCost)}</span>}
            </p>
            <ul className="plain">
              {lookup.history.map((h, i) => (
                <li key={i}>
                  {h.businessDate.slice(0, 10)} · {h.branch} · {h.quantity > 0 ? "In" : "Out"}
                  {h.isReversal ? " (cancelled)" : ""} · <Link to={`../documents/${h.document.id}`}>{h.document.number}</Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </form>
    </>
  );
}
