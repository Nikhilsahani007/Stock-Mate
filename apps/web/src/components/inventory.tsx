import { formatPaise, rupeesToPaise } from "@stockpilot/shared";
import { useEffect, useMemo, useState } from "react";
import { api, type Branch, type Party, type Product, type Variant } from "../api";
import { useApi } from "../useApi";

export const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? "—" : formatPaise(paise));

/** Parses a rupee amount typed by a person ("1,599.50" or "1599"). Empty means zero; junk means null. */
export function toPaise(value: string): number | null {
  const clean = value.replace(/[,\s₹]/g, "");
  if (clean === "") return 0;
  try {
    return rupeesToPaise(clean);
  } catch {
    return null;
  }
}

export const paiseToInput = (paise: number | null | undefined) => (paise ? (paise / 100).toFixed(2).replace(/\.00$/, "") : "");

const ACRONYMS = new Set(["UPI", "GST", "IMEI"]);
export const label = (s: string) => (ACRONYMS.has(s) ? s : s.charAt(0) + s.slice(1).toLowerCase().replaceAll("_", " "));

/** The member's branches, plus the one they last worked in (remembered on this device). */
export function useBranchChoice(businessId: string) {
  const { data } = useApi<{ branches: Branch[] }>(`/businesses/${businessId}/branches`);
  const storageKey = `stockpilot:branch:${businessId}`;
  const [branchId, setBranchId] = useState<string>(() => {
    try {
      return localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });
  const branches = data?.branches ?? [];
  const valid = branches.some((b) => b.id === branchId) ? branchId : (branches[0]?.id ?? "");

  function choose(id: string) {
    setBranchId(id);
    try {
      localStorage.setItem(storageKey, id);
    } catch {
      // Private mode: just don't remember it.
    }
  }
  return { branches, branchId: valid, branch: branches.find((b) => b.id === valid), setBranchId: choose };
}

export function BranchSelect({ branches, value, onChange, label: text = "Branch" }: { branches: Branch[]; value: string; onChange: (id: string) => void; label?: string }) {
  if (branches.length <= 1 && text === "Branch") return null;
  return (
    <label className="field">
      <span>{text}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface VariantOption {
  variant: Variant;
  product: Product;
  label: string;
}

/** Every active variant as "Product · Variant", for pickers. */
export function useCatalog(businessId: string) {
  const { data, reload } = useApi<{ products: Product[] }>(`/businesses/${businessId}/catalog/products`);
  const options = useMemo<VariantOption[]>(
    () =>
      (data?.products ?? []).flatMap((product) =>
        product.variants
          .filter((v) => !v.archivedAt)
          .map((variant) => ({ variant, product, label: `${product.name} · ${variant.name}` })),
      ),
    [data],
  );
  return { products: data?.products ?? [], options, reload };
}

/** Type to search, or scan a barcode or SKU. */
export function VariantPicker({ options, value, onChange }: { options: VariantOption[]; value: string; onChange: (variantId: string) => void }) {
  const current = options.find((o) => o.variant.id === value);
  const [text, setText] = useState(current?.label ?? "");
  const listId = useMemo(() => `variants-${Math.random().toString(36).slice(2)}`, []);

  const match = (t: string) => options.find((o) => o.label === t || (t && (o.variant.barcode === t || o.variant.sku === t)));

  useEffect(() => {
    if (current) setText(current.label);
  }, [current]);

  // Text typed or scanned before the catalog finished loading still gets matched.
  useEffect(() => {
    const m = !value && text ? match(text) : undefined;
    if (m) onChange(m.variant.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  function onText(t: string) {
    setText(t);
    const m = match(t);
    if (m) onChange(m.variant.id);
  }

  return (
    <>
      <input aria-label="Product" placeholder="Product, SKU or barcode" list={listId} value={text} onChange={(e) => onText(e.target.value)} />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.variant.id} value={o.label} />
        ))}
      </datalist>
    </>
  );
}

/** Choose a customer or supplier, or add one without leaving the form. */
export function PartyPicker({
  businessId,
  kind,
  value,
  onChange,
  optional,
}: {
  businessId: string;
  kind: "CUSTOMER" | "SUPPLIER";
  value: string;
  onChange: (id: string) => void;
  optional?: string;
}) {
  const { data, reload } = useApi<{ parties: Party[] }>(`/businesses/${businessId}/parties?kind=${kind}`);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    try {
      const res = await api<{ party: Party }>(`/businesses/${businessId}/parties`, {
        method: "POST",
        body: { kind, name, phone: phone || undefined },
      });
      await reload();
      onChange(res.party.id);
      setAdding(false);
      setName("");
      setPhone("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="field">
      <span>{kind === "CUSTOMER" ? "Customer" : "Supplier"}</span>
      <div className="row">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{optional ?? "Choose…"}</option>
          {data?.parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.phone ? ` · ${p.phone}` : ""}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "New"}
        </button>
      </div>
      {adding && (
        <div className="row">
          <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Mobile" placeholder="Mobile (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button type="button" onClick={() => void add()} disabled={!name.trim()}>
            Add
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export const PAYMENT_METHODS = ["CASH", "UPI", "CARD", "BANK"] as const;
export type Method = (typeof PAYMENT_METHODS)[number];

/** Amounts paid by each method; blank methods are left out. */
export function TenderInputs({ values, onChange }: { values: Record<Method, string>; onChange: (v: Record<Method, string>) => void }) {
  return (
    <div className="tenders">
      {PAYMENT_METHODS.map((m) => (
        <label key={m} className="field">
          <span>{label(m)}</span>
          <input inputMode="decimal" value={values[m]} onChange={(e) => onChange({ ...values, [m]: e.target.value })} placeholder="0" />
        </label>
      ))}
    </div>
  );
}

export const emptyTenders = (): Record<Method, string> => ({ CASH: "", UPI: "", CARD: "", BANK: "" });

export function tendersToBody(values: Record<Method, string>) {
  return PAYMENT_METHODS.flatMap((method) => {
    const amount = toPaise(values[method]);
    return amount ? [{ method, amount }] : [];
  });
}

/** Flags costs that are estimated or unknown; verified costs need no label. */
export function ConfidenceTag({ value }: { value: string | null | undefined }) {
  if (!value || value === "VERIFIED") return null;
  return <span className={`tag conf-${value.toLowerCase()}`}>{label(value)}</span>;
}
