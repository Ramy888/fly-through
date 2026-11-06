import { SEATS, type SeatId, type Snapshot } from "../shared/types.ts";

const NAME = Object.fromEntries(SEATS.map((s) => [s.id, s.name])) as Record<SeatId, string>;

/** Bottom dock: one portrait per agent seat plus the human seat. The seat thinking now pulses; the last speaker glows. */
export function SeatDock({ snap }: { snap: Snapshot }) {
  const last = snap.messages.at(-1);
  return (
    <div className="glass dock">
      {SEATS.map((s) => {
        const state = snap.thinking.includes(s.id) ? "thinking" : last?.from === s.id ? "speaking" : "";
        return (
          <div key={s.id} className={`seat ${state}`}>
            <img src={`/avatars/${s.id}.png`} alt="" />
            <span>{s.name}</span>
          </div>
        );
      })}
      <div className="seat you">
        <div className="you-avatar" aria-hidden>
          <svg viewBox="0 0 24 24" width="34" height="34">
            <circle cx="12" cy="8" r="4" fill="currentColor" />
            <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" />
          </svg>
        </div>
        <span>YOU · approver</span>
      </div>
    </div>
  );
}

/** The latest war-room line, shown like a film subtitle above the dock. */
export function Subtitle({ snap }: { snap: Snapshot }) {
  const m = snap.messages.at(-1);
  if (!m || snap.now - m.t > 25) return null; // old call-outs fade out instead of lingering
  return (
    <div className="subtitle" key={m.id}>
      <b>
        {NAME[m.from]}
        {m.to ? ` → ${NAME[m.to]}` : ""}:
      </b>{" "}
      {m.text}
      {m.tools && <small className="evidence">checked: {m.tools.join(", ")}</small>}
    </div>
  );
}
