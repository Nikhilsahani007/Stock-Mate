import { computeLine, roundInvoice } from "@stockpilot/shared";
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, newKey, postDocument, type PostResult, type SerialUnit } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText } from "../components/Field";
import { LineEditor, lineQuantity, newLine, type LineDraft } from "../components/LineItems";
import { BranchSelect, PartyPicker, TenderInputs, emptyTenders, rupees, tendersToBody, toPaise, useBranchChoice, useCatalog } from "../components/inventory";

export function NewSale() {
  const { businessId } = useBusiness();
  const navigate = useNavigate();
  const { branches, branchId, branch, setBranchId } = useBranchChoice(businessId);
  const { options } = useCatalog(businessId);
  const [partyId, setPartyId] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [tenders, setTenders] = useState(emptyTenders());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per sale on screen, so a double tap or retry never bills twice.
  const [key, setKey] = useState(newKey);

  const preview = useMemo(() => {
    const mode = { gstApplied: !!branch?.gstEnabled, pricesIncludeTax: true, interState: false };
    let exact = 0;
    for (const l of lines) {
      const o = options.find((x) => x.variant.id === l.variantId);
      const unitPrice = toPaise(l.unitPrice);
      if (!o || unitPrice === null) continue;
      try {
        exact += computeLine({ quantity: lineQuantity(l, o), unitPrice, discount: toPaise(l.discount) ?? 0, gstRateBps: o.product.gstRateBps }, mode).lineTotal;
      } catch {
        // Discount larger than the line; the server will say so.
      }
    }
    return roundInvoice(exact);
  }, [lines, options, branch]);
  const paid = tendersToBody(tenders).reduce((a, t) => a + t.amount, 0);

  /** Scanning an IMEI adds that phone as its own line, priced from the catalog. */
  async function onScan(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("scan") as HTMLInputElement;
    const id = input.value.replace(/\s+/g, "").toUpperCase();
    if (!id) return;
    try {
      const { units } = await api<{ units: SerialUnit[] }>(`/businesses/${businessId}/stock/serials?branchId=${branchId}&status=IN_STOCK&q=${encodeURIComponent(id)}`);
      const unit = units.find((u) => u.imei === id || u.imei2 === id);
      if (!unit) throw new Error(`${id} is not in stock at this branch`);
      if (lines.some((l) => l.serials.includes(unit.imei))) throw new Error(`${unit.imei} is already on this bill`);
      const price = options.find((o) => o.variant.id === unit.variantId)?.variant.salePrice;
      const existing = lines.find((l) => l.variantId === unit.variantId);
      const rest = lines.filter((l) => l.variantId !== "");
      setLines(
        existing
          ? lines.map((l) => (l === existing ? { ...l, serials: [...l.serials, unit.imei] } : l))
          : [...rest, newLine({ variantId: unit.variantId, serials: [unit.imei], unitPrice: price ? String(price / 100) : "" })],
      );
      input.value = "";
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onSubmit() {
    setBusy(true);
    try {
      const body = {
        branchId,
        partyId: partyId || undefined,
        lines: lines
          .filter((l) => l.variantId)
          .map((l) => {
            const o = options.find((x) => x.variant.id === l.variantId);
            const unitPrice = toPaise(l.unitPrice);
            if (unitPrice === null) throw new Error("Check the prices: use numbers like 1599 or 1599.50");
            return { variantId: l.variantId, quantity: lineQuantity(l, o), unitPrice, discount: toPaise(l.discount) ?? 0, serials: l.serials };
          }),
        tenders: tendersToBody(tenders),
      };
      if (body.lines.length === 0) throw new Error("Add at least one item");
      const res = await postDocument<PostResult>(`/businesses/${businessId}/sales`, body, key);
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
      <h1>New sale</h1>
      <div className="row">
        <BranchSelect branches={branches} value={branchId} onChange={setBranchId} />
      </div>
      <form className="row" onSubmit={onScan}>
        <input name="scan" aria-label="Scan IMEI" placeholder="Scan a phone's IMEI to add it" inputMode="numeric" autoFocus />
        <button className="secondary">Add</button>
      </form>
      {lines.map((l, i) => (
        <LineEditor
          key={l.key}
          line={l}
          options={options}
          serialMode={{ kind: "pick", businessId, branchId }}
          prefillSalePrice
          onChange={(line) => setLines(lines.map((x, j) => (j === i ? line : x)))}
          onRemove={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [newLine()])}
        >
          <input className="money" aria-label="Discount" placeholder="Discount ₹" inputMode="decimal" value={l.discount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, discount: e.target.value } : x)))} />
        </LineEditor>
      ))}
      <button type="button" className="secondary" onClick={() => setLines([...lines, newLine()])}>
        Add item
      </button>

      <div className="card">
        <PartyPicker businessId={businessId} kind="CUSTOMER" value={partyId} onChange={setPartyId} optional="Walk-in customer (paid in full)" />
        <p className="total">
          Total <strong>{rupees(preview.total)}</strong>
          {branch?.gstEnabled && <span className="muted"> incl. GST</span>}
        </p>
        <TenderInputs values={tenders} onChange={setTenders} />
        <div className="row">
          <button type="button" className="secondary" onClick={() => setTenders({ ...emptyTenders(), CASH: String(preview.total / 100) })}>
            All cash
          </button>
          <button type="button" className="secondary" onClick={() => setTenders({ ...emptyTenders(), UPI: String(preview.total / 100) })}>
            All UPI
          </button>
        </div>
        {paid < preview.total && <p className="muted">Balance due: {rupees(preview.total - paid)}</p>}
        <ErrorText error={error} />
        <button type="button" onClick={() => void onSubmit()} disabled={busy}>
          {busy ? "Saving…" : "Save and print"}
        </button>
      </div>
    </>
  );
}
