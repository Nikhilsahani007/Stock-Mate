import { ALL_BRANCH_ROLES, ROLES, canAssignRole, roleHas, type Role } from "@stockpilot/shared";
import { useState, type FormEvent } from "react";
import { api, type Branch } from "../api";
import { useBusiness } from "../components/AppShell";
import { ErrorText, Field } from "../components/Field";
import { useApi } from "../useApi";

interface Member {
  id: string;
  user: { name: string; email: string };
  role: Role;
  status: "ACTIVE" | "DISABLED";
  branchIds: string[] | null;
}

const roleLabel = (r: string) => r.charAt(0) + r.slice(1).toLowerCase().replace("_", " ");

export function Team() {
  const { businessId, role } = useBusiness();
  const members = useApi<{ members: Member[] }>(`/businesses/${businessId}/members`);
  const branches = useApi<{ branches: Branch[] }>(`/businesses/${businessId}/branches`);
  const [inviteRole, setInviteRole] = useState<Role>("CASHIER");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assignable = ROLES.filter((r) => canAssignRole(role!, r));
  const branchName = (id: string) => branches.data?.branches.find((b) => b.id === id)?.name ?? "Unknown";

  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      const res = await api<{ token: string }>(`/businesses/${businessId}/invitations`, {
        method: "POST",
        body: { email: form.get("email"), role: inviteRole, branchIds: form.getAll("branchIds") },
      });
      setLink(`${window.location.origin}/invite?token=${res.token}`);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Team</h1>
      <ErrorText error={members.error} />
      <ul className="list">
        {members.data?.members
          .filter((m) => m.status === "ACTIVE")
          .map((m) => (
            <li key={m.id} className="card">
              <strong>{m.user.name}</strong>
              <span className="muted">{m.user.email}</span>
              <span className="tag">{roleLabel(m.role)}</span>
              <span className="muted">{m.branchIds ? m.branchIds.map(branchName).join(", ") : "All branches"}</span>
            </li>
          ))}
      </ul>
      {roleHas(role!, "member.invite") && (
        <form className="card" onSubmit={onInvite}>
          <h2>Invite someone</h2>
          <Field label="Email" name="email" type="email" required />
          <label className="field">
            <span>Role</span>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </label>
          {!ALL_BRANCH_ROLES.includes(inviteRole) && (
            <fieldset className="field">
              <legend>Branches</legend>
              {branches.data?.branches.map((b) => (
                <label key={b.id} className="check">
                  <input type="checkbox" name="branchIds" value={b.id} /> {b.name}
                </label>
              ))}
            </fieldset>
          )}
          <ErrorText error={error} />
          <button>Create invitation link</button>
          {link && (
            <p className="invite-link">
              Share this link with them (valid 7 days): <code>{link}</code>
            </p>
          )}
        </form>
      )}
    </>
  );
}
