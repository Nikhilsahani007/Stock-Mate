import { useEffect, useState, type ReactNode } from "react";
import { api, type SerialUnit } from "../api";
import { VariantPicker, type VariantOption } from "./inventory";

/**
 * One editable document line. Phones carry IMEIs: picked from what is in
 * stock ("pick"), or typed and scanned in as they arrive ("new").
 */
export interface LineDraft {
  key: string;
  variantId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  gstRateBps?: number;
  serials: string[];
}

export const newLine = (patch: Partial<LineDraft> = {}): LineDraft => ({
  key: crypto.randomUUID(),
  variantId: "",
  quantity: "1",
  unitPrice: "",
  discount: "",
  serials: [],
  ...patch,
});

/** Quantity is the number of IMEIs for tracked products, else what was typed. */
export function lineQuantity(line: LineDraft, option: VariantOption | undefined) {
  return option?.product.isSerialized ? line.serials.length : Number(line.quantity) || 0;
}

export function SerialChooser({
  businessId,
  branchId,
  variantId,
  selected,
  onChange,
}: {
  businessId: string;
  branchId: string;
  variantId: string;
  selected: string[];
  onChange: (serials: string[]) => void;
}) {
  const [units, setUnits] = useState<SerialUnit[]>([]);
  useEffect(() => {
    if (!branchId || !variantId) return;
    void api<{ units: SerialUnit[] }>(`/businesses/${businessId}/stock/serials?branchId=${branchId}&variantId=${variantId}&status=IN_STOCK`).then((r) =>
      setUnits(r.units),
    );
  }, [businessId, branchId, variantId]);

  if (units.length === 0 && selected.length === 0) return <p className="muted small">None of this model in stock here.</p>;
  const all = [...new Set([...selected, ...units.map((u) => u.imei)])];
  return (
    <div className="serials">
      {all.map((imei) => (
        <label key={imei} className="check">
          <input
            type="checkbox"
            checked={selected.includes(imei)}
            onChange={(e) => onChange(e.target.checked ? [...selected, imei] : selected.filter((s) => s !== imei))}
          />
          <code>{imei}</code>
        </label>
      ))}
    </div>
  );
}

/** One IMEI per line, as a scanner types them. A second IMEI can follow on the same line after a comma or slash. */
export function SerialTextarea({ value, onChange }: { value: string[]; onChange: (serials: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <textarea
      aria-label="IMEIs"
      rows={Math.min(8, Math.max(2, value.length + 1))}
      placeholder={"Scan IMEIs, one per line\n(dual SIM: IMEI1, IMEI2)"}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

export function parseNewSerial(entry: string) {
  const [imei, imei2] = entry.split(/[,/]/).map((s) => s.replace(/\s+/g, ""));
  return imei2 ? { imei: imei!, imei2 } : { imei: imei! };
}

export function LineEditor({
  line,
  options,
  onChange,
  onRemove,
  serialMode,
  price = true,
  prefillSalePrice = false,
  children,
}: {
  line: LineDraft;
  options: VariantOption[];
  onChange: (line: LineDraft) => void;
  onRemove: () => void;
  serialMode: { kind: "pick"; businessId: string; branchId: string } | { kind: "new" };
  price?: boolean;
  /** Fill the price from the catalog's sale price when a product is chosen (sales only). */
  prefillSalePrice?: boolean;
  children?: ReactNode;
}) {
  const option = options.find((o) => o.variant.id === line.variantId);
  const serialized = option?.product.isSerialized ?? false;
  return (
    <div className="line card">
      <div className="row">
        <div className="field grow">
          <VariantPicker
            options={options}
            value={line.variantId}
            onChange={(variantId) => {
              const o = options.find((x) => x.variant.id === variantId);
              const salePrice = prefillSalePrice && o?.variant.salePrice ? String(o.variant.salePrice / 100) : "";
              onChange({ ...line, variantId, serials: [], unitPrice: line.unitPrice || salePrice });
            }}
          />
        </div>
        {!serialized && (
          <input className="qty" aria-label="Quantity" inputMode="numeric" value={line.quantity} onChange={(e) => onChange({ ...line, quantity: e.target.value })} />
        )}
        {price && (
          <input className="money" aria-label="Unit price" placeholder="Price ₹" inputMode="decimal" value={line.unitPrice} onChange={(e) => onChange({ ...line, unitPrice: e.target.value })} />
        )}
        <button type="button" className="link" onClick={onRemove} aria-label="Remove line">
          ✕
        </button>
      </div>
      {children && <div className="row">{children}</div>}
      {serialized &&
        (serialMode.kind === "pick" ? (
          <SerialChooser businessId={serialMode.businessId} branchId={serialMode.branchId} variantId={line.variantId} selected={line.serials} onChange={(serials) => onChange({ ...line, serials })} />
        ) : (
          <SerialTextarea value={line.serials} onChange={(serials) => onChange({ ...line, serials })} />
        ))}
      {serialized && <span className="muted small">{line.serials.length} selected</span>}
    </div>
  );
}
