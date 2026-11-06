import { describe, expect, it, vi } from "vitest";
import { Sim } from "../src/server/sim.ts";
import { FOG_AT_HUB } from "../src/server/scenario.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSim() {
  const decide = vi.fn(async ({ options }: { options: string[] }) => ({
    choice: options[1],
    probabilities: Object.fromEntries(options.map((o, i) => [o, [0.2, 0.7, 0.1][i]])),
    confidence: 0.6,
  }));
  const sim = new Sim(FOG_AT_HUB, [], { chat: vi.fn() as never, model: "m", decide: decide as never, decisionModel: "clef-flash", decisionAt: 6 * 60 + 58 });
  return { sim, decide };
}

describe("decision point and human approval", () => {
  it("refuses approval before the decision model has scored the plans", () => {
    const { sim } = makeSim();
    expect(() => sim.approve("B")).toThrow(/no decision/);
  });

  it("pauses at the decision point, attaches calibrated probabilities, and approves once", async () => {
    vi.useFakeTimers();
    const { sim, decide } = makeSim();
    sim.seek(6 * 60 + 57);
    sim.start(60);
    vi.advanceTimersByTime(1500); // ~1.5 sim minutes at 60x
    vi.useRealTimers();
    await flush();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sim.running).toBe(false);
    const d = sim.snapshot().decision!;
    expect(d.status).toBe("ready");
    expect(d.plans.map((p) => p.probability)).toEqual([0.2, 0.7, 0.1]);

    sim.approve("B");
    expect(sim.snapshot().decision!.approved).toMatchObject({ planId: "B", by: "human" });
    expect(() => sim.approve("A")).toThrow(/already approved/);
    sim.pause();
  });

  it("moves standby crews and relieves the crews at risk once the buses arrive", async () => {
    vi.useFakeTimers();
    const { sim } = makeSim();
    sim.seek(6 * 60 + 57);
    sim.start(60);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();
    await flush();
    sim.approve("B");
    sim.pause();
    const bus = sim.snapshot().decision!.plans.find((p) => p.id === "B")!.buses![0];
    expect(sim.snapshot().crews.find((c) => c.id === bus.crew)!.at).toBe("HUB");
    sim.seek(sim.snapshot().decision!.approved!.at + bus.minutes);
    expect(sim.snapshot().crews.find((c) => c.id === bus.crew)!.at).toBe(bus.to);
    expect(sim.snapshot().crews.find((c) => c.id === bus.replaces)!.state).toBe("relieved");
  });

  it("drops the decision when someone seeks back before it, so an approval can't predate its plans", async () => {
    vi.useFakeTimers();
    const { sim } = makeSim();
    sim.seek(6 * 60 + 57);
    sim.start(60);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();
    await flush();
    sim.seek(6 * 60 + 49);
    expect(sim.snapshot().decision).toBeUndefined();
    expect(() => sim.approve("B")).toThrow(/no decision/);
  });
});

describe("demo safety", () => {
  it("replays a recorded run without calling any model", async () => {
    vi.useFakeTimers();
    const chat = vi.fn();
    const decide = vi.fn();
    const recording = {
      scenarioId: "fog-at-hub",
      recordedAt: "2026-11-06T12:00:00Z",
      agentModel: "glm-5.3-flash",
      decisionModel: "clef-flash",
      messages: [{ id: 1, t: 6 * 60 + 40, from: "crew-control" as const, text: "C07 at DWC has 57 minutes left." }],
      decision: { probabilities: { A: 0.05, B: 0.9, C: 0.05 }, confidence: 0.8 },
    };
    const sim = new Sim(FOG_AT_HUB, [{ t: 0, seats: ["hub-control"], prompt: "x" }], { chat: chat as never, model: "m", decide: decide as never, decisionModel: "clef-flash", decisionAt: 6 * 60 + 58 }, { load: () => recording, save: () => {} });
    expect(sim.setMode("recorded")).toBeNull();
    sim.seek(6 * 60 + 39);
    sim.start(60);
    vi.advanceTimersByTime(20_000);
    vi.useRealTimers();
    await flush();
    expect(chat).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    const s = sim.snapshot();
    expect(s.mode).toBe("recorded");
    expect(s.messages.map((m) => m.text)).toEqual(["C07 at DWC has 57 minutes left."]);
    expect(s.decision!.plans.map((p) => p.probability)).toEqual([0.05, 0.9, 0.05]);
  });

  it("refuses recorded mode when nothing has been recorded", () => {
    const { sim } = makeSim();
    expect(sim.setMode("recorded")).toMatch(/no recorded run/);
  });

  it("still lets the human decide if the decision model is down", async () => {
    vi.useFakeTimers();
    const sim = new Sim(FOG_AT_HUB, [], { chat: vi.fn() as never, model: "m", decide: vi.fn(async () => { throw new Error("503"); }) as never, decisionModel: "clef-flash", decisionAt: 6 * 60 + 58 });
    sim.seek(6 * 60 + 57);
    sim.start(60);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();
    await flush();
    const d = sim.snapshot().decision!;
    expect(d.status).toBe("ready");
    expect(d.error).toMatch(/decision model unavailable/);
    expect(() => sim.approve("B")).not.toThrow();
    expect(sim.audit.map((a) => a.actor)).toEqual(["system", "human"]);
    sim.pause();
  });
});

