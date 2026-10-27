import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** Loads a GET endpoint and exposes a reload function. */
export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, reload };
}
