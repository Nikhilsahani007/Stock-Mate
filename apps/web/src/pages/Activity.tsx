import { useBusiness } from "../components/AppShell";
import { ErrorText } from "../components/Field";
import { useApi } from "../useApi";

interface Entry {
  id: string;
  action: string;
  entityType: string | null;
  createdAt: string;
  actor: { name: string } | null;
}

export function Activity() {
  const { businessId } = useBusiness();
  const { data, error } = useApi<{ entries: Entry[] }>(`/businesses/${businessId}/audit-logs`);
  return (
    <>
      <h1>Activity</h1>
      <ErrorText error={error} />
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          {data?.entries.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString("en-IN")}</td>
              <td>{e.actor?.name ?? "System"}</td>
              <td>{e.action.replace(".", " ").replace("_", " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
