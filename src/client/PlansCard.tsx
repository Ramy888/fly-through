import { useState } from "react";
import type { Criterion, Decision, Plan, SeatId, WarMessage } from "../shared/types.ts";
import { SEAT_NAME } from "./ChatPanel.tsx";
import { dur, hhmm } from "./useSim.ts";

const aed = (n: number) => `AED ${n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`}`;
const pct = (p?: number) => Math.round((p ?? 0) * 100);

async function approve(planId: Plan["id"]): Promise<string | null> {
  const r = await fetch("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId }) });
  return r.ok ? null : ((await r.json()) as { error: string }).error;
}

/** Each seat's latest debate position at this decision point. */
function votesFor(decision: Decision, messages: WarMessage[]): Record<Plan["id"], SeatId[]> {
  const latest = new Map<SeatId, Plan["id"]>();
  for (const m of messages) if (m.stance && Math.abs(m.t - decision.at) <= 2) latest.set(m.from, m.stance.plan);
  const out: Record<Plan["id"], SeatId[]> = { A: [], B: [], C: [] };
  for (const [seat, plan] of latest) out[plan].push(seat);
  return out;
}

const LABEL: Record<Criterion, string> = { security: "Security", passengers: "Passengers", punctuality: "Punctuality", environment: "Environment", cost: "Cost", schedule: "Schedule" };

/** Criteria × plans: the decision model's score per criterion, the weight from the OCC expert study, the row's leader. */
function CriteriaTable({ decision }: { decision: Decision }) {
  const v = decision.verdict!;
  const ids = decision.plans.map((p) => p.id);
  return (
    <table className="criteria">
      <thead>
        <tr>
          <th>Criterion · weight</th>
          {ids.map((id) => (
            <th key={id}>{id}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(Object.keys(LABEL) as Criterion[]).map((c) => {
          const row = v.scores[c] ?? {};
          const lead = ids.reduce((a, b) => ((row[b] ?? 0) > (row[a] ?? 0) ? b : a));
          return (
            <tr key={c} title={decision.plans.map((p) => `${p.id}: ${p.criteria?.[c] ?? ""}`).join("\n")}>
              <td>
                {LABEL[c]} <small>{pct(v.weights[c])}%</small>
                {v.disagree?.includes(c) && (
                  <em className="flag" title="The decision model's favourite here is not the plan the computed numbers favour. The score blends both.">
                    ⚑ AI ≠ numbers
                  </em>
                )}
              </td>
              {ids.map((id) => (
                <td key={id} className={id === lead ? "lead" : ""}>
                  {pct(row[id])}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PlansCard({ decision, messages, index = 1, count = 1 }: { decision: Decision; messages: WarMessage[]; index?: number; count?: number }) {
  const [pending, setPending] = useState<Plan["id"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = decision.status === "ready";
  const scored = ready && !decision.error;
  const v = decision.verdict;
  const best = v?.pick ?? decision.plans.reduce((a, b) => ((b.probability ?? 0) > (a.probability ?? 0) ? b : a)).id;
  const approvedId = decision.approved?.planId;
  const votes = votesFor(decision, messages);

  const status =
    decision.status === "debating"
      ? `seats debating · round ${decision.round ?? 1} of 2`
      : decision.status === "scoring"
        ? `AI check with ${decision.model}…`
        : decision.error
          ? "unscored: decision model unavailable"
          : v
            ? `AI check · ${decision.model}`
            : `${decision.model} · confidence ${pct(decision.confidence)}%`;

  return (
    <div className="glass plans">
      <div className="panel-head">
        <span>
          Recovery plans · {hhmm(decision.at)}
          {count > 1 ? ` · decision ${index} of ${count}` : ""}
        </span>
        <small className={decision.status === "ready" ? "muted" : "live-status"}>{status}</small>
      </div>

      {decision.plans.map((p) => {
        const chosen = approvedId ? approvedId === p.id : scored && p.id === best;
        return (
          <button key={p.id} className={`plan ${chosen ? "chosen" : ""} ${approvedId && !chosen ? "dim" : ""}`} onClick={() => !approvedId && setPending(p.id)} disabled={!!approvedId || !ready}>
            <span className="plan-id">{p.id}</span>
            <span className="plan-body">
              <span className="plan-title">
                {p.title}
                {p.gate && (p.gate.passes ? <em className="tag safe">✓ safety gate</em> : <em className="tag fail">fails safety gate</em>)}
                {votes[p.id].length > 0 && (
                  <span className="votes" title={`${votes[p.id].map((s) => SEAT_NAME[s]).join(", ")} back plan ${p.id}`}>
                    {votes[p.id].map((s) => (
                      <img key={s} src={`/avatars/${s}.png`} alt={SEAT_NAME[s]} />
                    ))}
                    <small>{votes[p.id].length}</small>
                  </span>
                )}
              </span>
              <span className="plan-metrics">
                {p.metrics.guestsProtected.toLocaleString()} guests protected · crews legal {p.metrics.crewsKeptLegal}/{p.metrics.crewsTotal} · delay {dur(p.metrics.avgDelayMin)} · {aed(p.metrics.costAed)}
              </span>
              {p.gate?.warning && <span className="gate-warning">⚠ {p.gate.warning}</span>}
              {v || decision.status !== "ready" ? (
                <span className="mini-bar">
                  <span className="mini-label">Weighted score</span>
                  <span className="bar teal">
                    <span style={{ width: scored && v ? `${pct(v.totals[p.id])}%` : "0%" }} />
                  </span>
                  <span className="mini-pct">{scored && v ? pct(v.totals[p.id]) : "…"}</span>
                </span>
              ) : (
                <span className="bar">
                  <span style={{ width: scored ? `${pct(p.probability)}%` : "0%" }} />
                </span>
              )}
            </span>
            {!v && <span className="plan-pct">{!ready ? "…" : scored ? `${pct(p.probability)}%` : "–"}</span>}
          </button>
        );
      })}

      {scored && v?.scores && <CriteriaTable decision={decision} />}
      {scored && v?.scores && <small className="muted small-note">Safety is a gate, not a score. Weights: airline OCC expert study (IHSSR, 2024). Each score: half computed facts, half {decision.model}.</small>}
      {scored && v && (
        <div className="verdict">
          <b>AI recommends plan {v.pick}.</b> {v.reason}
        </div>
      )}

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
        <button className="approve-btn" onClick={() => setPending(best)}>
          🔒 Review &amp; approve plan {best} <small>human only</small>
        </button>
      ) : ready ? (
        <div className="muted small">Pick a plan above to approve it on its computed impacts.</div>
      ) : (
        <div className="muted small">The sim is paused. The seats argue, the AI checks safety then cost, then you decide.</div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
