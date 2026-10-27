import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorText, Field } from "../components/Field";

export function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ businessId: string }>("/invitations/accept", { method: "POST", body: { ...form, token } });
      await refresh();
      void navigate(`/b/${res.businessId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card narrow" onSubmit={onSubmit}>
        <h1>Join your team on StockPilot</h1>
        {me ? (
          <p className="muted">You're signed in as {me.user.email}.</p>
        ) : (
          <>
            <Field label="Your name" name="name" autoComplete="name" required />
            <Field label="Choose a password" name="password" type="password" autoComplete="new-password" minLength={10} required />
          </>
        )}
        <ErrorText error={error} />
        <button disabled={busy || !token}>{busy ? "Joining…" : "Accept invitation"}</button>
      </form>
    </div>
  );
}
