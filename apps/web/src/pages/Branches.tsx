import { roleHas } from "@stockpilot/shared";
import { useState, type FormEvent } from "react";
import { api, type Branch } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { useApi } from "../useApi";

export function Branches() {
  const { businessId, role, business } = useBusiness();
  const { data, error, reload } = useApi<{ branches: Branch[] }>(`/businesses/${businessId}/branches`);
  const [formError, setFormError] = useState<string | null>(null);
  const canCreate = roleHas(role!, "branch.create") && business!.access.access === "FULL";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const form = new FormData(el);
    const gstEnabled = form.get("gstEnabled") === "on";
    try {
      await api(`/businesses/${businessId}/branches`, {
        method: "POST",
        body: {
          name: form.get("name"),
          address: form.get("address") || undefined,
          gstEnabled,
          gstin: gstEnabled ? form.get("gstin") : undefined,
        },
      });
      el.reset();
      setFormError(null);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Branches</h1>
      <ErrorText error={error} />
      <ul className="list">
        {data?.branches.map((b) => (
          <li key={b.id} className="card">
            <strong>{b.name}</strong>
            {b.address && <span className="muted">{b.address}</span>}
            <span className={b.gstEnabled ? "tag" : "tag muted"}>{b.gstEnabled ? `GST · ${b.gstin}` : "Non-GST"}</span>
          </li>
        ))}
      </ul>
      {canCreate && (
        <form className="card" onSubmit={onSubmit}>
          <h2>Add a branch</h2>
          <Field label="Name" name="name" required maxLength={80} />
          <Field label="Address" name="address" maxLength={300} />
          <label className="check">
            <input type="checkbox" name="gstEnabled" /> Issue GST invoices from this branch
          </label>
          <Field label="GSTIN (if GST is on)" name="gstin" maxLength={15} />
          <ErrorText error={formError} />
          <button>Add branch</button>
        </form>
      )}
    </>
  );
}
