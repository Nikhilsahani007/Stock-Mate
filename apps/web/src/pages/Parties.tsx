import { roleHas } from "@stockpilot/shared";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, newKey, postDocument, type DocumentType, type Party, type PostResult } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { BranchSelect, TenderInputs, emptyTenders, label, rupees, tendersToBody, toPaise, useBranchChoice } from "../components/inventory";
import { useApi } from "../useApi";

export function Parties() {
  const { businessId } = useBusiness();
  const [kind, setKind] = useState<"" | "CUSTOMER" | "SUPPLIER" | "FINANCIER">("");
  const [q, setQ] = useState("");
  const { data, error, reload } = useApi<{ parties: Party[] }>(`/businesses/${businessId}/parties?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}`);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const form = new FormData(el);
    try {
      await api(`/businesses/${businessId}/parties`, {
        method: "POST",
        body: {
          kind: form.get("kind"),
          name: form.get("name"),
          phone: form.get("phone") || undefined,
          gstin: form.get("gstin") || undefined,
          address: form.get("address") || undefined,
        },
      });
      el.reset();
      setFormError(null);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Customers and suppliers</h1>
      <div className="row">
        <label className="field">
          <span>Show</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="">Everyone</option>
            <option value="CUSTOMER">Customers</option>
            <option value="SUPPLIER">Suppliers</option>
            <option value="FINANCIER">Finance companies</option>
          </select>
        </label>
        <label className="field grow">
          <span>Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or mobile" />
        </label>
      </div>
      <ErrorText error={error} />
      <ul className="list">
        {data?.parties.map((p) => (
          <li key={p.id} className="card">
            <Link to={p.id}>
              <strong>{p.name}</strong>
            </Link>
            {p.phone && <span className="muted">{p.phone}</span>}
            <span className="tag">{label(p.kind)}</span>
          </li>
        ))}
      </ul>
      <form className="card" onSubmit={onSubmit}>
        <h2>Add</h2>
        <label className="field">
          <span>Type</span>
          <select name="kind" defaultValue="CUSTOMER">
            <option value="CUSTOMER">Customer</option>
            <option value="SUPPLIER">Supplier</option>
            <option value="BOTH">Both</option>
            <option value="FINANCIER">Finance company (EMI)</option>
          </select>
        </label>
        <Field label="Name" name="name" required maxLength={120} />
        <Field label="Mobile" name="phone" inputMode="tel" maxLength={10} />
        <Field label="GSTIN (optional)" name="gstin" maxLength={15} />
        <Field label="Address" name="address" maxLength={300} />
        <ErrorText error={formError} />
        <button>Save</button>
      </form>
    </>
  );
}

interface PartyDetail {
  party: Party;
  receivable: number;
  payable: number;
  openDocuments: { id: string; type: DocumentType; number: string; businessDate: string; total: number; paidAmount: number }[];
}

export function PartyView() {
  const { businessId, role, business } = useBusiness();
  const { partyId } = useParams();
  const { data, error, reload } = useApi<PartyDetail>(`/businesses/${businessId}/parties/${partyId}`);
  const { branches, branchId, setBranchId } = useBranchChoice(businessId);
  const [tenders, setTenders] = useState(emptyTenders());
  const [deduction, setDeduction] = useState("");
  const [key, setKey] = useState(newKey);
  const [formError, setFormError] = useState<string | null>(null);
  if (!data) return <ErrorText error={error} />;
  const { party } = data;
  const canPay = roleHas(role!, "payment.record") && business!.access.access === "FULL";
  // Settle whichever side is open; a party who is both can owe either way.
  const isFinancier = party.kind === "FINANCIER";
  const settling: "RECEIPT" | "PAYMENT" = party.kind === "SUPPLIER" || (party.kind === "BOTH" && data.payable > data.receivable) ? "PAYMENT" : "RECEIPT";

  async function onSettle() {
    try {
      const body = { branchId, partyId: party.id, tenders: tendersToBody(tenders), deduction: isFinancier ? (toPaise(deduction) ?? 0) : 0 };
      await postDocument<PostResult>(`/businesses/${businessId}/${settling === "RECEIPT" ? "receipts" : "supplier-payments"}`, body, key);
      setKey(newKey());
      setTenders(emptyTenders());
      setDeduction("");
      setFormError(null);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <>
      <Link to=".." relative="path">
        ← Customers and suppliers
      </Link>
      <h1>{party.name}</h1>
      <p className="muted">
        {[party.phone, party.gstin && `GSTIN ${party.gstin}`, party.address].filter(Boolean).join(" · ")}
      </p>
      <div className="grid">
        <div className="card stat">
          <span className="muted">{data.receivable < 0 ? "Advance from them" : isFinancier ? "EMI payouts due to you" : "They owe you"}</span>
          <strong>{rupees(Math.abs(data.receivable))}</strong>
        </div>
        {!isFinancier && (
          <div className="card stat">
            <span className="muted">{data.payable < 0 ? "Advance paid to them" : "You owe them"}</span>
            <strong>{rupees(Math.abs(data.payable))}</strong>
          </div>
        )}
      </div>
      {!isFinancier && <h2>Unpaid bills</h2>}
      <ul className="list">
        {data.openDocuments.map((d) => (
          <li key={d.id} className="card">
            <Link to={`../../documents/${d.id}`}>{d.number}</Link>
            <span className="muted">{d.businessDate.slice(0, 10)}</span>
            <span>Due {rupees(d.total - d.paidAmount)}</span>
          </li>
        ))}
        {data.openDocuments.length === 0 && !isFinancier && <li className="muted">Nothing unpaid.</li>}
      </ul>
      {canPay && (
        <div className="card">
          <h2>{isFinancier ? "Record EMI payout" : settling === "RECEIPT" ? "Receive payment" : "Pay supplier"}</h2>
          <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
          <TenderInputs values={tenders} onChange={setTenders} />
          {isFinancier ? (
            <>
              <Field label="Fees or subvention they kept back ₹" inputMode="decimal" value={deduction} onChange={(e) => setDeduction(e.target.value)} />
              <p className="muted small">The fees are booked as a finance-charges expense and clear that much of what they owe.</p>
            </>
          ) : (
            <p className="muted small">Settles the oldest unpaid bills first. Anything extra is kept as an advance.</p>
          )}
          <ErrorText error={formError} />
          <button type="button" onClick={() => void onSettle()}>
            Save
          </button>
        </div>
      )}
    </>
  );
}
