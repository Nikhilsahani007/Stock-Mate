import { roleHas } from "@stockpilot/shared";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, type DocumentDetail } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText } from "../components/Field";
import { ConfidenceTag, label, rupees } from "../components/inventory";
import { useApi } from "../useApi";
import { DOC_LABEL } from "./Documents";

/**
 * A document on screen and on paper. Sales print as a tax invoice when the
 * branch issues GST invoices, otherwise as a plain bill.
 */
export function DocumentView() {
  const { businessId, business, role } = useBusiness();
  const { documentId } = useParams();
  const { data, error, reload } = useApi<{ document: DocumentDetail }>(`/businesses/${businessId}/documents/${documentId}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const doc = data?.document;
  if (!doc) return <ErrorText error={error} />;

  const isSale = doc.type === "SALE";
  const hasPrices = ["SALE", "PURCHASE"].includes(doc.type);
  const showCost = doc.lines.some((l) => l.costTotal !== undefined);
  const title = isSale ? (doc.gstApplied ? "Tax invoice" : "Bill") : DOC_LABEL[doc.type];
  const canAct = business!.access.access === "FULL";

  async function act(path: string, body?: unknown) {
    try {
      await api(`/businesses/${businessId}/${path}`, { method: "POST", body });
      setActionError(null);
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  function cancel() {
    const reason = window.prompt("Why cancel this? It will be reversed, not deleted.");
    if (reason && reason.trim().length >= 3) void act(`documents/${doc!.id}/cancel`, { reason });
  }

  return (
    <>
      <div className="row no-print">
        <Link to="..">← All bills and entries</Link>
        <span className="spacer" />
        {isSale && <button onClick={() => window.print()}>Print</button>}
        {doc.type === "TRANSFER" && doc.status === "IN_TRANSIT" && canAct && roleHas(role!, "stock.transfer") && (
          <button onClick={() => void act(`transfers/${doc.id}/receive`)}>Mark received at {doc.toBranch?.name}</button>
        )}
        {doc.status !== "CANCELLED" && canAct && roleHas(role!, "document.cancel") && (doc.type !== "TRANSFER" || doc.status === "IN_TRANSIT") && (
          <button className="secondary" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
      <ErrorText error={actionError} />

      <article className="card document">
        <header className="doc-head">
          <div>
            <strong>{business!.name}</strong>
            <div>{doc.branch.name}</div>
            {doc.branch.address && <div className="muted">{doc.branch.address}</div>}
            {doc.branch.phone && <div className="muted">{doc.branch.phone}</div>}
            {doc.gstApplied && doc.branch.gstin && <div>GSTIN {doc.branch.gstin}</div>}
          </div>
          <div className="right">
            <h1>{title}</h1>
            <div>{doc.number}</div>
            <div>{doc.businessDate.slice(0, 10)}</div>
            {doc.status !== "POSTED" && <span className="tag warn">{label(doc.status)}</span>}
          </div>
        </header>

        {doc.status === "CANCELLED" && <div className="banner danger">Cancelled: {doc.cancelReason}</div>}
        {doc.party && (
          <div>
            <span className="muted">{isSale || doc.type === "RECEIPT" ? "Bill to" : "Supplier"}</span>
            <div>
              <strong>{doc.party.name}</strong>
              {doc.party.phone && ` · ${doc.party.phone}`}
            </div>
            {doc.party.gstin && <div>GSTIN {doc.party.gstin}</div>}
          </div>
        )}
        {doc.toBranch && (
          <div>
            {doc.branch.name} → <strong>{doc.toBranch.name}</strong>
          </div>
        )}
        {doc.reason && <div className="muted">{doc.type === "PURCHASE" ? `Supplier bill ${doc.reason}` : doc.reason}</div>}

        {doc.lines.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  {doc.gstApplied && <th>HSN</th>}
                  <th className="num">Qty</th>
                  {hasPrices && <th className="num">Rate</th>}
                  {doc.gstApplied && <th className="num">Taxable</th>}
                  {doc.gstApplied && <th className="num">GST</th>}
                  {hasPrices && <th className="num">Amount</th>}
                  {showCost && <th className="num no-print">Cost</th>}
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.variant.product.name} · {l.variant.name}
                      {l.serials.length > 0 && (
                        <div className="small muted">
                          {l.serials.map((s) => (s.serialUnit.imei2 ? `${s.serialUnit.imei} / ${s.serialUnit.imei2}` : s.serialUnit.imei)).join(", ")}
                        </div>
                      )}
                      {l.discount > 0 && <div className="small muted">Discount {rupees(l.discount)}</div>}
                    </td>
                    {doc.gstApplied && <td>{l.variant.product.hsnCode}</td>}
                    <td className="num">{l.quantity}</td>
                    {hasPrices && <td className="num">{rupees(l.unitPrice)}</td>}
                    {doc.gstApplied && <td className="num">{rupees(l.taxableValue)}</td>}
                    {doc.gstApplied && (
                      <td className="num small">
                        {l.igst ? `IGST ${rupees(l.igst)}` : `CGST ${rupees(l.cgst)} SGST ${rupees(l.sgst)}`}
                        <div className="muted">{l.gstRateBps / 100}%</div>
                      </td>
                    )}
                    {hasPrices && <td className="num">{rupees(l.lineTotal)}</td>}
                    {showCost && (
                      <td className="num no-print">
                        {rupees(l.costTotal)} <ConfidenceTag value={l.costConfidence} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <dl className="totals">
          {doc.gstApplied && hasPrices && (
            <>
              <dt>Taxable value</dt>
              <dd>{rupees(doc.taxableTotal)}</dd>
              <dt>GST</dt>
              <dd>{rupees(doc.taxTotal)}</dd>
            </>
          )}
          {doc.otherCharges > 0 && (
            <>
              <dt>Other charges</dt>
              <dd>{rupees(doc.otherCharges)}</dd>
            </>
          )}
          {doc.roundOff !== 0 && (
            <>
              <dt>Round off</dt>
              <dd>{rupees(doc.roundOff)}</dd>
            </>
          )}
          {doc.total > 0 && (
            <>
              <dt>Total</dt>
              <dd>
                <strong>{rupees(doc.total)}</strong>
              </dd>
            </>
          )}
          {doc.tenders.map((t) => (
            <span key={t.id} className="contents">
              <dt>Paid by {label(t.method)}</dt>
              <dd>{rupees(t.amount)}</dd>
            </span>
          ))}
          {["SALE", "PURCHASE", "EXPENSE"].includes(doc.type) && doc.status === "POSTED" && doc.paidAmount < doc.total && (
            <>
              <dt>Balance due</dt>
              <dd>{rupees(doc.total - doc.paidAmount)}</dd>
            </>
          )}
        </dl>

        {doc.allocationsFrom.filter((a) => a.to.id !== doc.id).length > 0 && (
          <p className="small">
            Settles:{" "}
            {doc.allocationsFrom
              .filter((a) => a.to.id !== doc.id)
              .map((a) => `${a.to.number} (${rupees(a.amount)})`)
              .join(", ")}
          </p>
        )}
        {doc.allocationsTo.filter((a) => a.from.id !== doc.id).length > 0 && (
          <p className="small">
            Payments received:{" "}
            {doc.allocationsTo
              .filter((a) => a.from.id !== doc.id)
              .map((a) => `${a.from.number} (${rupees(a.amount)})`)
              .join(", ")}
          </p>
        )}
        {doc.notes && <p className="small">{doc.notes}</p>}
        <p className="small muted">Entered by {doc.createdBy.name}</p>
      </article>
    </>
  );
}
