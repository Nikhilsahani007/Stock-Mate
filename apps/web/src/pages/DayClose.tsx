import { roleHas, todayIn } from "@stockpilot/shared";
import { useState, type FormEvent } from "react";
import { api, newKey, postDocument } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { BranchSelect, label, rupees, toPaise, useBranchChoice } from "../components/inventory";
import { useApi } from "../useApi";

interface Summary {
  sales: { count: number; total: number; taxable: number; tax: number };
  creditGiven: number;
  cancelledSales: { count: number; total: number };
  tenders: { method: string; in: number; out: number }[];
  cash: { type: string; in: number; out: number }[];
}

interface Preview {
  date: string;
  lastClosedDate: string | null;
  canClose: boolean;
  firstClose: boolean;
  summary: Summary;
  openingCash?: number;
  cashIn?: number;
  cashOut?: number;
  expectedCash?: number;
}

interface Close {
  id: string;
  branchId: string;
  businessDate: string;
  openingCash: number;
  openingFloat: number;
  cashIn: number;
  cashOut: number;
  expectedCash: number;
  countedCash: number;
  difference: number;
  handedOver: number;
  handedOverTo: "BANK" | "OWNER" | null;
  notes: string | null;
  closedAt: string;
  reopenedAt: string | null;
  reopenReason: string | null;
  branch: { id: string; name: string };
  closedBy: { name: string };
  document: { number: string };
}

const CASH_KIND: Record<string, string> = {
  SALE: "Cash sales",
  RECEIPT: "Dues received",
  PURCHASE: "Paid to suppliers on bills",
  PAYMENT: "Supplier payments",
  EXPENSE: "Expenses",
  DAY_CLOSE: "Day close",
};

export function differenceText(d: number) {
  if (d === 0) return "Cash matches";
  return d < 0 ? `Short by ${rupees(-d)}` : `Excess of ${rupees(d)}`;
}

