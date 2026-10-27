import { useState } from "react";
import { Link } from "react-router";
import type { DocumentSummary, DocumentType } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText } from "../components/Field";
import { label, rupees } from "../components/inventory";
import { useApi } from "../useApi";

export const DOC_LABEL: Record<DocumentType, string> = {
  SALE: "Sale",
  PURCHASE: "Purchase",
  OPENING_STOCK: "Opening stock",
  ADJUSTMENT: "Adjustment",
  TRANSFER: "Transfer",
  EXPENSE: "Expense",
  RECEIPT: "Receipt",
  PAYMENT: "Supplier payment",
  DAY_CLOSE: "Day close",
  SALE_RETURN: "Sale return",
  PURCHASE_RETURN: "Purchase return",
};

export function Documents() {
  const { businessId } = useBusiness();
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const { data, error } = useApi<{ documents: DocumentSummary[] }>(
    `/businesses/${businessId}/documents?limit=100${type ? `&type=${type}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
  );

  return (
    <>
      <h1>Bills and entries</h1>
      <div className="row">
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            {Object.entries(DOC_LABEL).map(([t, l]) => (
              <option key={t} value={t}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Number</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="INV/2026-27/0012" />
        </label>
      </div>
      <ErrorText error={error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Number</th>
              <th>Type</th>
              <th>Party</th>
              <th className="num">Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data?.documents.map((d) => (
              <tr key={d.id} className={d.status === "CANCELLED" ? "cancelled" : undefined}>
                <td>{d.businessDate.slice(0, 10)}</td>
                <td>
                  <Link to={d.id}>{d.number}</Link>
                </td>
                <td>{d.type === "EXPENSE" && d.expenseCategory ? `Expense · ${label(d.expenseCategory)}` : DOC_LABEL[d.type]}</td>
                <td>{d.party?.name ?? ""}</td>
                <td className="num">{d.total ? rupees(d.total) : ""}</td>
                <td>
                  {d.status !== "POSTED" ? (
                    <span className="tag">{label(d.status)}</span>
                  ) : ["SALE", "PURCHASE", "EXPENSE"].includes(d.type) && d.paidAmount < d.total ? (
                    <span className="tag warn">Due {rupees(d.total - d.paidAmount)}</span>
                  ) : null}
                </td>
              </tr>
            ))}
            {data?.documents.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
