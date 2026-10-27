import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { newKey, postDocument, type DocumentDetail, type DocumentSummary, type PostResult } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { LineEditor, lineQuantity, newLine, type LineDraft } from "../components/LineItems";
import { BranchSelect, PartyPicker, TenderInputs, emptyTenders, paiseToInput, rupees, tendersToBody, toPaise, useBranchChoice, useCatalog } from "../components/inventory";
import { useApi } from "../useApi";

/**
 * Send goods back to a supplier: stock in hand, or phones a customer returned
 * damaged. Prices are what the supplier credits per unit, before GST.
 */
export function PurchaseReturn() {
  const { businessId } = useBusiness();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { branches, branchId, setBranchId } = useBranchChoice(businessId);
  const { options } = useCatalog(businessId);
  const [partyId, setPartyId] = useState(params.get("partyId") ?? "");
  const [purchaseId, setPurchaseId] = useState(params.get("purchaseId") ?? "");
  const [reason, setReason] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [refunds, setRefunds] = useState(emptyTenders());
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bills = useApi<{ documents: DocumentSummary[] }>(
    partyId && branchId ? `/businesses/${businessId}/documents?type=PURCHASE&status=POSTED&partyId=${partyId}&branchId=${branchId}&limit=50` : "",
  );
  const bill = useApi<{ document: DocumentDetail }>(purchaseId ? `/businesses/${businessId}/documents/${purchaseId}` : "");
  const billLine = (variantId: string) => bill.data?.document.lines.find((l) => l.variant.id === variantId);

  async function submit() {
    setBusy(true);
    try {
      if (!partyId) throw new Error("Choose the supplier");
      const body = {
        branchId,
        partyId,
        purchaseId: purchaseId || undefined,
        supplierRef: supplierRef || undefined,
        reason,
        lines: lines
          .filter((l) => l.variantId)
          .map((l) => {
            const unitPrice = toPaise(l.unitPrice);
            if (unitPrice === null) throw new Error("Check the prices: use numbers like 12000 or 12000.50");
            return { variantId: l.variantId, quantity: lineQuantity(l, options.find((o) => o.variant.id === l.variantId)), unitPrice, serials: l.serials };
          }),
        refunds: tendersToBody(refunds),
      };
      if (body.lines.length === 0) throw new Error("Add at least one item");
      const res = await postDocument<PostResult>(`/businesses/${businessId}/purchase-returns`, body, key);
      setKey(newKey());
      void navigate(`../documents/${res.document.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Return to supplier</h1>
      <div className="card">
        <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
        <PartyPicker businessId={businessId} kind="SUPPLIER" value={partyId} onChange={(id) => (setPartyId(id), setPurchaseId(""))} />
        {partyId && (
          <label className="field">
            <span>Their bill (optional)</span>
            <select value={purchaseId} onChange={(e) => setPurchaseId(e.target.value)}>
              <option value="">Not linked to a bill</option>
              {bills.data?.documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.number} · {d.businessDate.slice(0, 10)} · {rupees(d.total)}
                </option>
              ))}
            </select>
          </label>
        )}
        <Field label="Their credit note number" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} maxLength={60} />
        <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Defective, wrong model, excess stock…" maxLength={300} />
      </div>
      {lines.map((l, i) => (
        <LineEditor
          key={l.key}
          line={l}
          options={options}
          serialMode={{ kind: "pick", businessId, branchId, statuses: ["IN_STOCK", "RETURNED_DAMAGED"] }}
          onChange={(line) => {
            const fromBill = line.variantId !== l.variantId && !line.unitPrice ? billLine(line.variantId) : undefined;
            setLines(lines.map((x, j) => (j === i ? (fromBill ? { ...line, unitPrice: paiseToInput(fromBill.unitPrice) } : line) : x)));
          }}
          onRemove={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [newLine()])}
        />
      ))}
      <button type="button" className="secondary" onClick={() => setLines([...lines, newLine()])}>
        Add item
      </button>
      <div className="card">
        <p className="muted small">Prices are what the supplier credits per unit, before GST. GST is added at each product's rate.</p>
        <h2>Refund received now (optional)</h2>
        <TenderInputs values={refunds} onChange={setRefunds} />
        <p className="muted small">Anything not refunded reduces what you owe this supplier, starting with the bill chosen above.</p>
        <ErrorText error={error} />
        <button type="button" onClick={() => void submit()} disabled={busy || reason.trim().length < 3}>
          {busy ? "Saving…" : "Save debit note"}
        </button>
      </div>
    </>
  );
}
