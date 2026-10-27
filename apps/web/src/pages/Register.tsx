import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorText, Field } from "../components/Field";

export function Register() {
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError(null);
    try {
      await api("/auth/register", { method: "POST", body: form });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card narrow" onSubmit={onSubmit}>
        <h1>Start your free trial</h1>
        <p className="muted">14 days, no payment needed.</p>
        <Field label="Shop name" name="businessName" required maxLength={120} />
        <Field label="Your name" name="name" autoComplete="name" required maxLength={100} />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        <ErrorText error={error} />
        <button disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        <p className="muted">
          Already have an account? <Link to="/">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
