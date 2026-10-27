export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      "X-StockPilot-Client": "web",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    const detail = Array.isArray(err.details) && err.details[0]?.message ? `: ${err.details[0].message}` : "";
    throw new ApiError(res.status, err.code ?? "UNKNOWN", `${err.message ?? "Request failed"}${detail}`);
  }
  return data as T;
}

export interface AccessState {
  access: "FULL" | "READ_ONLY" | "NONE";
  phase: "TRIAL" | "GRACE" | "ACTIVE" | "EXPIRED" | "ARCHIVED";
  trialEndsAt: string;
  daysLeft: number;
}

export interface Me {
  user: { id: string; name: string; email: string };
  businesses: { id: string; name: string; role: string; access: AccessState }[];
}

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  gstEnabled: boolean;
  gstin: string | null;
}
