import { todayIn } from "@stockpilot/shared";
import type { ReactNode } from "react";
import { rupees } from "./inventory";

export interface Range {
  from: string;
  to: string;
}

const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Common ranges, in the shop's own calendar (India time). */
export function presets(today = todayIn("Asia/Kolkata")) {
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = shift(monthStart, -1);
  return [
    { key: "today", label: "Today", from: today, to: today },
    { key: "yesterday", label: "Yesterday", from: shift(today, -1), to: shift(today, -1) },
    { key: "7d", label: "Last 7 days", from: shift(today, -6), to: today },
    { key: "month", label: "This month", from: monthStart, to: today },
    { key: "lastMonth", label: "Last month", from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
  ];
}

export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const list = presets();
  const current = list.find((p) => p.from === value.from && p.to === value.to)?.key ?? "custom";
  return (
    <>
      <label className="field">
        <span>Period</span>
        <select
          value={current}
          onChange={(e) => {
            const p = list.find((x) => x.key === e.target.value);
            if (p) onChange({ from: p.from, to: p.to });
          }}
        >
          {list.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
          <option value="custom" disabled>
            Custom
          </option>
        </select>
      </label>
      <label className="field">
        <span>From</span>
        <input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
      </label>
      <label className="field">
        <span>To</span>
        <input type="date" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
      </label>
    </>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "estimated" | "unknown" }) {
  return (
    <div className={`card stat${tone ? ` stat-${tone}` : ""}`}>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

export interface Column<T> {
  label: string;
  /** What the table shows. */
  cell: (row: T) => ReactNode;
  /** What the CSV gets; defaults to the cell when that is plain text or a number. */
  csv?: (row: T) => string | number | null | undefined;
  num?: boolean;
  /** Amount in paise: shown as rupees, exported as a plain rupee number. */
  money?: (row: T) => number | null | undefined;
}

export interface ColumnHelpers<T> {
  /** A column of paise amounts. */
  money: (label: string, get: (row: T) => number | null | undefined) => Column<T>;
  num: (label: string, get: (row: T) => number | null | undefined) => Column<T>;
}

const helpers: ColumnHelpers<never> = {
  money: (label, get) => ({ label, cell: (r) => rupees(get(r)), money: get, num: true }),
  num: (label, get) => ({ label, cell: (r) => get(r) ?? "—", csv: get, num: true }),
};

/** A table that can also be downloaded as CSV for Excel or an accountant. Columns are built with helpers typed to the rows. */
export function ReportTable<T>({
  title,
  rows,
  columns: build,
  empty = "Nothing for this period.",
  file,
}: {
  title?: string;
  rows: T[];
  columns: (h: ColumnHelpers<T>) => Column<T>[];
  empty?: string;
  file?: string;
}) {
  const columns = build(helpers as unknown as ColumnHelpers<T>);
  return (
    <section className="report-section">
      <div className="section-head">
        {title && <h2>{title}</h2>}
        {rows.length > 0 && file && (
          <button type="button" className="secondary small no-print" onClick={() => downloadCsv(file, rows, columns)}>
            Download CSV
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label} className={c.num ? "num" : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.label} className={c.num ? "num" : undefined}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted">
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function csvValue<T>(c: Column<T>, r: T): string {
  let v: unknown;
  if (c.money) {
    const p = c.money(r);
    v = p === null || p === undefined ? "" : (p / 100).toFixed(2);
  } else if (c.csv) {
    v = c.csv(r);
  } else {
    const cell = c.cell(r);
    v = typeof cell === "string" || typeof cell === "number" ? cell : "";
  }
  return escapeCsv(String(v ?? ""));
}

const escapeCsv = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

export function downloadCsv<T>(file: string, rows: T[], columns: Column<T>[]) {
  const lines = [columns.map((c) => escapeCsv(c.label)).join(","), ...rows.map((r) => columns.map((c) => csvValue(c, r)).join(","))];
  // The BOM makes Excel read the file as UTF-8 (₹, Hindi names).
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${file}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");
export const rate = (bps: number) => `${bps / 100}%`;
