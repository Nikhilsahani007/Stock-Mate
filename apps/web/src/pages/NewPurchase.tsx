import { useState } from "react";
import { useNavigate } from "react-router";
import { newKey, postDocument, type PostResult } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { LineEditor, lineQuantity, newLine, parseNewSerial, type LineDraft } from "../components/LineItems";
import { BranchSelect, PartyPicker, TenderInputs, emptyTenders, tendersToBody, toPaise, useBranchChoice, useCatalog } from "../components/inventory";

const GST_RATES = [0, 500, 1200, 1800, 2800, 4000];

export function NewPurchase() {
  const { businessId } = useBusiness();
  const navigate = useNavigate();
  const { branches, branchId, setBranchId } = useBranchChoice(businessId);
  const { options } = useCatalog(businessId);
  const [partyId, setPartyId] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [inclusive, setInclusive] = useState(false);
  const [charges, setCharges] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [tenders, setTenders] = useState(emptyTenders());
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newKey);

  async function onSubmit() {
    setBusy(true);
    try {
      if (!partyId) throw new Error("Choose the supplier");
      const body = {
        branchId,
        partyId,
        supplierRef: supplierRef || undefined,
        pricesIncludeTax: inclusive,
        otherCharges: toPaise(charges) ?? 0,
        lines: lines
          .filter((l) => l.variantId)
          .map((l) => {
            const o = options.find((x) => x.variant.id === l.variantId);
            const unitPrice = toPaise(l.unitPrice);
            if (unitPrice === null) throw new Error("Check the prices: use numbers like 12000 or 12000.50");
            return {
              variantId: l.variantId,
              quantity: lineQuantity(l, o),
              unitPrice,
              gstRateBps: l.gstRateBps ?? o?.product.gstRateBps,
              serials: l.serials.map(parseNewSerial),
            };
          }),
        tenders: tendersToBody(tenders),
      };
      if (body.lines.length === 0) throw new Error("Add at least one item");
      const res = await postDocument<PostResult>(`/businesses/${businessId}/purchases`, body, key);
      setKey(newKey());
      setWarnings(res.warnings);
      if (res.warnings.length === 0) void navigate(`../documents/${res.document.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>New purchase</h1>
      <div className="card">
        <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
        <PartyPicker businessId={businessId} kind="SUPPLIER" value={partyId} onChange={setPartyId} />
        <Field label="Supplier's bill number" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} maxLength={60} />
        <label className="check">
          <input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /> Prices on the bill include GST
        </label>
      </div>
      {lines.map((l, i) => {
        const o = options.find((x) => x.variant.id === l.variantId);
        const update = (line: LineDraft) => setLines(lines.map((x, j) => (j === i ? line : x)));
        return (
          <LineEditor
            key={l.key}
            line={l}
            options={options}
            serialMode={{ kind: "new" }}
            onChange={update}
            onRemove={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [newLine()])}
          >
            {o && (
              <label className="field inline">
                <span>GST</span>
                <select value={l.gstRateBps ?? o.product.gstRateBps} onChange={(e) => update({ ...l, gstRateBps: Number(e.target.value) })}>
                  {GST_RATES.map((r) => (
                    <option key={r} value={r}>
                      {r / 100}%
                    </option>
                  ))}
                </select>
              </label>
            )}
          </LineEditor>
        );
      })}
      <button type="button" className="secondary" onClick={() => setLines([...lines, newLine()])}>
        Add item
      </button>
      <div className="card">
        <Field label="Freight or other charges ₹" inputMode="decimal" value={charges} onChange={(e) => setCharges(e.target.value)} />
        <p className="muted small">Charges are spread over the items by value, so each item's cost includes its share.</p>
        <h2>Paid now (optional)</h2>
        <TenderInputs values={tenders} onChange={setTenders} />
        <ErrorText error={error} />
        {warnings.length > 0 && (
          <div className="banner warn">
            Saved. {warnings.join(". ")}.
          </div>
        )}
        <button type="button" onClick={() => void onSubmit()} disabled={busy}>
          {busy ? "Saving…" : "Save purchase"}
        </button>
      </div>
    </>
  );
}
