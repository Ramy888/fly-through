import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { GulfMap } from "./GulfMap.tsx";
import { Controls, DutyClocks, Timeline, TopPill } from "./Hud.tsx";
import { useSim } from "./useSim.ts";
import { SeatDock, Subtitle } from "./SeatDock.tsx";
import { PlansCard } from "./PlansCard.tsx";
import { Debrief } from "./Debrief.tsx";
import type { Snapshot } from "../shared/types.ts";
import "./styles.css";

function App() {
  const snap = useSim();
  const [scenario, setScenario] = useState<{ start: number; end: number; fogStart: number; fogLifts: number; events: Snapshot["events"] } | null>(null);
  useEffect(() => {
    void fetch("/api/session"); // sets the human approver cookie for this browser
  }, []);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/scenario")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((s) => !stop && setScenario(s))
        .catch(() => !stop && setTimeout(load, 1000)); // server may still be starting
    load();
    return () => void (stop = true);
  }, []);

  return (
    <main className="stage">
      <GulfMap snap={snap} />
      {snap && scenario && (
        <>
          <TopPill snap={snap} />
          <Controls snap={snap} />
          <DutyClocks snap={snap} />
          {snap.decision && <PlansCard decision={snap.decision} />}
          <Debrief snap={snap} fogStart={scenario.fogStart} fogLifts={scenario.fogLifts} />
          <Subtitle snap={snap} />
          <SeatDock snap={snap} />
          <Timeline snap={snap} start={scenario.start} end={scenario.end} events={scenario.events} />
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
