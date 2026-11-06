import { describe, expect, it, vi } from "vitest";
import { buildPlans } from "../src/server/plans.ts";
import { WEIGHTS, blend, criteriaQuestions, factScores, weightedVerdict } from "../src/server/criteria.ts";
import { Orchestrator } from "../src/server/orchestrator.ts";
import { Sim } from "../src/server/sim.ts";
import { snapshotAt } from "../src/server/rules.ts";
import { FOG_AT_HUB } from "../src/server/scenario.ts";
import type { Recording } from "../src/shared/types.ts";

const AT = 6 * 60 + 58;
const plans = () => buildPlans({ snap: snapshotAt(FOG_AT_HUB, AT), scenario: FOG_AT_HUB });

describe("AI check: a safety gate, then six weighted criteria", () => {
  const all = (A: number, B: number, C: number) => ({ security: { A, B, C }, passengers: { A, B, C }, punctuality: { A, B, C }, environment: { A, B, C }, cost: { A, B, C }, schedule: { A, B, C } });

  it("every plan passes the gate when no crew flies past its limit, so flying less is not 'safer'", () => {
    expect(plans().map((p) => p.gate!.passes)).toEqual([true, true, true]);
    expect(plans()[1].gate!.warning).toMatch(/fog/); // B's residual risk is shown, not scored away
  });

  it("weights the criteria with the study's weights: a plan that wins the heavy criteria beats one that wins the light ones", () => {
    const scores = { ...all(0.2, 0.2, 0.6), security: { A: 0.1, B: 0.8, C: 0.1 }, passengers: { A: 0.1, B: 0.8, C: 0.1 } };
    const v = weightedVerdict(plans(), scores);
    expect(v.pick).toBe("B"); // C leads 4 light criteria; B leads security and passengers (64% of the weight)
    expect(v.reason).toMatch(/All 3 plans pass the safety gate/);
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(WEIGHTS.security).toBeGreaterThan(WEIGHTS.cost);
  });

  it("a plan that fails the gate cannot win, whatever it scores", () => {
    const ps = plans().map((p) => (p.id === "B" ? { ...p, gate: { passes: false } } : p));
    const v = weightedVerdict(ps, all(0.1, 0.8, 0.1));
    expect(v.totals.B).toBe(0);
    expect(v.pick).not.toBe("B");
    expect(v.reason).toMatch(/Plan B fails the safety gate/);
  });

  it("the numbers keep half the say: a model that contradicts them is flagged and can't flip the criterion alone", () => {
    const facts = factScores(plans());
    expect(facts.passengers.B).toBeGreaterThan(facts.passengers.C!); // B loses 280 guests, C 1,091
    const model = { ...all(0.33, 0.34, 0.33), passengers: { A: 0.13, B: 0.18, C: 0.69 } };
    const b = blend(plans(), model);
    expect(b.disagree).toEqual(["passengers"]);
    expect(b.scores.passengers.B).toBeGreaterThan(model.passengers.B);
  });

  it("describes every criterion with facts computed in code, losses as losses", () => {
    const [a, b, c] = plans();
    const q = criteriaQuestions(plans(), (p) => p.id);
    expect(Object.keys(q)).toEqual(["security", "passengers", "punctuality", "environment", "cost", "schedule"]);
    expect(b.criteria!.passengers).toContain("Harm: 280 guests lose their journey");
    expect(c.criteria!.environment).toMatch(/4 empty ferry flights/);
    expect(a.criteria!.schedule).toMatch(/of 16 aircraft home by 12:00/);
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
    const opt = (A: number, B: number, C: number) => ({ choice: "B", probabilities: { "A: Wait for the fog to lift": A, "B: Bus standby crews now": B, "C: Cancel 4 flights": C }, confidence: 0.8 });
    const decideMany = vi.fn(async () => ({
      overall: opt(0.1, 0.8, 0.1),
      security: opt(0.2, 0.6, 0.2),
      passengers: opt(0.1, 0.8, 0.1),
      punctuality: opt(0.2, 0.7, 0.1),
      environment: opt(0.3, 0.5, 0.2),
      cost: opt(0.2, 0.7, 0.1),
      schedule: opt(0.1, 0.8, 0.1),
    }));
    const llm = { chat: scriptedChat() as never, model: "m", decide: vi.fn() as never, decideMany: decideMany as never, decisionModel: "clef-flash", decisionAt: AT, debateRounds: 2 };
    const live = new Sim(FOG_AT_HUB, [], llm, { load: () => saved, save: (r) => (saved = r) });
    live.seek(AT - 1);
    live.start(60);
    while (live.snapshot().decision?.status !== "ready") await new Promise((r) => setTimeout(r, 20));
    const d = live.snapshot().decision!;
    expect(d.verdict).toMatchObject({ pick: "B" });
    expect(Object.keys(d.verdict!.scores)).toHaveLength(6);
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
