"use client";

/**
 * AI Hub — Logs & Cost Dashboard (Phase A4).
 *
 * Reads `ai_logs` collection directly from Firestore (allowed by rules
 * for ai_admins). Shows:
 *   • Recent calls table (last 100, filterable by feature & success).
 *   • Per-feature stats: count, success rate, p50 / p95 latency.
 *   • Estimated daily cost (rough — based on token-count heuristic per call).
 *   • Per-vendor usage with monthly totals (used to enforce catalog parser
 *     budgets in Phase C).
 *
 * Self-contained; no AI service round-trip needed for read paths.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useDirectorAuth } from "@/lib/adminAuth";

type AiLogRow = {
  id: string;
  featureId?: string;
  userUid?: string;
  userEmail?: string;
  provider?: string;
  model?: string;
  success?: boolean;
  durationMs?: number;
  error?: string;
  createdAt?: Timestamp | null;
};

const FEATURE_ROUGH_COST_INR_PER_CALL: Record<string, number> = {
  // Rough cost-per-call estimates in INR (₹). Tweak as you measure.
  product_autofill: 1.2,
  catalog_parser: 12.0, // averages ~10 products/parse × autofill cost + vision
  tier_suggester: 0.5,
  image_search: 0.0, // CSE free tier
  voice_listing: 0.25, // gemini audio ~45s
  photo_listing: 0.20, // gemini vision
  visual_search: 0.15, // vision + embedding
  tia_chat: 0.30, // per conversational turn
  material_assist: 0.40, // chat turns on Flash; plan-reading on 3.1 Pro (pricier)
  bg_removal: 0.0, // local model
  image_verifier: 1.5,
  taxonomy_provisional_create: 0.0,
  default: 1.0,
};

function fmtDate(ts?: Timestamp | null) {
  if (!ts) return "—";
  try {
    return ts
      .toDate()
      .toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function p(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

export default function LogsPage() {
  const router = useRouter();
  const { user, isAdmin, loading } = useDirectorAuth();

  const [rows, setRows] = useState<AiLogRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(true);
  const [error, setError] = useState("");
  const [filterFeature, setFilterFeature] = useState<string>("ALL");
  const [filterSuccess, setFilterSuccess] = useState<"ALL" | "OK" | "FAIL">("ALL");

  const reload = useCallback(async () => {
    setLoadingRows(true);
    setError("");
    try {
      const snap = await getDocs(
        query(
          collection(db, "ai_logs"),
          orderBy("createdAt", "desc"),
          limit(500)
        )
      );
      const list: AiLogRow[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<AiLogRow, "id">) }));
      setRows(list);
    } catch (e: unknown) {
      setError((e as { message?: string })?.message ?? "Failed to load logs.");
      setRows([]);
    } finally {
      setLoadingRows(false);
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!isAdmin) {
      router.replace("/access-denied");
      return;
    }
    void reload();
  }, [user, isAdmin, loading, router, reload]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filterFeature !== "ALL" && r.featureId !== filterFeature) return false;
      if (filterSuccess === "OK" && r.success !== true) return false;
      if (filterSuccess === "FAIL" && r.success !== false) return false;
      return true;
    });
  }, [rows, filterFeature, filterSuccess]);

  // Per-feature stats
  const featureStats = useMemo(() => {
    type Stat = {
      featureId: string;
      total: number;
      ok: number;
      fail: number;
      p50: number;
      p95: number;
      costInr: number;
    };
    const byFeature: Record<string, Stat> = {};
    for (const r of rows) {
      const id = r.featureId || "unknown";
      if (!byFeature[id]) {
        byFeature[id] = {
          featureId: id,
          total: 0,
          ok: 0,
          fail: 0,
          p50: 0,
          p95: 0,
          costInr: 0,
        };
      }
      byFeature[id].total += 1;
      if (r.success === true) byFeature[id].ok += 1;
      if (r.success === false) byFeature[id].fail += 1;
      const cost =
        FEATURE_ROUGH_COST_INR_PER_CALL[id] ??
        FEATURE_ROUGH_COST_INR_PER_CALL.default;
      byFeature[id].costInr += cost;
    }
    // Compute latency percentiles per feature
    for (const id of Object.keys(byFeature)) {
      const durations = rows
        .filter((r) => (r.featureId || "unknown") === id && typeof r.durationMs === "number")
        .map((r) => r.durationMs as number);
      byFeature[id].p50 = p(durations, 0.5);
      byFeature[id].p95 = p(durations, 0.95);
    }
    return Object.values(byFeature).sort((a, b) => b.total - a.total);
  }, [rows]);

  // Per-vendor usage (last 30 days, used for catalog budget UI)
  const vendorUsage = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    type VStat = { uid: string; email: string; calls: number; failures: number };
    const map: Record<string, VStat> = {};
    for (const r of rows) {
      const created = r.createdAt?.toDate().getTime() ?? 0;
      if (created < cutoff) continue;
      const uid = r.userUid || "unknown";
      if (!map[uid]) {
        map[uid] = { uid, email: r.userEmail || "unknown", calls: 0, failures: 0 };
      }
      map[uid].calls += 1;
      if (r.success === false) map[uid].failures += 1;
    }
    return Object.values(map).sort((a, b) => b.calls - a.calls).slice(0, 25);
  }, [rows]);

  const allFeatureIds = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.featureId || "unknown"));
    return Array.from(set).sort();
  }, [rows]);

  const totalCallsLast24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return rows.filter((r) => (r.createdAt?.toDate().getTime() ?? 0) >= cutoff).length;
  }, [rows]);

  const totalCostLast24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return rows
      .filter((r) => (r.createdAt?.toDate().getTime() ?? 0) >= cutoff)
      .reduce((sum, r) => {
        const id = r.featureId || "unknown";
        return (
          sum +
          (FEATURE_ROUGH_COST_INR_PER_CALL[id] ??
            FEATURE_ROUGH_COST_INR_PER_CALL.default)
        );
      }, 0);
  }, [rows]);

  if (loading || !user || !isAdmin) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#64748b" }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <Link
            href="/"
            style={{ color: "#64748b", fontSize: 12, fontWeight: 700, textDecoration: "none" }}
          >
            ← Back to dashboard
          </Link>
          <h1 style={{ fontSize: 28, margin: "6px 0 4px 0", fontWeight: 900 }}>
            AI Logs & Cost Dashboard
          </h1>
          <p style={{ fontSize: 13, color: "#64748b" }}>
            Last 500 AI calls, per-feature stats, and per-vendor usage. Reads
            from <code>ai_logs</code> collection directly.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          style={{
            padding: "8px 18px",
            borderRadius: 10,
            background: "#1a1a1a",
            color: "white",
            border: "none",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div style={{
          marginBottom: 12, padding: 12, background: "#fee4e2",
          color: "#b42318", borderRadius: 10, fontWeight: 700, fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* Hero stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <Stat label="Calls (last 24h)" value={String(totalCallsLast24h)} />
        <Stat label="Estimated cost (24h)" value={`₹${totalCostLast24h.toFixed(2)}`} />
        <Stat label="Total in window (500 max)" value={String(rows.length)} />
        <Stat label="Active features" value={String(featureStats.length)} />
      </div>

      {/* Per-feature stats */}
      <Section title="Per-feature performance">
        <table style={tblStyle}>
          <thead style={theadStyle}>
            <tr>
              <th style={thStyle}>Feature</th>
              <th style={thStyle}>Calls</th>
              <th style={thStyle}>Success rate</th>
              <th style={thStyle}>Latency p50 / p95</th>
              <th style={thStyle}>Est. cost</th>
            </tr>
          </thead>
          <tbody style={{ fontSize: 13 }}>
            {featureStats.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 18, textAlign: "center", color: "#64748b" }}>
                  No data yet. AI calls will appear here as they happen.
                </td>
              </tr>
            ) : (
              featureStats.map((s) => (
                <tr key={s.featureId} style={{ borderTop: "1px solid #e2e8f0" }}>
                  <td style={tdStyle}>
                    <code style={{ fontSize: 12 }}>{s.featureId}</code>
                  </td>
                  <td style={tdStyle}>{s.total}</td>
                  <td style={tdStyle}>
                    <span style={{
                      fontWeight: 800,
                      color: s.total > 0 && s.ok / s.total >= 0.95 ? "#16a34a" : "#a16207",
                    }}>
                      {s.total > 0 ? pct(s.ok / s.total) : "—"}
                    </span>
                    {s.fail > 0 && (
                      <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 6 }}>
                        ({s.fail} failed)
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {s.p50}ms / {s.p95}ms
                  </td>
                  <td style={tdStyle}>₹{s.costInr.toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Section>

      {/* Per-vendor usage */}
      <Section title="Top vendors by usage (last 30 days)">
        <table style={tblStyle}>
          <thead style={theadStyle}>
            <tr>
              <th style={thStyle}>Vendor</th>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Calls (30d)</th>
              <th style={thStyle}>Failures</th>
            </tr>
          </thead>
          <tbody style={{ fontSize: 13 }}>
            {vendorUsage.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: 18, textAlign: "center", color: "#64748b" }}>
                  No vendor usage data in the recent window.
                </td>
              </tr>
            ) : (
              vendorUsage.map((v) => (
                <tr key={v.uid} style={{ borderTop: "1px solid #e2e8f0" }}>
                  <td style={tdStyle}><code style={{ fontSize: 11 }}>{v.uid.slice(0, 12)}…</code></td>
                  <td style={tdStyle}>{v.email}</td>
                  <td style={tdStyle}><b>{v.calls}</b></td>
                  <td style={tdStyle}>
                    {v.failures > 0 ? (
                      <span style={{ color: "#b42318" }}>{v.failures}</span>
                    ) : (
                      <span style={{ color: "#16a34a" }}>0</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Section>

      {/* Recent calls log */}
      <Section title="Recent calls">
        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <select
            value={filterFeature}
            onChange={(e) => setFilterFeature(e.target.value)}
            style={selectStyle}
          >
            <option value="ALL">All features</option>
            {allFeatureIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <select
            value={filterSuccess}
            onChange={(e) => setFilterSuccess(e.target.value as "ALL" | "OK" | "FAIL")}
            style={selectStyle}
          >
            <option value="ALL">All</option>
            <option value="OK">Success only</option>
            <option value="FAIL">Failures only</option>
          </select>
          <span style={{ alignSelf: "center", color: "#64748b", fontSize: 12 }}>
            Showing {filtered.length} of {rows.length}
          </span>
        </div>

        <table style={tblStyle}>
          <thead style={theadStyle}>
            <tr>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Feature</th>
              <th style={thStyle}>User</th>
              <th style={thStyle}>Provider / Model</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Latency</th>
            </tr>
          </thead>
          <tbody style={{ fontSize: 12 }}>
            {loadingRows ? (
              <tr>
                <td colSpan={6} style={{ padding: 18, textAlign: "center", color: "#64748b" }}>
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 18, textAlign: "center", color: "#64748b" }}>
                  No calls match this filter.
                </td>
              </tr>
            ) : (
              filtered.slice(0, 100).map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                  <td style={tdStyle}>{fmtDate(r.createdAt)}</td>
                  <td style={tdStyle}><code>{r.featureId || "—"}</code></td>
                  <td style={tdStyle}>{r.userEmail || (r.userUid?.slice(0, 8) ?? "—")}</td>
                  <td style={tdStyle}>
                    {r.provider} / <code style={{ fontSize: 11 }}>{r.model}</code>
                  </td>
                  <td style={tdStyle}>
                    {r.success ? (
                      <span style={{ color: "#16a34a", fontWeight: 800 }}>OK</span>
                    ) : (
                      <span style={{ color: "#b42318", fontWeight: 800 }}>FAIL</span>
                    )}
                  </td>
                  <td style={tdStyle}>{typeof r.durationMs === "number" ? `${r.durationMs}ms` : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, fontWeight: 900, marginBottom: 10 }}>{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: 14,
      background: "white",
      border: "1px solid #e2e8f0",
      borderRadius: 12,
    }}>
      <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 800 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 900, color: "#1a1a1a", marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

const tblStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  overflow: "hidden",
};
const theadStyle: React.CSSProperties = {
  background: "#f8fafc",
  textAlign: "left",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1.2,
  color: "#64748b",
  fontWeight: 800,
};
const thStyle: React.CSSProperties = { padding: "10px 12px" };
const tdStyle: React.CSSProperties = { padding: "10px 12px", verticalAlign: "top" };
const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "white",
  fontSize: 13,
  fontWeight: 700,
};
