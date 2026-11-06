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
