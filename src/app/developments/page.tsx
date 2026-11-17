"use client";

/**
 * WS4 — AI DEVELOPMENTS (owner, 17 Nov 2026).
 *
 * "Admin will have an AI developments tab — cards like autofill,
 * material estimator… and the Q&A for that particular AI thing."
 *
 * Three views fed by one endpoint (/v1/admin/ai-developments):
 *   1. Cards — one per AI feature: calls + errors (30d), model, last used,
 *      how many questions its brain asked and how many got answered.
 *   2. Q&A log — what each brain asked, what the human answered.
 *   3. Buckets — "couldn't answer" (asked/skipped, assumption stands)
 *      and "they keep asking" (same question 3+ times → fix the brain).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDirectorAuth } from "@/lib/adminAuth";
import {
  getAiDevelopments,
  type AiDevCard,
  type AiQnaRow,
  type AiRepeatRow,
} from "@/lib/aiAdmin";

const FEATURE_NAMES: Record<string, string> = {
  product_autofill: "Product Auto-fill",
  catalog_parser: "Catalog Brain",
  material_estimator: "Material Estimator",
  tia_chat: "TIA Chat",
  voice_listing: "Voice Listing",
  photo_listing: "Photo Listing",
  visual_search: "Visual Search",
  smart_pricing: "Smart Pricing",
  nl_analytics: "NL Analytics",
  terravision: "TerraVision",
};

function featureName(id: string): string {
  return FEATURE_NAMES[id] || id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ago(ms: number): string {
  if (!ms) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const card: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
  padding: 16,
};
const chip: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  borderRadius: 999,
  padding: "2px 9px",
  display: "inline-block",
};

type Tab = "qna" | "stuck" | "repeating";

export default function AiDevelopmentsPage() {
  const router = useRouter();
  const { user, isAdmin, loading } = useDirectorAuth();

  const [cards, setCards] = useState<AiDevCard[]>([]);
  const [recent, setRecent] = useState<AiQnaRow[]>([]);
  const [stuck, setStuck] = useState<AiQnaRow[]>([]);
  const [repeating, setRepeating] = useState<AiRepeatRow[]>([]);
  const [tab, setTab] = useState<Tab>("qna");
  const [featureFilter, setFeatureFilter] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setBusy(true);
    setError("");
    const res = await getAiDevelopments();
    if (res.ok) {
      setCards(res.data.cards);
      setRecent(res.data.recent);
      setStuck(res.data.stuck);
      setRepeating(res.data.repeating);
    } else {
      setError(res.message);
    }
    setBusy(false);
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

  const qnaRows = useMemo(() => {
    const src = tab === "qna" ? recent : tab === "stuck" ? stuck : [];
    return featureFilter ? src.filter((r) => r.featureId === featureFilter) : src;
  }, [tab, recent, stuck, featureFilter]);

  const repeatRows = useMemo(
    () => (featureFilter ? repeating.filter((r) => r.featureId === featureFilter) : repeating),
    [repeating, featureFilter],
  );

  if (loading || !user || !isAdmin) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#64748b" }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>AI Developments</h1>
          <div style={{ fontSize: 13, color: "#64748b" }}>
            Every AI feature's pulse — and every question its brain asked a human.
          </div>
        </div>
        <Link href="/" style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>
          ← Dashboard
        </Link>
      </div>

      {error && (
        <div style={{ margin: "14px 0", padding: 10, background: "#fee2e2", color: "#b91c1c", borderRadius: 8, fontSize: 13, fontWeight: 700 }}>
          {error}
        </div>
      )}

      {/* 1 — feature cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12, margin: "18px 0" }}>
        {busy && cards.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: 13 }}>Loading features…</div>
        ) : (
          cards.map((c) => {
            const active = featureFilter === c.featureId;
            return (
              <button
                key={c.featureId}
                onClick={() => setFeatureFilter(active ? "" : c.featureId)}
                style={{
                  ...card,
                  textAlign: "left",
                  cursor: "pointer",
                  borderColor: active ? "#0f172a" : "#e2e8f0",
                  borderWidth: active ? 2 : 1,
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 4 }}>
                  {featureName(c.featureId)}
                </div>
                <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                  {c.calls30d} call(s) / 30d
                  {c.errors30d > 0 ? (
                    <span style={{ color: "#b91c1c", fontWeight: 800 }}> · {c.errors30d} error(s)</span>
                  ) : null}
                  <br />
                  {(c.questions ?? 0) > 0 ? (
                    <>
                      🤖 asked {c.questions} · answered {c.answered ?? 0}
                      <br />
                    </>
                  ) : null}
                  <span style={{ color: "#94a3b8" }}>
                    {c.model || "—"} · {ago(c.lastUsedAt)}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* 2 — tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {(
          [
            ["qna", `Q&A log (${recent.length})`],
            ["stuck", `Couldn't answer (${stuck.length})`],
            ["repeating", `They keep asking (${repeating.length})`],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              borderRadius: 999,
              padding: "7px 16px",
              fontSize: 13,
              fontWeight: 800,
              cursor: "pointer",
              border: "1px solid",
              borderColor: tab === t ? "#0f172a" : "#e2e8f0",
              background: tab === t ? "#0f172a" : "#fff",
              color: tab === t ? "#fff" : "#334155",
            }}
          >
            {label}
          </button>
        ))}
        {featureFilter && (
          <span style={{ ...chip, background: "#e0e7ff", color: "#3730a3", alignSelf: "center" }}>
            filtered: {featureName(featureFilter)} ✕
          </span>
        )}
      </div>

      {/* 3 — the active bucket */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {tab !== "repeating" ? (
          qnaRows.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: "#64748b", textAlign: "center" }}>
              {busy ? "Loading…" : "Nothing here yet."}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead style={{ background: "#f8fafc" }}>
                <tr style={{ textAlign: "left", color: "#64748b" }}>
                  <th style={{ padding: "10px 12px" }}>Feature</th>
                  <th style={{ padding: "10px 12px" }}>The brain asked</th>
                  <th style={{ padding: "10px 12px" }}>The human said</th>
                  <th style={{ padding: "10px 12px" }}>When</th>
                </tr>
              </thead>
              <tbody>
                {qnaRows.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "#64748b", fontWeight: 700 }}>
                      {featureName(r.featureId)}
                    </td>
                    <td style={{ padding: "8px 12px", maxWidth: 420 }}>{r.question}</td>
                    <td style={{ padding: "8px 12px" }}>
                      {r.status === "answered" ? (
                        <span style={{ ...chip, background: "#dcfce7", color: "#166534" }}>{r.answer || "✓"}</span>
                      ) : r.status === "skipped" ? (
                        <span style={{ ...chip, background: "#fef3c7", color: "#92400e" }}
                          title={r.assumption ? `assumption used: ${r.assumption}` : undefined}>
                          skipped{r.assumption ? ` → ${r.assumption}` : ""}
                        </span>
                      ) : (
                        <span style={{ ...chip, background: "#f1f5f9", color: "#64748b" }}>no answer yet</span>
                      )}
                    </td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "#94a3b8" }}>{ago(r.askedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : repeatRows.length === 0 ? (
          <div style={{ padding: 24, fontSize: 13, color: "#64748b", textAlign: "center" }}>
            {busy ? "Loading…" : "No question has repeated 3+ times. 🎉"}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead style={{ background: "#f8fafc" }}>
              <tr style={{ textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: "10px 12px" }}>Feature</th>
                <th style={{ padding: "10px 12px" }}>Question (numbers collapsed)</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Times asked</th>
                <th style={{ padding: "10px 12px" }}>Last</th>
              </tr>
            </thead>
            <tbody>
              {repeatRows.map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "#64748b", fontWeight: 700 }}>
                    {featureName(r.featureId)}
                  </td>
                  <td style={{ padding: "8px 12px", maxWidth: 480 }}>{r.question}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 900, color: "#b45309" }}>
                    ×{r.count}
                  </td>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "#94a3b8" }}>{ago(r.lastAskedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 10 }}>
        A question repeating 3+ times means the brain should learn it — teach it via the prompt or vendor memory instead of asking again.
      </div>
    </div>
  );
}
