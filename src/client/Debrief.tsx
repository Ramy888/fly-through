import type { Snapshot } from "../shared/types.ts";
import { dur, hhmm, simControl } from "./useSim.ts";

/** End-of-run summary: what the ops room decided, how fast, and how much of it was backed by checked facts. */
export function Debrief({ snap, fogStart, fogLifts }: { snap: Snapshot; fogStart: number; fogLifts: number }) {
  const d = snap.decision;
  const schedule = snap.recovery?.schedule ?? [];
  const done = schedule.length ? Math.max(...schedule.map((r) => r.land)) : fogLifts;
  if (!d?.approved || snap.now < done) return null; // shown once the last aircraft is home
  const plan = d.plans.find((p) => p.id === d.approved!.planId)!;
  // whole-run totals from the server; the message list itself is only the latest window
  const stats = snap.stats ?? { messages: snap.messages.length, handoffs: snap.messages.filter((m) => m.to).length, toolBacked: snap.messages.filter((m) => m.tools?.length).length };
  const debated = snap.messages.filter((m) => m.stance).length;
  const relieved = snap.crews.filter((c) => c.state === "relieved").length;

  return (
    <div className="glass debrief">
      <div className="panel-head">
        <span>Debrief · last aircraft home {hhmm(done)}</span>
        <small className="muted">this run</small>
      </div>
      <div className="debrief-grid">
        <div>
          <b>{dur(d.approved.at - fogStart)}</b>
          <small>fog to approved plan</small>
        </div>
        <div>
          <b>Plan {plan.id}{d.verdict ? (d.verdict.pick === plan.id ? " · AI agreed" : ` · AI said ${d.verdict.pick}`) : ` · ${Math.round((plan.probability ?? 0) * 100)}%`}</b>
          <small>{plan.title.toLowerCase()}{d.verdict ? ` · ${debated} debate positions` : " (decision model)"}</small>
        </div>
        <div>
          <b>{plan.metrics.guestsProtected.toLocaleString()}</b>
          <small>guests protected</small>
        </div>
        <div>
          <b>
            {plan.metrics.crewsKeptLegal}/{plan.metrics.crewsTotal}
          </b>
          <small>crews legal to fly back{relieved ? ` · ${relieved} relieved by road` : ""}</small>
        </div>
        <div>
          <b>
            {snap.recovery?.landed ?? 0}/{schedule.length + (plan.cancelled?.length ?? 0)}
          </b>
          <small>aircraft home{plan.cancelled?.length ? ` · ${plan.cancelled.length} cancelled` : ""} · first at {hhmm(fogLifts)}</small>
        </div>
        <div>
          <b>{snap.guestsStuck.toLocaleString()}</b>
          <small>guests still stuck</small>
        </div>
        <div>
          <b>{stats.handoffs}</b>
          <small>handoffs between seats</small>
        </div>
        <div>
          <b>
            {stats.toolBacked}/{stats.messages}
          </b>
          <small>call-outs backed by tool checks</small>
        </div>
      </div>
      <p className="muted small">
        Approved by the human at {hhmm(d.approved.at)}. Synthetic scenario, simplified illustrative duty and cost rules.
      </p>
      <button className="ghost" onClick={() => simControl("reset")}>
        Replay from 05:30
      </button>
    </div>
  );
}
