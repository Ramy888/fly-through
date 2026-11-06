import { useState } from "react";
import type { Decision, Plan } from "../shared/types.ts";
import { dur, hhmm } from "./useSim.ts";

const aed = (n: number) => `AED ${n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`}`;

async function approve(planId: Plan["id"]): Promise<string | null> {
  const r = await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId }) });
  return r.ok ? null : ((await r.json()) as { error: string }).error;
}

export function PlansCard({ decision }: { decision: Decision }) {
  const [pending, setPending] = useState<Plan["id"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scored = !decision.error;
  const best = decision.plans.reduce((a, b) => ((b.probability ?? 0) > (a.probability ?? 0) ? b : a));
  const approvedId = decision.approved?.planId;

  return (
    <div className="glass plans">
      <div className="panel-head">
        <span>Recovery plans · {hhmm(decision.at)}</span>
        <small className="muted">
          {decision.status === "scoring" ? `scoring with ${decision.model}…` : !scored ? "unscored: decision model unavailable" : `${decision.model} · confidence ${Math.round((decision.confidence ?? 0) * 100)}%`}
        </small>
      </div>

      {decision.plans.map((p) => {
        const pct = Math.round((p.probability ?? 0) * 100);
        const chosen = approvedId ? approvedId === p.id : scored && decision.status === "ready" && p.id === best.id;
        return (
          <button key={p.id} className={`plan ${chosen ? "chosen" : ""} ${approvedId && !chosen ? "dim" : ""}`} onClick={() => !approvedId && setPending(p.id)} disabled={!!approvedId || decision.status !== "ready"}>
            <span className="plan-id">{p.id}</span>
            <span className="plan-body">
              <span className="plan-title">{p.title}</span>
              <span className="plan-metrics">
                {p.metrics.guestsProtected.toLocaleString()} guests protected · crews legal {p.metrics.crewsKeptLegal}/{p.metrics.crewsTotal} · delay {dur(p.metrics.avgDelayMin)} · {aed(p.metrics.costAed)}
              </span>
              <span className="bar">
                <span style={{ width: decision.status === "ready" && scored ? `${pct}%` : "0%" }} />
              </span>
            </span>
            <span className="plan-pct">{decision.status !== "ready" ? "…" : scored ? `${pct}%` : "–"}</span>
          </button>
        );
      })}

      {decision.approved ? (
        <div className="approved">
          ✓ Plan {decision.approved.planId} approved by the human approver at {hhmm(decision.approved.at)}
        </div>
      ) : pending ? (
        <div className="confirm">
          <p>{decision.plans.find((p) => p.id === pending)!.summary}</p>
          <div className="row">
            <button
              className="approve-btn"
              onClick={async () => {
                setError(await approve(pending));
                setPending(null);
              }}
            >
              Approve plan {pending}
            </button>
            <button className="ghost" onClick={() => setPending(null)}>
              Back
            </button>
          </div>
        </div>
      ) : scored ? (
        <button className="approve-btn" disabled={decision.status !== "ready"} onClick={() => setPending(best.id)}>
          🔒 Review &amp; approve plan {best.id} <small>human only</small>
        </button>
      ) : (
        <div className="muted small">Pick a plan above to approve it on its computed impacts.</div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
