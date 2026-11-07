import { describe, expect, it, vi } from "vitest";
import { Sim } from "../src/server/sim.ts";
import { FOG_AT_HUB } from "../src/server/scenario.ts";
import type { Sandbox } from "../src/server/actions.ts";

const T = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

function makeSim(load?: () => unknown) {
  const sandbox = vi.fn<Sandbox>(async (job, params) => ({
    ok: true,
    result: { summary: `${job} ok`, checksum: "abc123", rows: 1, ...(job === "position_crew" ? { ready_at: Number(params.now) + 200 } : {}) },
    ms: 300, image: "python:3.12-alpine", runtime: "runc", limits: "no network",
  }));
  const sim = new Sim(FOG_AT_HUB, [], { chat: vi.fn() as never, model: "m", decide: vi.fn() as never, decisionModel: "clef-flash", decisionAt: T("06:58"), decisionPoints: [], sandbox }, load ? { load: load as never, save: () => {} } : undefined);
  return { sim, sandbox };
}

describe("seat actions within delegated budgets", () => {
  it("runs an action within budget in the sandbox at once", async () => {
    const { sim, sandbox } = makeSim();
    sim.seek(T("07:25"));
    const r = await sim.requestAction("guest-recovery", { kind: "meal_vouchers", airport: "DWC", quantity: 1000 });
    expect(sandbox).toHaveBeenCalledWith("meal_vouchers", { airport: "DWC", guests: 1000 });
    expect(r.post!.action).toMatchObject({ status: "done", by: "delegated", costAed: 40_000, sandbox: { checksum: "abc123" } });
  });

  it("turns an over-budget request into a card, and runs it only when the human approves", async () => {
    const { sim, sandbox } = makeSim();
    sim.seek(T("07:45")); // every DWC diversion has waited an hour by now
    const r = await sim.requestAction("guest-recovery", { kind: "hotel_block", airport: "DWC", quantity: 1400 }); // AED 350,000 > 300,000
    expect(r.result).toMatchObject({ status: "pending_human_approval" });
    expect(sandbox).not.toHaveBeenCalled();
    // the orchestrator posts the card; here the sim records it the same way
    (sim as unknown as { agents: { postAction: (s: string, t: string, a: unknown) => void } }).agents.postAction("guest-recovery", r.post!.text, r.post!.action);
    expect(sim.snapshot().care!.pending).toHaveLength(1);
    const done = await sim.resolveAction(r.post!.action.id, true);
    expect(done).toMatchObject({ status: "approved", by: "human" });
    expect(sandbox).toHaveBeenCalledTimes(1);
    expect(sim.snapshot().care).toMatchObject({ hotelGuests: 1400, pending: [] });
    await expect(sim.resolveAction(r.post!.action.id, true)).rejects.toThrow(/no such pending/);
  });

  it("never books the same guests twice at one airport", async () => {
    const { sim } = makeSim();
    sim.seek(T("07:25"));
    const pax = FOG_AT_HUB.flights.filter((f) => f.divertTo === "DWC" && f.divertAt! <= T("06:25")).reduce((n, f) => n + f.pax, 0);
    const first = await sim.requestAction("guest-recovery", { kind: "meal_vouchers", airport: "DWC", quantity: pax - 10 });
    (sim as unknown as { agents: { postAction: (s: string, t: string, a: unknown) => void } }).agents.postAction("guest-recovery", first.post!.text, first.post!.action);
    expect((await sim.requestAction("guest-recovery", { kind: "meal_vouchers", airport: "DWC", quantity: 11 })).result).toMatchObject({ error: expect.stringMatching(/only 10 guests/) });
  });

  it("books guest care only once guests have waited an hour", async () => {
    const { sim } = makeSim();
    sim.seek(T("06:15"));
    expect((await sim.requestAction("guest-recovery", { kind: "meal_vouchers", airport: "DWC", quantity: 10 })).result).toMatchObject({ error: expect.stringMatching(/only 0 guests/) });
  });

  it("refuses actions a seat doesn't own and quantities above the guests there", async () => {
    const { sim, sandbox } = makeSim();
    sim.seek(T("07:25"));
    expect((await sim.requestAction("hub-control", { kind: "hotel_block", airport: "DWC", quantity: 10 })).result).toMatchObject({ error: expect.stringMatching(/belongs to/) });
    expect((await sim.requestAction("guest-recovery", { kind: "hotel_block", airport: "BAH", quantity: 9999 })).result).toMatchObject({ error: expect.any(String) });
    expect((await sim.requestAction("crew-control", { kind: "position_crew", airport: "DWC", quantity: 1 })).result).toMatchObject({ error: expect.stringMatching(/road/) });
    expect(sandbox).not.toHaveBeenCalled();
  });

  it("an approved positioning trip brings FT 893 home from Bahrain earlier than the fresh crew after reopening", async () => {
    const { sim } = makeSim();
    sim.seek(T("08:32"));
    const before = sim.snapshot().recovery!.schedule.find((r) => r.flight === "FT 893")!;
    const r = await sim.requestAction("crew-control", { kind: "position_crew", airport: "BAH", quantity: 1 }); // AED 18,000 > 15,000: a card
    expect(r.post!.action).toMatchObject({ status: "pending", replaces: "C12" });
    (sim as unknown as { agents: { postAction: (s: string, t: string, a: unknown) => void } }).agents.postAction("crew-control", r.post!.text, r.post!.action);
    await sim.resolveAction(r.post!.action.id, true);
    const after = sim.snapshot().recovery!.schedule.find((r) => r.flight === "FT 893")!;
    expect(before.land).toBe(T("13:45")); // after the 08:30 forecast slip, a fresh crew only leaves after reopening
    expect(after.crew).toBe("positioned crew");
    expect(after.land).toBeLessThan(before.land);
  });
});

describe("recorded runs with actions", () => {
  it("replay actions without calling the sandbox, and refuse a human decision on a recorded card", async () => {
    vi.useFakeTimers();
    const card = { id: 1, kind: "hotel_block" as const, airport: "DWC" as const, quantity: 1400, costAed: 350_000, requestedBy: "guest-recovery" as const, status: "pending" as const };
    const recording = {
      scenarioId: "fog-at-hub", recordedAt: "2026-11-07T20:00:00Z", agentModel: "glm-5.3-flash", decisionModel: "clef-flash",
      messages: [{ id: 1, t: T("07:26"), from: "guest-recovery" as const, text: "Asking the human.", action: card }],
      decision: { probabilities: { A: 0.1, B: 0.8, C: 0.1 }, confidence: 0.7 },
    };
    const { sim, sandbox } = makeSim(() => recording);
    expect(sim.setMode("recorded")).toBeNull();
    sim.seek(T("07:25"));
    sim.start(60);
    vi.advanceTimersByTime(5_000);
    vi.useRealTimers();
    sim.pause();
    expect(sim.snapshot().care!.pending).toHaveLength(1);
    await expect(sim.resolveAction(1, true)).rejects.toThrow(/recorded run/);
    expect(sandbox).not.toHaveBeenCalled();
  });
});
