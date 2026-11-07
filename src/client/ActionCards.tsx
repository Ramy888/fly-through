import { useState } from "react";
import type { SeatAction, Snapshot } from "../shared/types.ts";
import { SEAT_NAME } from "./ChatPanel.tsx";

const aed = (n: number) => `AED ${n.toLocaleString("en-US")}`;
const KIND: Record<SeatAction["kind"], string> = { hotel_block: "Hotel rooms", meal_vouchers: "Meal vouchers", crew_rest: "Crew rest", position_crew: "Position a fresh crew" };
const UNIT: Record<SeatAction["kind"], string> = { hotel_block: "guests", meal_vouchers: "guests", crew_rest: "crews", position_crew: "trip" };

async function decide(id: number, approve: boolean): Promise<string | null> {
  await fetch("/api/session").catch(() => {}); // refresh the approver cookie after a server restart
  const r = await fetch(`/api/actions/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve }) });
  return r.ok ? null : ((await r.json()) as { error: string }).error;
}

/** Over-budget actions a seat asked for: only the human can run them. */
export function ActionCards({ snap }: { snap: Snapshot }) {
  const pending = snap.care?.pending ?? [];
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!pending.length) return null;
  const recorded = snap.mode !== "live";
  return (
    <section className="action-cards" aria-label="Actions waiting for your approval">
      <h3>Over budget · needs you</h3>
      {pending.map((a) => {
        const left = snap.care!.budgets[a.requestedBy];
        return (
          <div key={a.id} className="action-card">
            <div className="action-card-top">
              <b>{KIND[a.kind]}</b>
              <span className="sand">{aed(a.costAed)}</span>
            </div>
            <span className="muted">
              {SEAT_NAME[a.requestedBy]} · {a.quantity.toLocaleString("en-US")} {UNIT[a.kind]} at {a.airport}
              {left ? ` · budget left ${aed(left.limit - left.spent)}` : ""}
            </span>
            {recorded ? (
              <span className="muted small">Recorded run: the human decided this card at the time; the replay shows what happened.</span>
            ) : (
              <div className="action-card-buttons">
                <button className="approve-btn" disabled={busy !== null} onClick={async () => { setBusy(a.id); setError(await decide(a.id, true)); setBusy(null); }}>
                  {busy === a.id ? "Running in sandbox…" : "Approve"}
                </button>
                <button disabled={busy !== null} onClick={async () => { setBusy(a.id); setError(await decide(a.id, false)); setBusy(null); }}>Decline</button>
              </div>
            )}
          </div>
        );
      })}
      {error && <span className="error small">{error}</span>}
    </section>
  );
}

/** The outcome of a seat action, shown inside its chat bubble. */
export function ActionChip({ a }: { a: SeatAction }) {
  const label = { done: "Done · delegated", pending: "Waiting for you", approved: "Approved by you", declined: "Declined by you", failed: "Failed" }[a.status];
  return (
    <span className={`action-chip ${a.status}`}>
      <b>{label}</b> · {KIND[a.kind]} · {aed(a.costAed)}
      {a.sandbox && (
        <span className="action-sandbox" title={`${a.sandbox.image} · runtime ${a.sandbox.runtime} · ${a.sandbox.limits}`}>
          sandbox {a.sandbox.ms} ms · #{a.sandbox.checksum.slice(0, 8)}
        </span>
      )}
    </span>
  );
}
