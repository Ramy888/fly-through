import type { CrewStatus, Snapshot } from "../shared/types.ts";
import { dur, hhmm, simControl } from "./useSim.ts";

const SPEEDS = [30, 60, 120];

export function TopPill({ snap }: { snap: Snapshot }) {
  return (
    <div className="glass top-pill">
      <span className="pill-title">FOG AT HUB</span>
      <span className="muted pill-time">Replay · {hhmm(snap.now)} · {snap.speed}×</span>
      <span className={snap.mode === "live" ? "badge teal" : "badge sand-badge"}>{snap.mode === "live" ? "Live AI agents" : "Recorded run"}</span>
      <span className={snap.hubClosed ? "badge red" : "badge teal"}>
        Hub {snap.hubClosed ? "closed" : "open"} · vis {snap.visibilityM >= 1000 ? `${(snap.visibilityM / 1000).toFixed(1)} km` : `${snap.visibilityM} m`}
      </span>
      <span className="divider" />
      <span className="stat">
        <small>Guests stuck</small>
        <b className="sand">{snap.guestsStuck.toLocaleString()}</b>
      </span>
    </div>
  );
}

export function Controls({ snap }: { snap: Snapshot }) {
  return (
    <div className="glass controls">
      <button onClick={() => simControl(snap.running ? "pause" : "start")}>{snap.running ? "Pause" : "Play"}</button>
      {SPEEDS.map((s) => (
        <button key={s} className={snap.speed === s ? "on" : ""} onClick={() => simControl("start", { speed: s })}>
          {s}×
        </button>
      ))}
      <button onClick={() => simControl("reset")}>Reset</button>
      <button
        title="Live: agents call Vultr inference now. Recorded: replays the last live run with no model calls."
        onClick={async () => {
          const r = await simControl("mode", { mode: snap.mode === "live" ? "recorded" : "live" });
          if (!r.ok) console.warn(((await r.json()) as { error: string }).error); // e.g. no recorded run yet
        }}
      >
        {snap.mode === "live" ? "Use recorded run" : "Use live AI"}
      </button>
    </div>
  );
}

function Ring({ c }: { c: CrewStatus }) {
  const frac = Math.max(0, Math.min(1, c.dutyLeftMin / (6 * 60)));
  const r = 22;
  const len = 2 * Math.PI * r;
  return (
    <div className={`ring ${c.state}`} title={`Duty ends ${hhmm(c.dutyEnds)} at ${c.at}`}>
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r={r} className="ring-bg" />
        <circle cx="28" cy="28" r={r} className="ring-fg" strokeDasharray={`${len * frac} ${len}`} transform="rotate(-90 28 28)" />
      </svg>
      <span className="ring-time">{c.state === "illegal" ? "OUT" : c.state === "relieved" ? "✓" : dur(c.dutyLeftMin)}</span>
      <span className="ring-id">
        {c.id} · {c.at}
      </span>
    </div>
  );
}

export function DutyClocks({ snap }: { snap: Snapshot }) {
  const worst = snap.crews.filter((c) => !c.standby).sort((a, b) => a.dutyLeftMin - b.dutyLeftMin).slice(0, 5);
  return (
    <div className="glass duty">
      <div className="panel-head">
        <span>Crew duty clocks</span>
        <small className="muted">simplified illustrative rules</small>
      </div>
      <div className="rings">{worst.map((c) => <Ring key={c.id} c={c} />)}</div>
    </div>
  );
}

const MARKER_KINDS = new Set(["fog", "crew_call", "fog_lifting", "reopen"]);

export function Timeline({ snap, start, end, events }: { snap: Snapshot; start: number; end: number; events: Snapshot["events"] }) {
  const pct = (m: number) => `${((m - start) / (end - start)) * 100}%`;
  // All scenario markers are shown up front; the ones still ahead are dimmed.
  const firstDiversion = events.find((e) => e.kind === "diversion");
  const markers = [...events.filter((e) => MARKER_KINDS.has(e.kind)), ...(firstDiversion ? [{ ...firstDiversion, text: "Diversions begin" }] : [])];
  return (
    <div
      className="timeline"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        simControl("seek", { minute: start + ((e.clientX - r.left) / r.width) * (end - start) });
      }}
    >
      <span className="tl-label left">{hhmm(start)}</span>
      <div className="tl-track">
        <div className="tl-fill" style={{ width: pct(snap.now) }} />
        {markers.map((m) => (
          <span key={m.kind + m.t} className={`tl-marker ${m.kind}${m.t > snap.now ? " ahead" : ""}`} style={{ left: pct(m.t) }} title={`${hhmm(m.t)} ${m.text}`} />
        ))}
        <span className="tl-now" style={{ left: pct(snap.now) }}>
          {hhmm(snap.now)}
        </span>
      </div>
      <span className="tl-label right">{hhmm(end)}</span>
    </div>
  );
}
