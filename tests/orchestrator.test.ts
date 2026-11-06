import { describe, expect, it, vi } from "vitest";
import { Orchestrator, type Cue } from "../src/server/orchestrator.ts";
import { snapshotAt } from "../src/server/rules.ts";
import { FOG_AT_HUB } from "../src/server/scenario.ts";
import type { ChatResult } from "../src/server/llm.ts";

const snap = () => snapshotAt(FOG_AT_HUB, 6 * 60 + 42);
const flush = () => new Promise((r) => setTimeout(r, 0));

function make(cues: Cue[], replies: Record<string, ChatResult["message"][]>) {
  const chat = vi.fn(async ({ messages }: { messages: { role: string; content?: string | null }[] }) => {
    const system = messages[0].content ?? "";
    const seat = Object.keys(replies).find((k) => system.includes(k))!;
    return { message: replies[seat].shift() ?? { role: "assistant" as const, content: "standing by" } };
  });
  const o = new Orchestrator(cues, { chat: chat as never, model: "test", snapshot: snap, fogLifts: 570, onChange: () => {} });
  return { o, chat };
}

describe("orchestrator", () => {
  it("fires each cue once, runs the tool and posts the seat's answer with the tool as evidence", async () => {
    const { o, chat } = make([{ t: 400, seats: ["crew-control"], prompt: "check crews" }], {
      "Crew Control": [
        { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "get_crew_status", arguments: '{"airport":"DWC"}' } }] },
        { role: "assistant", content: "C07 at DWC has 55 minutes left." },
      ],
    });
    o.tick(399);
    expect(chat).not.toHaveBeenCalled();
    o.tick(402);
    o.tick(403); // already fired: must not run again
    await flush();
    await flush();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(o.messages).toHaveLength(1);
    expect(o.messages[0]).toMatchObject({ from: "crew-control", text: "C07 at DWC has 55 minutes left.", tools: ["get_crew_status"] });
    // the tool result fed back to the model is computed in code
    const toolMsg = chat.mock.calls[1][0].messages.find((m: { role: string }) => m.role === "tool") as { content: string };
    const crews = JSON.parse(toolMsg.content);
    expect(crews.operating[0]).toMatchObject({ crew: "C07", at: "DWC", dutyLeftMin: 55 });
    expect(crews.standby.map((c: { crew: string }) => c.crew)).toEqual(["S1", "S2", "S3"]);
  });

  it("delivers a handoff and wakes the addressed seat", async () => {
    const { o } = make([{ t: 0, seats: ["crew-hotline"], prompt: "calls" }], {
      "Crew Hotline": [
        { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "send_message", arguments: '{"to":"crew-control","text":"C07 captain reports from DWC hotel."}' } }] },
        { role: "assistant", content: "Passed to Crew Control." },
      ],
      "Crew Control": [{ role: "assistant", content: "Noted, swapping C07." }],
    });
    o.tick(1);
    for (let i = 0; i < 6; i++) await flush();
    expect(o.messages.map((m) => [m.from, m.to, m.text])).toEqual([
      ["crew-hotline", "crew-control", "C07 captain reports from DWC hotel."],
      ["crew-control", undefined, "Noted, swapping C07."],
      ["crew-hotline", undefined, "Passed to Crew Control."],
    ]);
  });

  it("drops replies that arrive after a reset", async () => {
    const { o } = make([{ t: 0, seats: ["hub-control"], prompt: "fog" }], { "Hub Control": [{ role: "assistant", content: "Hub closed." }] });
    o.tick(1);
    o.reset();
    await flush();
    expect(o.messages).toHaveLength(0);
  });
});
