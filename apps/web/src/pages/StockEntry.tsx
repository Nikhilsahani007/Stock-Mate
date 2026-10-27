import { roleHas } from "@stockpilot/shared";
import { useState } from "react";
import { useNavigate } from "react-router";
import { newKey, postDocument, type PostResult } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { LineEditor, lineQuantity, newLine, parseNewSerial, type LineDraft } from "../components/LineItems";
import { BranchSelect, toPaise, useBranchChoice, useCatalog } from "../components/inventory";

type Mode = "opening" | "loss" | "found" | "transfer";

const MODES: { mode: Mode; label: string; permission: "stock.adjust" | "stock.transfer"; help: string }[] = [
  { mode: "opening", label: "Opening stock", permission: "stock.adjust", help: "Stock you already had when you started using StockPilot. Leave the cost blank if you don't know it; profit on those items shows as unknown until fixed." },
  { mode: "transfer", label: "Send to branch", permission: "stock.transfer", help: "Stock leaves this branch now and arrives when the other branch receives it." },
  { mode: "loss", label: "Damaged or lost", permission: "stock.adjust", help: "Writes stock off at its cost. A reason is required." },
  { mode: "found", label: "Found stock", permission: "stock.adjust", help: "Adds accessories found during a count, at their average cost unless you enter one." },
];

export function StockEntry() {
  const { businessId, role } = useBusiness();
  const navigate = useNavigate();
  const { branches, branchId, setBranchId } = useBranchChoice(businessId);
  const { options } = useCatalog(businessId);
  const allowed = MODES.filter((m) => roleHas(role!, m.permission));
  const [mode, setMode] = useState<Mode>(allowed[0]?.mode ?? "opening");
  const [toBranchId, setToBranchId] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine({ unitPrice: "" })]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newKey);
  const current = MODES.find((m) => m.mode === mode)!;
  const others = branches.filter((b) => b.id !== branchId);

  async function onSubmit() {
    setBusy(true);
    try {
      const filled = lines.filter((l) => l.variantId);
      if (filled.length === 0) throw new Error("Add at least one item");
      const qty = (l: LineDraft) => lineQuantity(l, options.find((o) => o.variant.id === l.variantId));
      let path: string;
      let body: unknown;
      if (mode === "opening") {
        path = "opening-stock";
        body = {
          branchId,
          lines: filled.map((l) => ({
            variantId: l.variantId,
            quantity: qty(l),
            unitCost: l.unitPrice.trim() ? (toPaise(l.unitPrice) ?? undefined) : undefined,
            serials: l.serials.map(parseNewSerial),
          })),
        };
      } else if (mode === "transfer") {
        path = "transfers";
        body = { branchId, toBranchId: toBranchId || others[0]?.id, lines: filled.map((l) => ({ variantId: l.variantId, quantity: qty(l), serials: l.serials })) };
      } else {
        path = "adjustments";
        const sign = mode === "loss" ? -1 : 1;
        body = {
          branchId,
          reason,
          lines: filled.map((l) => ({
            variantId: l.variantId,
            quantity: sign * qty(l),
            unitCost: mode === "found" && l.unitPrice.trim() ? (toPaise(l.unitPrice) ?? undefined) : undefined,
            serials: l.serials,
          })),
        };
      }
      const res = await postDocument<PostResult>(`/businesses/${businessId}/${path}`, body, key);
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
      <h1>Stock entry</h1>
      <div className="tabs" role="tablist">
        {allowed.map((m) => (
          <button
            key={m.mode}
            role="tab"
            type="button"
            aria-selected={mode === m.mode}
            className={mode === m.mode ? "" : "secondary"}
            onClick={() => {
              setMode(m.mode);
              setLines([newLine({ unitPrice: "" })]);
              setError(null);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="muted">{current.help}</p>
      <div className="card">
        <BranchSelect branches={branches} value={branchId} onChange={setBranchId} label={mode === "transfer" ? "From branch" : "Branch"} />
        {mode === "transfer" &&
          (others.length === 0 ? (
            <p className="muted">Add a second branch first.</p>
          ) : (
            <BranchSelect branches={others} value={toBranchId || others[0]!.id} onChange={setToBranchId} label="To branch" />
          ))}
        {(mode === "loss" || mode === "found") && <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Screen cracked in display" />}
      </div>
      {lines.map((l, i) => (
        <LineEditor
          key={l.key}
          line={l}
          options={options}
          price={mode === "opening" || mode === "found"}
          serialMode={mode === "opening" ? { kind: "new" } : { kind: "pick", businessId, branchId }}
          onChange={(line) => setLines(lines.map((x, j) => (j === i ? line : x)))}
          onRemove={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [newLine()])}
        />
      ))}
      {(mode === "opening" || mode === "found") && <p className="muted small">The price box is the cost of one unit.</p>}
      <button type="button" className="secondary" onClick={() => setLines([...lines, newLine({ unitPrice: "" })])}>
        Add item
      </button>
      <ErrorText error={error} />
      <button type="button" onClick={() => void onSubmit()} disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </>
  );
}
