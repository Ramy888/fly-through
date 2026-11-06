import { useEffect, useState } from "react";
import type { Snapshot } from "../shared/types.ts";

/** Live snapshots from the server's sim clock (SSE). EventSource reconnects on its own. */
export function useSim(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (e) => setSnap(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  }, []);
  return snap;
}

export function simControl(action: "start" | "pause" | "reset" | "seek" | "mode", extra: { speed?: number; minute?: number; mode?: "live" | "recorded" } = {}) {
  return fetch("/api/sim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
}

export const hhmm = (m: number) => {
  const d = ((Math.floor(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
};

export const dur = (m: number) => (m <= 0 ? "0h00" : `${Math.floor(m / 60)}h${String(Math.floor(m % 60)).padStart(2, "0")}`);
