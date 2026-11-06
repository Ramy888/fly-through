import type { Snapshot } from "../shared/types.ts";
import { dur, hhmm, simControl } from "./useSim.ts";

/** End-of-run summary: what the ops room decided, how fast, and how much of it was backed by checked facts. */
export function Debrief({ snap, fogStart, fogLifts }: { snap: Snapshot; fogStart: number; fogLifts: number }) {
  const d = snap.decision;
  const schedule = snap.recovery?.schedule ?? [];
  const done = schedule.length ? Math.max(...schedule.map((r) => r.land)) : fogLifts;
  if (!d?.approved || snap.now < done) return null; // shown once the last aircraft is home
  const plan = d.plans.find((p) => p.id === d.approved!.planId)!;
  const all = (snap.decisions ?? [d]).filter((x) => x.approved);
  const agreed = all.filter((x) => x.verdict?.pick === x.approved!.planId).length;
  const first = all[0];
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
          <b>{dur(first.approved!.at - fogStart)}</b>
          <small>fog to first approved plan</small>
        </div>
        <div>
          <b>{all.map((x) => `${hhmm(x.at)} ${x.approved!.planId}`).join(" · ")}</b>
          <small>
            {all.length} decision{all.length > 1 ? "s" : ""} · AI agreed {agreed}/{all.length}
            {debated ? ` · ${debated} debate positions` : ""}
          </small>
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
          <small>aircraft home{plan.cancelled?.length ? ` · ${plan.cancelled.length} cancelled` : ""} · first at {hhmm(snap.fogLifts ?? fogLifts)}</small>
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
