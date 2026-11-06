import { useLayoutEffect, useRef, useState } from "react";
import type { Snapshot, WarMessage } from "../shared/types.ts";
import { SEAT_NAME as NAME } from "./ChatPanel.tsx";

/** The latest war-room line, shown like a film subtitle above the timeline. */
export function Subtitle({ snap }: { snap: Snapshot }) {
  const m = snap.messages.at(-1);
  if (!m || snap.now - m.t > 25) return null; // old call-outs fade out instead of lingering
  return <Line key={m.id} m={m} />; // keyed so each new line starts collapsed
}

/** Clamped to 4 lines; "Show more" opens it into a scrollable box, "Show less" clamps it again. */
function Line({ m }: { m: WarMessage }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [open, m.text]);
  return (
    <div className="subtitle">
      <div ref={ref} className={`sub-text ${open ? "open" : ""}`}>
        <b>
          {NAME[m.from]}
          {m.to ? ` → ${NAME[m.to]}` : ""}:
        </b>{" "}
        {m.text}
      </div>
      {m.tools && <small className="evidence">checked: {m.tools.join(", ")}</small>}
      {long && (
        <button className="more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
