import { amountInWords } from "@stockpilot/shared";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import type { DocumentDetail } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText } from "../components/Field";
import { label, rupees } from "../components/inventory";
import { useApi } from "../useApi";

/**
 * A sale as a till receipt for 58 or 80 mm thermal printers. Printing uses the
 * browser's (or the desktop app's) print dialog with the paper size set here.
 */
export function Receipt() {
  const { businessId, business } = useBusiness();
  const { documentId } = useParams();
  const { data, error } = useApi<{ document: DocumentDetail }>(`/businesses/${businessId}/documents/${documentId}`);
  const doc = data?.document;

  useEffect(() => {
    document.body.classList.add("printing-receipt");
    return () => document.body.classList.remove("printing-receipt");
  }, []);

  if (!doc) return <ErrorText error={error} />;
  const tax = doc.lines.reduce((a, l) => a + l.cgst + l.sgst + l.igst, 0);

  return (
    <>
      <style>{"@page { size: 80mm auto; margin: 3mm; }"}</style>
      <div className="row no-print">
        <Link to=".." relative="path">
          ← {doc.number}
        </Link>
        <span className="spacer" />
        <button onClick={() => window.print()}>Print receipt</button>
      </div>
      <article className="receipt">
        <header>
          <strong>{business!.name}</strong>
          <div>{doc.branch.name}</div>
          {doc.branch.address && <div>{doc.branch.address}</div>}
          {doc.branch.phone && <div>Ph {doc.branch.phone}</div>}
          {doc.gstApplied && doc.branch.gstin && <div>GSTIN {doc.branch.gstin}</div>}
          <div className="receipt-title">{doc.gstApplied ? "TAX INVOICE" : "BILL"}</div>
          <div>
            {doc.number} · {doc.businessDate.slice(0, 10)}
          </div>
          {doc.party && <div>To: {doc.party.name}</div>}
        </header>
        <table>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.variant.product.name} {l.variant.name}
                  {l.serials.map((s) => (
                    <div key={s.serialUnit.id} className="imei">
                      IMEI {s.serialUnit.imei}
                    </div>
                  ))}
                  <div>
                    {l.quantity} × {rupees(l.unitPrice)}
                    {l.discount > 0 ? ` − ${rupees(l.discount)}` : ""}
                  </div>
                </td>
                <td className="num">{rupees(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl>
          {doc.gstApplied && (
            <>
              <dt>Taxable</dt>
              <dd>{rupees(doc.taxableTotal)}</dd>
              <dt>GST</dt>
              <dd>{rupees(tax)}</dd>
            </>
          )}
          {doc.roundOff !== 0 && (
            <>
              <dt>Round off</dt>
              <dd>{rupees(doc.roundOff)}</dd>
            </>
          )}
          <dt className="grand">TOTAL</dt>
          <dd className="grand">{rupees(doc.total)}</dd>
          {doc.tenders.map((t) => (
            <span key={t.id} className="contents">
              <dt>{label(t.method)}</dt>
              <dd>{rupees(t.amount)}</dd>
            </span>
          ))}
          {doc.paidAmount < doc.total && doc.status === "POSTED" && (
            <>
              <dt>Balance due</dt>
              <dd>{rupees(doc.total - doc.paidAmount)}</dd>
            </>
          )}
        </dl>
        <p>{amountInWords(doc.total)}</p>
        {doc.status === "CANCELLED" && <p className="receipt-title">CANCELLED</p>}
        <footer>Thank you. Visit again.</footer>
      </article>
    </>
  );
}
