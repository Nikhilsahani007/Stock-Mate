import { EXPENSE_CATEGORIES } from "@stockpilot/shared";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { newKey, postDocument, type DocumentSummary, type PostResult } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { BranchSelect, PAYMENT_METHODS, PartyPicker, label, rupees, toPaise, useBranchChoice } from "../components/inventory";
import { useApi } from "../useApi";

export function Expenses() {
  const { businessId, business } = useBusiness();
  const { branches, branchId, setBranchId } = useBranchChoice(businessId);
  const { data, reload } = useApi<{ documents: DocumentSummary[] }>(`/businesses/${businessId}/documents?type=EXPENSE&limit=50`);
  const [method, setMethod] = useState<string>("CASH");
  const [partyId, setPartyId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const form = new FormData(el);
    try {
      const amount = toPaise(String(form.get("amount")));
      if (!amount) throw new Error("Enter the amount");
      await postDocument<PostResult>(
        `/businesses/${businessId}/expenses`,
        {
          branchId,
          category: form.get("category"),
          amount,
          method: method === "UNPAID" ? undefined : method,
          partyId: method === "UNPAID" ? partyId || undefined : undefined,
          notes: form.get("notes") || undefined,
        },
        key,
      );
      setKey(newKey());
      el.reset();
      setError(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Expenses</h1>
      {business!.access.access === "FULL" && (
        <form className="card" onSubmit={onSubmit}>
          <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
          <div className="row">
            <label className="field">
              <span>Category</span>
              <select name="category" defaultValue="OTHER">
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {label(c)}
                  </option>
                ))}
              </select>
            </label>
            <Field label="Amount ₹" name="amount" inputMode="decimal" required />
            <label className="field">
              <span>Paid by</span>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {label(m)}
                  </option>
                ))}
                <option value="UNPAID">Not paid yet</option>
              </select>
            </label>
          </div>
          {method === "UNPAID" && <PartyPicker businessId={businessId} kind="SUPPLIER" value={partyId} onChange={setPartyId} />}
          <Field label="Note" name="notes" maxLength={500} />
          <ErrorText error={error} />
          <button>Save expense</button>
        </form>
      )}
      <ul className="list">
        {data?.documents.map((d) => (
          <li key={d.id} className="card">
            <Link to={`../documents/${d.id}`}>{d.number}</Link>
            <span className="muted">{d.businessDate.slice(0, 10)}</span>
            <span>{d.expenseCategory && label(d.expenseCategory)}</span>
            <strong>{rupees(d.total)}</strong>
            {d.status === "CANCELLED" && <span className="tag">Cancelled</span>}
          </li>
        ))}
      </ul>
    </>
  );
}
