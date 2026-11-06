import type { Snapshot } from "../shared/types.ts";
import { dur, hhmm, simControl } from "./useSim.ts";

/** End-of-run summary: what the ops room decided, how fast, and how much of it was backed by checked facts. */
export function Debrief({ snap, fogStart, fogLifts }: { snap: Snapshot; fogStart: number; fogLifts: number }) {
  const d = snap.decision;
  if (!d?.approved || snap.now < fogLifts) return null;
  const plan = d.plans.find((p) => p.id === d.approved!.planId)!;
  const handoffs = snap.messages.filter((m) => m.to).length;
  const backed = snap.messages.filter((m) => m.tools?.length).length;
  const relieved = snap.crews.filter((c) => c.state === "relieved").length;

  return (
    <div className="glass debrief">
      <div className="panel-head">
        <span>Debrief · fog lifted {hhmm(fogLifts)}</span>
        <small className="muted">this run</small>
      </div>
      <div className="debrief-grid">
        <div>
          <b>{dur(d.approved.at - fogStart)}</b>
          <small>fog to approved plan</small>
        </div>
        <div>
          <b>
            Plan {plan.id} · {Math.round((plan.probability ?? 0) * 100)}%
          </b>
          <small>{plan.title.toLowerCase()} (decision model)</small>
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
          <b>{handoffs}</b>
          <small>handoffs between seats</small>
        </div>
        <div>
          <b>
            {backed}/{snap.messages.length}
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
