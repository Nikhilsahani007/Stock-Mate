import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newKey, postDocument, type DocumentDetail, type DocumentLine, type PostResult } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText } from "../components/Field";
import { TenderInputs, emptyTenders, rupees, tendersToBody, toPaise } from "../components/inventory";
import { useApi } from "../useApi";

interface ReturnDraft {
  quantity: string;
  serials: string[];
  damaged: boolean;
}

const returnedQty = (l: DocumentLine) => l.returnedBy.reduce((a, r) => a + r.quantity, 0);
const returnedImeis = (l: DocumentLine) => new Set(l.returnedBy.flatMap((r) => r.serials.map((s) => s.serialUnit.imei)));

/**
 * Take goods back against an invoice. Prices, tax and cost come from the
 * invoice; the screen only picks what came back, its condition and the refund.
 * The total shown is an estimate; the credit note has the exact figures.
 */
export function SaleReturn() {
  const { businessId } = useBusiness();
  const { documentId } = useParams();
  const navigate = useNavigate();
  const { data, error } = useApi<{ document: DocumentDetail }>(`/businesses/${businessId}/documents/${documentId}`);
  const [drafts, setDrafts] = useState<Record<string, ReturnDraft>>({});
  const [reason, setReason] = useState("");
  const [refunds, setRefunds] = useState(emptyTenders());
  const [loans, setLoans] = useState<Record<string, string>>({});
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const sale = data?.document;
  if (!sale) return <ErrorText error={error} />;

  const draft = (l: DocumentLine): ReturnDraft => drafts[l.id] ?? { quantity: "", serials: [], damaged: false };
  const set = (l: DocumentLine, patch: Partial<ReturnDraft>) => setDrafts({ ...drafts, [l.id]: { ...draft(l), ...patch } });
  const qtyOf = (l: DocumentLine) => (l.variant.product.isSerialized ? draft(l).serials.length : Number(draft(l).quantity) || 0);
  const estimate = sale.lines.reduce((a, l) => a + Math.round((l.lineTotal * qtyOf(l)) / l.quantity), 0);
  // Finance companies on the bill, with what each financed less what earlier returns cancelled.
  const financed = new Map<string, { name: string; left: number }>();
  for (const t of sale.tenders) {
    if (t.method !== "FINANCE" || !t.party) continue;
    const f = financed.get(t.party.id) ?? { name: t.party.name, left: 0 };
    financed.set(t.party.id, { ...f, left: f.left + t.amount });
  }
  for (const r of sale.returns) {
    if (r.status === "CANCELLED") continue;
    for (const t of r.tenders) {
      const f = t.method === "FINANCE" && t.party ? financed.get(t.party.id) : undefined;
      if (f) f.left -= t.amount;
    }
  }
  const loanBody = () =>
    [...financed.keys()]
      .filter((id) => loans[id])
      .map((id) => {
        const amount = toPaise(loans[id]!);
        if (amount === null) throw new Error("Check the EMI amounts: use numbers like 8000 or 8000.50");
        return { method: "FINANCE" as const, amount, partyId: id };
      })
      .filter((t) => t.amount > 0);
  const loanTotal = [...financed.keys()].reduce((a, id) => a + (toPaise(loans[id] ?? "") ?? 0), 0);
  const refunded = tendersToBody(refunds).reduce((a, t) => a + t.amount, 0) + loanTotal;

  async function submit() {
    setBusy(true);
    try {
      const lines = sale!.lines
        .filter((l) => qtyOf(l) > 0)
        .map((l) => ({ lineId: l.id, quantity: qtyOf(l), serials: draft(l).serials, damaged: draft(l).damaged }));
      if (lines.length === 0) throw new Error("Choose what came back");
      const res = await postDocument<PostResult>(`/businesses/${businessId}/sale-returns`, { saleId: sale!.id, reason, lines, refunds: [...tendersToBody(refunds), ...loanBody()] }, key);
      setKey(newKey());
      void navigate(`../documents/${res.document.id}`);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link to="..">← {sale.number}</Link>
      <h1>Return items</h1>
      <p className="muted">
        Against {sale.number} of {sale.businessDate.slice(0, 10)}
        {sale.party ? ` · ${sale.party.name}` : " · walk-in customer"}. Goods come back at the price and cost on the bill.
      </p>
      {sale.lines.map((l) => {
        const left = l.quantity - returnedQty(l);
        const gone = returnedImeis(l);
        return (
          <div key={l.id} className="card line">
            <div className="row">
              <strong className="grow">
                {l.variant.product.name} · {l.variant.name}
              </strong>
              <span className="muted">
                Sold {l.quantity} at {rupees(l.unitPrice)}
                {left < l.quantity ? `, ${l.quantity - left} already returned` : ""}
              </span>
            </div>
            {left === 0 ? (
              <p className="muted small">Everything on this line has come back.</p>
            ) : l.variant.product.isSerialized ? (
              <div className="serials">
                {l.serials
                  .filter((s) => !gone.has(s.serialUnit.imei))
                  .map((s) => (
                    <label key={s.serialUnit.id} className="check">
                      <input
                        type="checkbox"
                        checked={draft(l).serials.includes(s.serialUnit.imei)}
                        onChange={(e) =>
                          set(l, { serials: e.target.checked ? [...draft(l).serials, s.serialUnit.imei] : draft(l).serials.filter((x) => x !== s.serialUnit.imei) })
                        }
                      />
                      <code>{s.serialUnit.imei}</code>
                    </label>
                  ))}
              </div>
            ) : (
              <label className="field inline">
                <span>Quantity back (up to {left})</span>
                <input className="qty" inputMode="numeric" aria-label={`Quantity back of ${l.variant.name}`} value={draft(l).quantity} onChange={(e) => set(l, { quantity: e.target.value })} />
              </label>
            )}
            {left > 0 && (
              <label className="check">
                <input type="checkbox" checked={draft(l).damaged} onChange={(e) => set(l, { damaged: e.target.checked })} />
                Damaged (write off instead of putting back on the shelf)
              </label>
            )}
          </div>
        );
      })}
      <div className="card">
        <label className="field">
          <span>Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Defective, changed mind, wrong model…" maxLength={300} />
        </label>
        <p className="total">
          Credit about <strong>{rupees(estimate)}</strong>
        </p>
        {financed.size > 0 && (
          <>
            <h2>EMI loan cancelled</h2>
            <p className="muted small">If the finance company cancels the loan, enter how much of it they will no longer pay you.</p>
            <div className="row">
              {[...financed].map(([id, f]) => (
                <label key={id} className="field">
                  <span>
                    {f.name} (up to {rupees(Math.max(0, f.left))})
                  </span>
                  <input inputMode="decimal" value={loans[id] ?? ""} onChange={(e) => setLoans({ ...loans, [id]: e.target.value })} placeholder="0" />
                </label>
              ))}
            </div>
          </>
        )}
        <h2>Refund now</h2>
        <TenderInputs values={refunds} onChange={setRefunds} />
        <button type="button" className="secondary" onClick={() => setRefunds({ ...emptyTenders(), CASH: String(Math.max(0, estimate - loanTotal) / 100) })}>
          Refund {loanTotal > 0 ? "the rest" : "all"} in cash
        </button>
        <p className="muted small">
          {sale.party
            ? `Whatever isn't refunded first clears what ${sale.party.name} still owes on this bill, then stays on their account as an advance.`
            : "A walk-in customer must be refunded the full amount."}
          {refunded > 0 ? ` Refunding ${rupees(refunded)}.` : ""}
        </p>
        <ErrorText error={formError} />
        <button type="button" onClick={() => void submit()} disabled={busy || reason.trim().length < 3}>
          {busy ? "Saving…" : "Save credit note"}
        </button>
      </div>
    </>
  );
}
