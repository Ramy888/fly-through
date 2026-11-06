import { describe, expect, it, vi } from "vitest";
import { verdict, buildPlans, checkQuestions } from "../src/server/plans.ts";
import { Orchestrator } from "../src/server/orchestrator.ts";
import { Sim } from "../src/server/sim.ts";
import { snapshotAt } from "../src/server/rules.ts";
import { FOG_AT_HUB } from "../src/server/scenario.ts";
import type { Recording } from "../src/shared/types.ts";

const AT = 6 * 60 + 58;
const plans = () => buildPlans({ snap: snapshotAt(FOG_AT_HUB, AT), scenario: FOG_AT_HUB });

describe("AI check: safety first, then cost and loss", () => {
  it("picks the best cost/loss only among the safest plans", () => {
    const v = verdict(plans(), { A: 0.1, B: 0.45, C: 0.45 }, { A: 0.2, B: 0.7, C: 0.1 });
    expect(v.safeSet).toEqual(["B", "C"]);
    expect(v.pick).toBe("B");
  });

  it("never trades safety for cost: a cheaper but less safe plan loses", () => {
    const v = verdict(plans(), { A: 0.05, B: 0.15, C: 0.8 }, { A: 0.1, B: 0.85, C: 0.05 });
    expect(v.safeSet).toEqual(["C"]);
    expect(v.pick).toBe("C");
  });

  it("drops a plan that fails the duty gate whatever the model says", () => {
    const ps = plans().map((p) => (p.id === "B" ? { ...p, safety: { ...p.safety!, passesDutyGate: false } } : p));
    const v = verdict(ps, { A: 0.1, B: 0.9, C: 0.4 }, { A: 0.1, B: 0.9, C: 0.2 });
    expect(v.safeSet).not.toContain("B");
    expect(v.pick).toBe("C");
  });

  it("tells the model each plan's losses as losses (lower is better), never as 'guests protected'", () => {
    const opts = checkQuestions(plans()).cost_loss.options;
    expect(Object.values(opts).every((d) => d && /guests lose their journey/.test(d) && !/protected/.test(d))).toBe(true);
    expect(opts["B: Bus standby crews now"]).toContain("280 guests lose their journey");
  });

  it("computes each plan's safety facts in code", () => {
    const [a, b, c] = plans();
    expect([a.safety!.crewsAtLimit, b.safety!.crewsAtLimit, c.safety!.crewsAtLimit]).toEqual([4, 1, 0]);
  });
});

// A scripted model: every seat checks crews, then takes a position (B, except Guest Recovery who argues C in round 1).
function scriptedChat() {
  return vi.fn(async ({ messages, tools }: { messages: { role: string; content?: string | null }[]; tools?: { function: { name: string } }[] }) => {
    const debating = tools?.some((t) => t.function.name === "take_position");
    const system = messages[0].content ?? "";
    const user = messages[1].content ?? "";
    if (!debating) return { message: { role: "assistant" as const, content: "Brief: plan B is recommended; your call." } };
    const round = user.includes("round 2") ? 2 : 1;
    const plan = system.includes("Guest Recovery") && round === 1 ? "C" : "B";
    const toolCalled = messages.some((m) => m.role === "tool");
    if (!toolCalled) return { message: { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", type: "function" as const, function: { name: "get_crew_status", arguments: "{}" } }] } };
    return { message: { role: "assistant" as const, content: null, tool_calls: [{ id: "p1", type: "function" as const, function: { name: "take_position", arguments: JSON.stringify({ plan, reason: `round ${round} reason` }) } }] } };
  });
}

describe("debate", () => {
  it("every seat takes a position in each round, and round 2 sees round 1", async () => {
    const chat = scriptedChat();
    const o = new Orchestrator([], { chat: chat as never, model: "m", snapshot: () => snapshotAt(FOG_AT_HUB, AT), fogLifts: 570, onChange: () => {} });
    o.phase = "decision";
    const rounds: number[] = [];
    await o.debate("A: ...\nB: ...\nC: ...", (r) => rounds.push(r));
    expect(rounds).toEqual([1, 2]);
    const stances = o.all.filter((m) => m.stance);
    expect(stances).toHaveLength(12);
    expect(stances.every((m) => m.phase === "decision" && m.tools?.includes("get_crew_status"))).toBe(true);
    expect(stances.find((m) => m.from === "guest-recovery" && m.stance!.round === 1)!.stance!.plan).toBe("C");
    const round2Prompt = chat.mock.calls.map((c) => c[0].messages[1].content as string).find((t) => t.includes("round 2"))!;
    expect(round2Prompt).toContain("Guest Recovery: plan C");
  });
});

describe("decision point, live then replayed", () => {
  it("debates, checks safety then cost, records it all, and replays it with no model calls", async () => {
    let saved: Recording | null = null;
    const decideMany = vi.fn(async () => ({
      overall: { choice: "B", probabilities: { "A: Wait for the fog to lift": 0.1, "B: Bus standby crews now": 0.8, "C: Cancel 4 flights": 0.1 }, confidence: 0.7 },
      safety: { choice: "C", probabilities: { "A: Wait for the fog to lift": 0.05, "B: Bus standby crews now": 0.4, "C: Cancel 4 flights": 0.55 }, confidence: 0.6 },
      cost_loss: { choice: "B", probabilities: { "A: Wait for the fog to lift": 0.2, "B: Bus standby crews now": 0.75, "C: Cancel 4 flights": 0.05 }, confidence: 0.8 },
    }));
    const llm = { chat: scriptedChat() as never, model: "m", decide: vi.fn() as never, decideMany: decideMany as never, decisionModel: "clef-flash", decisionAt: AT, debateRounds: 2 };
    const live = new Sim(FOG_AT_HUB, [], llm, { load: () => saved, save: (r) => (saved = r) });
    live.seek(AT - 1);
    live.start(60);
    while (live.snapshot().decision?.status !== "ready") await new Promise((r) => setTimeout(r, 20));
    const d = live.snapshot().decision!;
    expect(d.verdict).toMatchObject({ safeSet: ["B", "C"], pick: "B" });
    expect(decideMany).toHaveBeenCalledTimes(1);
    expect(saved!.messages.filter((m) => m.stance)).toHaveLength(12);
    expect(saved!.messages.filter((m) => m.phase === "decision" && !m.stance)).toHaveLength(1); // the duty manager's brief
    expect(saved!.decision!.verdict!.pick).toBe("B");

    // Replay: same debate and verdict, no model calls
    const chat = vi.fn();
    const decide2 = vi.fn();
    const replay = new Sim(FOG_AT_HUB, [], { ...llm, chat: chat as never, decideMany: decide2 as never }, { load: () => saved, save: () => {} });
    expect(replay.setMode("recorded")).toBeNull();
    vi.useFakeTimers();
    replay.seek(AT - 1);
    replay.start(60);
    await vi.advanceTimersByTimeAsync(20_000);
    vi.useRealTimers();
    const r = replay.snapshot();
    expect(chat).not.toHaveBeenCalled();
    expect(decide2).not.toHaveBeenCalled();
    expect(r.decision).toMatchObject({ status: "ready", verdict: { pick: "B" } });
    expect(r.messages.filter((m) => m.stance)).toHaveLength(12);
    expect(r.stats!.messages).toBe(13);
    replay.pause();
    live.pause();
  });
});
