import { roleHas } from "@stockpilot/shared";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { rupees, toPaise, useCatalog } from "../components/inventory";

const GST_RATES = [0, 500, 1200, 1800, 2800, 4000];

interface VariantDraft {
  name: string;
  salePrice: string;
  mrp: string;
  sku: string;
}
const blankVariant = (): VariantDraft => ({ name: "", salePrice: "", mrp: "", sku: "" });

export function Products() {
  const { businessId, role, business } = useBusiness();
  const { products, reload } = useCatalog(businessId);
  const [q, setQ] = useState("");
  const [variants, setVariants] = useState<VariantDraft[]>([blankVariant()]);
  const [error, setError] = useState<string | null>(null);
  const canEdit = roleHas(role!, "catalog.manage") && business!.access.access === "FULL";

  const shown = products.filter((p) => {
    const t = q.trim().toLowerCase();
    return !t || p.name.toLowerCase().includes(t) || p.variants.some((v) => v.name.toLowerCase().includes(t) || v.sku === q || v.barcode === q);
  });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const form = new FormData(el);
    const body = {
      name: form.get("name"),
      isSerialized: form.get("isSerialized") === "on",
      hsnCode: form.get("hsnCode") || undefined,
      gstRateBps: Number(form.get("gstRateBps")),
      variants: variants.map((v) => ({
        name: v.name.trim() || "Standard",
        salePrice: toPaise(v.salePrice) || undefined,
        mrp: toPaise(v.mrp) || undefined,
        sku: v.sku.trim() || undefined,
      })),
    };
    try {
      await api(`/businesses/${businessId}/catalog/products`, { method: "POST", body });
      el.reset();
      setVariants([blankVariant()]);
      setError(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const setVariant = (i: number, patch: Partial<VariantDraft>) => setVariants(variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <>
      <h1>Products</h1>
      <input aria-label="Search products" placeholder="Search by name, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Variant</th>
              <th>Tracking</th>
              <th>GST</th>
              <th className="num">Sale price</th>
            </tr>
          </thead>
          <tbody>
            {shown.flatMap((p) =>
              p.variants.map((v, i) => (
                <tr key={v.id}>
                  <td>{i === 0 ? p.name : ""}</td>
                  <td>
                    {v.name}
                    {v.sku && <span className="muted"> · {v.sku}</span>}
                  </td>
                  <td>{p.isSerialized ? "IMEI" : "Quantity"}</td>
                  <td>{p.gstRateBps / 100}%</td>
                  <td className="num">{rupees(v.salePrice)}</td>
                </tr>
              )),
            )}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No products yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <form className="card" onSubmit={onSubmit}>
          <h2>Add a product</h2>
          <Field label="Name" name="name" required maxLength={120} placeholder="Galaxy A15" />
          <label className="check">
            <input type="checkbox" name="isSerialized" /> Track each unit by IMEI or serial number (phones, tablets, watches)
          </label>
          <div className="row">
            <Field label="HSN code" name="hsnCode" inputMode="numeric" maxLength={8} placeholder="8517" />
            <label className="field">
              <span>GST rate</span>
              <select name="gstRateBps" defaultValue={1800}>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r / 100}%
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="field">
            <legend>Variants (storage, colour, model)</legend>
            {variants.map((v, i) => (
              <div className="row" key={i}>
                <input aria-label="Variant name" placeholder="6GB/128GB Black" value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} />
                <input aria-label="Sale price" placeholder="Sale price ₹" inputMode="decimal" value={v.salePrice} onChange={(e) => setVariant(i, { salePrice: e.target.value })} />
                <input aria-label="MRP" placeholder="MRP ₹" inputMode="decimal" value={v.mrp} onChange={(e) => setVariant(i, { mrp: e.target.value })} />
                <input aria-label="SKU" placeholder="SKU" value={v.sku} onChange={(e) => setVariant(i, { sku: e.target.value })} />
              </div>
            ))}
            <button type="button" className="secondary" onClick={() => setVariants([...variants, blankVariant()])}>
              Add variant
            </button>
          </fieldset>
          <ErrorText error={error} />
          <button>Save product</button>
        </form>
      )}
    </>
  );
}
