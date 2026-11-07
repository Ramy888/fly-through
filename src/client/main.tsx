import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { GulfMap } from "./GulfMap.tsx";
import { Controls, DutyClocks, Timeline, TopPill } from "./Hud.tsx";
import { useSim } from "./useSim.ts";
import { Subtitle } from "./Subtitle.tsx";
import { PlansCard } from "./PlansCard.tsx";
import { Debrief } from "./Debrief.tsx";
import { ActionCards } from "./ActionCards.tsx";
import { ChatPanel, type ChatView } from "./ChatPanel.tsx";
import type { Snapshot } from "../shared/types.ts";
import "./styles.css";

function App() {
  const snap = useSim();
  const [chat, setChat] = useState<ChatView>("all"); // open on the whole room's thread
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth >= 1400); // narrow screens start with the map clear
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
    <main className={`stage ${chatOpen ? "chat-open" : ""}`}>
      <GulfMap snap={snap} leftInset={snap && scenario && chatOpen ? 358 : 0} />
      {snap && scenario && (
        <>
          <TopPill snap={snap} />
          <Controls snap={snap} />
          <DutyClocks snap={snap} />
          {snap.decision ? (
            <PlansCard key={snap.decision.at} decision={snap.decision} messages={snap.messages} index={snap.decisions?.length ?? 1} count={Math.max(2, snap.decisions?.length ?? 1)} /* shortcut: this scenario has two decision points; read them from /api/scenario if scenarios vary */>
              <ActionCards snap={snap} />
            </PlansCard>
          ) : (
            (snap.care?.pending.length ?? 0) > 0 && <div className="glass plans"><ActionCards snap={snap} /></div>
          )}
          <Debrief snap={snap} fogStart={scenario.fogStart} fogLifts={scenario.fogLifts} />
          <Subtitle snap={snap} />
          <ChatPanel snap={snap} view={chat} onView={setChat} open={chatOpen} onOpen={setChatOpen} />
          <Timeline snap={snap} start={scenario.start} end={scenario.end} events={scenario.events} />
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