describe("shared public session", () => {
  it("rewinds to the start three minutes after the last viewer leaves, but not while someone watches", () => {
    vi.useFakeTimers();
    const { sim } = makeSim();
    const leaveA = sim.subscribe(() => {});
    const leaveB = sim.subscribe(() => {});
    sim.seek(9 * 60);
    leaveA();
    vi.advanceTimersByTime(4 * 60_000);
    expect(sim.now).toBe(9 * 60); // B is still watching
    leaveB();
    vi.advanceTimersByTime(2 * 60_000);
    expect(sim.now).toBe(9 * 60);
    sim.subscribe(() => {})(); // someone peeks and leaves: timer restarts
    vi.advanceTimersByTime(3 * 60_000);
    expect(sim.now).toBe(FOG_AT_HUB.start);
    vi.useRealTimers();
  });
});

describe("second decision point after the met update", () => {
  it("opens only after the first is approved, never re-sends crews already out, and both reliefs reach the schedule", async () => {
    vi.useFakeTimers();
    const decide = vi.fn(async ({ options }: { options: string[] }) => ({ choice: options[1], probabilities: Object.fromEntries(options.map((o, i) => [o, [0.2, 0.7, 0.1][i]])), confidence: 0.6 }));
    const sim = new Sim(FOG_AT_HUB, [], { chat: vi.fn() as never, model: "m", decide: decide as never, decisionModel: "clef-flash", decisionAt: 418, decisionPoints: [418, 512] });
    sim.seek(417);
    sim.start(60);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sim.decisions).toHaveLength(1);
    sim.seek(520); // past 08:32, but the first decision is still waiting for the human
    sim.start(60);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sim.decisions).toHaveLength(1);
    sim.approve("B");
    await vi.advanceTimersByTimeAsync(1500);
    expect(sim.decisions).toHaveLength(2);
    const d2 = sim.snapshot().decision!;
    expect(d2.status).toBe("ready");
    const sent2 = d2.plans.find((p) => p.id === "B")!.buses!.map((b) => b.crew);
    expect(sent2).toEqual(["S4", "S5", "S6"]); // S1–S3 are already on the road from the first decision
    sim.approve("B");
    sim.pause();
    const crews = new Set(sim.snapshot().recovery!.schedule.map((r) => r.crew));
    for (const c of ["S1", "S2", "S3", "S4", "S5", "S6"]) expect(crews.has(c)).toBe(true);
    sim.seek(500); // rewinding before 08:32 drops the second decision but keeps the first
    expect(sim.decisions.map((d) => d.at)).toEqual([418]);
    vi.useRealTimers();
  });
});

describe("recorded mode with an older recording", () => {
  it("never calls a model: a decision point the recording lacks is shown unscored", async () => {
    vi.useFakeTimers();
    const decideMany = vi.fn();
    const decide = vi.fn();
    const old = { scenarioId: "fog-at-hub", recordedAt: "", agentModel: "m", decisionModel: "clef-flash", messages: [], decision: { probabilities: { A: 0.1, B: 0.8, C: 0.1 }, confidence: 0.8 } };
    const sim = new Sim(FOG_AT_HUB, [], { chat: vi.fn() as never, model: "m", decide: decide as never, decideMany: decideMany as never, decisionModel: "clef-flash", decisionAt: 418, decisionPoints: [418, 512] }, { load: () => old, save: () => {} });
    sim.setMode("recorded");
    sim.seek(417);
    sim.start(60);
    await vi.advanceTimersByTimeAsync(1500);
    sim.approve("B");
    sim.seek(511);
    sim.start(60);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sim.decisions).toHaveLength(2);
    expect(sim.decision!.status).toBe("ready");
    expect(sim.decision!.error).toMatch(/not in this recording/);
    expect(decideMany).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    sim.pause();
    vi.useRealTimers();
  });
});