export function DayClose() {
  const { businessId, business, role } = useBusiness();
  const { branches, branchId, setBranchId } = useBranchChoice(businessId);
  const [date, setDate] = useState(() => todayIn("Asia/Kolkata"));
  const pickDate = (d: string) => {
    setDate(d);
    setResult(null);
  };
  const { data: preview, error, reload } = useApi<Preview>(branchId ? `/businesses/${businessId}/day-closes/preview?branchId=${branchId}&date=${date}` : "");
  const { data: history, reload: reloadHistory } = useApi<{ dayCloses: Close[] }>(branchId ? `/businesses/${businessId}/day-closes?branchId=${branchId}` : "");
  const [handover, setHandover] = useState<"" | "BANK" | "OWNER">("");
  const [result, setResult] = useState<Close | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const canClose = roleHas(role!, "day.close") && business!.access.access === "FULL";
  const canReopen = roleHas(role!, "document.cancel") && business!.access.access === "FULL";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      const counted = toPaise(String(form.get("counted") ?? ""));
      const float = toPaise(String(form.get("float") ?? ""));
      const handedOver = toPaise(String(form.get("handedOver") ?? ""));
      if (counted === null || float === null || handedOver === null) throw new Error("Check the amounts");
      if (String(form.get("counted") ?? "").trim() === "") throw new Error("Enter the cash you counted");
      const res = await postDocument<{ dayClose: Close }>(
        `/businesses/${businessId}/day-closes`,
        {
          branchId,
          businessDate: date,
          countedCash: counted,
          openingFloat: float || 0,
          handedOver: handedOver || 0,
          handedOverTo: handedOver ? handover || undefined : undefined,
          notes: form.get("notes") || undefined,
        },
        key,
      );
      setResult(res.dayClose);
      setKey(newKey());
      setFormError(null);
      await Promise.all([reload(), reloadHistory()]);
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  async function reopen(close: Close) {
    const reason = window.prompt(`Reopen ${close.businessDate} at ${close.branch.name}? Say why:`);
    if (!reason) return;
    try {
      await api(`/businesses/${businessId}/day-closes/${close.id}/reopen`, { method: "POST", body: { reason } });
      setResult(null);
      await Promise.all([reload(), reloadHistory()]);
    } catch (err) {
      window.alert((err as Error).message);
    }
  }

  const s = preview?.summary;
  const active = history?.dayCloses.filter((c) => !c.reopenedAt) ?? [];
  const latestId = active[0]?.id;
  const closedHere = active.find((c) => c.businessDate.slice(0, 10) === date);

  return (
    <>
      <h1>Day close</h1>
      <p className="muted">Count the cash drawer at the end of the day. Closing a day locks it: nothing more can be entered on that date or before it at this branch.</p>
      <div className="row">
        <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
        <label className="field">
          <span>Date</span>
          <input type="date" value={date} max={todayIn("Asia/Kolkata")} onChange={(e) => e.target.value && pickDate(e.target.value)} />
        </label>
      </div>
      <ErrorText error={error} />

      {s && (
        <div className="grid">
          <div className="card stat">
            <span className="muted small">Sales</span>
            <strong>{rupees(s.sales.total)}</strong>
            <span className="muted small">
              {s.sales.count} bill{s.sales.count === 1 ? "" : "s"}
              {s.creditGiven ? ` · ${rupees(s.creditGiven)} on credit` : ""}
            </span>
          </div>
          {s.tenders.map((t) => (
            <div key={t.method} className="card stat">
              <span className="muted small">{label(t.method)}</span>
              <strong>{rupees(t.in)}</strong>
              {t.out > 0 && <span className="muted small">{rupees(t.out)} paid out</span>}
            </div>
          ))}
          {s.cancelledSales.count > 0 && (
            <div className="card stat">
              <span className="muted small">Cancelled bills</span>
              <strong>{s.cancelledSales.count}</strong>
              <span className="muted small">{rupees(s.cancelledSales.total)}</span>
            </div>
          )}
        </div>
      )}

      {preview?.canClose && preview.expectedCash !== undefined && (
        <div className="card">
          <h2>Cash drawer</h2>
          <dl className="totals">
            <div className="contents">
              <dt>In the drawer at the start</dt>
              <dd>{rupees(preview.openingCash)}</dd>
            </div>
            {s?.cash.map((c) => (
              <div key={c.type} className="contents">
                <dt>{CASH_KIND[c.type] ?? label(c.type)}</dt>
                <dd>{rupees(c.in - c.out)}</dd>
              </div>
            ))}
            <div className="contents">
              <dt>
                <strong>Should be in the drawer</strong>
              </dt>
              <dd>
                <strong>{rupees(preview.expectedCash)}</strong>
              </dd>
            </div>
          </dl>
        </div>
      )}

      {result && (
        <div className={`banner ${result.difference === 0 ? "info" : "warn"}`} role="status">
          Day closed. Expected {rupees(result.expectedCash)}, counted {rupees(result.countedCash)}: <strong>{differenceText(result.difference)}</strong>.
          {result.handedOver > 0 && ` ${rupees(result.handedOver)} taken out (${result.handedOverTo === "BANK" ? "bank deposit" : "to owner"}).`}
        </div>
      )}

      {preview && !preview.canClose && !result && (
        <p className="banner info">
          {closedHere
            ? `Closed by ${closedHere.closedBy.name}: expected ${rupees(closedHere.expectedCash)}, counted ${rupees(closedHere.countedCash)}. ${differenceText(closedHere.difference)}.`
            : `This date is covered by a later close at this branch (last closed day: ${preview.lastClosedDate}).`}
        </p>
      )}

      {preview?.canClose && canClose && (
        <form className="card" onSubmit={onSubmit}>
          <h2>Count the cash</h2>
          {preview.firstClose && (
            <Field label="Cash already in the drawer before you started using StockPilot ₹ (first close only)" name="float" inputMode="decimal" placeholder="0" />
          )}
          <Field label="Cash counted ₹" name="counted" inputMode="decimal" required />
          <div className="row">
            <Field label="Cash taken out after counting ₹" name="handedOver" inputMode="decimal" placeholder="0" />
            <label className="field">
              <span>Taken out to</span>
              <select value={handover} onChange={(e) => setHandover(e.target.value as "" | "BANK" | "OWNER")}>
                <option value="">Nothing taken out</option>
                <option value="BANK">Bank deposit</option>
                <option value="OWNER">Owner</option>
              </select>
            </label>
          </div>
          <Field label="Note" name="notes" maxLength={500} />
          <ErrorText error={formError} />
          <button>Close {date}</button>
        </form>
      )}

      <h2>Earlier closes</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Expected</th>
              <th className="num">Counted</th>
              <th>Result</th>
              <th className="num">Taken out</th>
              <th>Closed by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history?.dayCloses.map((c) => (
              <tr key={c.id} className={c.reopenedAt ? "cancelled" : undefined}>
                <td>{c.businessDate.slice(0, 10)}</td>
                <td className="num">{rupees(c.expectedCash)}</td>
                <td className="num">{rupees(c.countedCash)}</td>
                <td>{differenceText(c.difference)}</td>
                <td className="num">{c.handedOver ? `${rupees(c.handedOver)} ${c.handedOverTo === "BANK" ? "bank" : "owner"}` : ""}</td>
                <td>{c.closedBy.name}</td>
                <td>
                  {c.reopenedAt ? (
                    <span className="tag">Reopened</span>
                  ) : (
                    canReopen &&
                    c.id === latestId && (
                      <button type="button" className="link" onClick={() => void reopen(c)}>
                        Reopen
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
            {history?.dayCloses.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No day closed yet at this branch.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
