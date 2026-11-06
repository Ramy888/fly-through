// The sim clock: advances scenario time, wakes the seat agents (live) or replays a recorded run,
// opens the decision point, and pushes snapshots to every subscriber (SSE clients).
import type { AuditEntry, Decision, Plan, Recording, ReturnFlight, Scenario, Snapshot, Verdict } from "../shared/types.ts";
import { reliefOf, returnSchedule } from "./recovery.ts";
import type { chat as chatFn, decide as decideFn, decideMany as decideManyFn } from "./llm.ts";
import { PLAN_QUESTION, buildPlans, decisionState, planOption } from "./plans.ts";
import { CRITERIA, blend, criteriaQuestions, weightedVerdict } from "./criteria.ts";
import { Orchestrator, type Cue } from "./orchestrator.ts";
import { scenarioAt, snapshotAt } from "./rules.ts";

const TICK_MS = 250;
const KEEP_AUDIT = 500;
const IDLE_RESET_MS = 3 * 60_000; // when nobody has watched for 3 min, rewind so the next visitor starts at 05:30
const DEBATE_REPLAY_MS = 900; // recorded mode: pace of the replayed debate while the sim is paused
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (p: Partial<Record<string, number>>) => Object.entries(p).map(([k, v]) => `${k} ${Math.round((v ?? 0) * 100)}%`).join(", ");
const planLines = (plans: Plan[]) =>
  plans
    .map((p) => `${p.id}: ${p.title}. ${p.summary} Safety gate: ${p.gate?.passes === false ? "FAILS" : "passes"}${p.gate?.warning ? ` (warning: ${p.gate.warning})` : ""}. ` + CRITERIA.map((c) => `${c.label}: ${p.criteria?.[c.id] ?? "n/a"}`).join(" "))
    .join("\n");

type Llm = { chat: typeof chatFn; model: string; decide: typeof decideFn; decideMany?: typeof decideManyFn; decisionModel: string; decisionAt: number; decisionPoints?: number[]; debateRounds?: number };
type Store = { load: () => Recording | null; save: (r: Recording) => void };

export class Sim {
  now: number;
  speed = 60; // sim seconds per real second
  running = false;
  mode: Snapshot["mode"] = "live";
  readonly agents: Orchestrator;
  decisions: Decision[] = []; // one per decision point reached, oldest first
  audit: AuditEntry[] = [];
  private timer?: NodeJS.Timeout;
  private subscribers = new Set<(s: Snapshot) => void>();
  private recording: Recording | null = null;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    readonly scenario: Scenario,
    cues: Cue[],
    private llm: Llm,
    private store: Store = { load: () => null, save: () => {} },
  ) {
    this.now = scenario.start;
    this.agents = new Orchestrator(cues, {
      chat: llm.chat,
      model: llm.model,
      fogLifts: scenario.fogLifts,
      snapshot: () => this.baseSnapshot(),
      onChange: () => this.publish(),
      onPost: (m) => {
        this.log({ t: m.t, actor: "agent", who: m.from, action: m.to ? `handoff to ${m.to}` : "call-out", detail: `${m.text}${m.tools ? ` [checked: ${m.tools.join(", ")}]` : ""}` });
        this.saveLive();
      },
    });
  }

  /** The latest decision point (the one the plans card shows and the human approves). */
  get decision(): Decision | undefined {
    return this.decisions.at(-1);
  }

  /** The scenario as the room knows it now: a met update can move the fog lift. */
  private world(): Scenario {
    return scenarioAt(this.scenario, Math.floor(this.now));
  }

  /** What earlier approved decisions set in motion: relief crews on their way and cancelled flights. */
  private prior() {
    const approved = this.decisions.flatMap((d) => {
      const plan = d.approved && d.plans.find((p) => p.id === d.approved!.planId);
      return plan ? [{ plan, at: d.approved!.at }] : [];
    });
    return { approved, relief: approved.flatMap((a) => reliefOf(a.plan, a.at)), cancelled: approved.flatMap((a) => a.plan.cancelled ?? []) };
  }

  private log(e: AuditEntry) {
    this.audit.push(e);
    if (this.audit.length > KEEP_AUDIT) this.audit.shift();
  }

  private baseSnapshot(): Snapshot {
    const now = Math.floor(this.now);
    const schedule = this.returns();
    const base = snapshotAt(this.scenario, now, this.speed, this.running, schedule);
    return { ...base, recovery: { schedule, landed: schedule.filter((r) => r.land <= now).length, total: schedule.length } };
  }

  private returnsKey = "";
  private returnsCache: ReturnFlight[] = [];
  /** The trip home for every diverted flight, given every approved plan (none approved: everyone waits, like plan A). */
  private returns(): ReturnFlight[] {
    const world = this.world();
    const { approved, relief, cancelled } = this.prior();
    const key = `${world.fogLifts}|${approved.map((a) => `${a.plan.id}@${a.at}`).join(",")}`;
    if (key !== this.returnsKey) {
      this.returnsKey = key;
      this.returnsCache = returnSchedule(world, world.fogLifts, { relief, cancelled });
    }
    return this.returnsCache;
  }

  snapshot(): Snapshot {
    const base = this.baseSnapshot();
    const agentModel = this.mode === "recorded" ? (this.recording?.agentModel ?? this.llm.model) : this.llm.model;
    return { ...base, mode: this.mode, crews: this.applyApproval(base), messages: this.agents.messages, thinking: [...this.agents.thinking], decision: this.decision, decisions: this.decisions, agentModel, stats: { ...this.agents.stats } };
  }

  /** Recorded mode replays the last good live run: same messages and scores, no inference calls. */
  setMode(mode: Snapshot["mode"]): string | null {
    if (mode === "recorded") {
      this.recording = this.store.load();
      if (!this.recording) return "no recorded run yet: do one live run first";
    }
    this.mode = mode;
    this.reset();
    return null;
  }

  /** Live runs are saved as they go, so the latest good run can be replayed later. */
  private saveLive() {
    if (this.mode !== "live") return;
    // every decision point is saved, unscored ones too, so a replay's decision indices stay aligned
    const recorded = this.decisions.map((d) => ({ probabilities: Object.fromEntries(d.plans.map((p) => [p.id, p.probability ?? 0])), confidence: d.confidence, ...(d.verdict ? { verdict: d.verdict } : {}) }));
    this.store.save({
      scenarioId: this.scenario.id,
      recordedAt: new Date().toISOString(),
      agentModel: this.llm.model,
      decisionModel: this.llm.decisionModel,
      messages: this.agents.all,
      decision: recorded[0],
      decisions: recorded,
    });
  }

  /** After a human approves a bus plan, standby crews travel by road and relieve the crews at risk on arrival. */
  private applyApproval(base: Snapshot): Snapshot["crews"] {
    const buses = this.prior().approved.flatMap((a) => (a.plan.buses ?? []).map((b) => ({ ...b, arrives: a.at + b.minutes })));
    if (!buses.length) return base.crews;
    return base.crews.map((c) => {
      const asStandby = buses.find((b) => b.crew === c.id);
      if (asStandby) return { ...c, at: base.now >= asStandby.arrives ? asStandby.to : c.at };
      const relieved = buses.find((b) => b.replaces === c.id && base.now >= b.arrives);
      return relieved ? { ...c, state: "relieved" as const } : c;
    });
  }

  /** Decision point: plans built in code, the seats debate them, the Vultr decision model checks safety then cost and loss,
   *  and the sim waits for the human. In recorded mode the same steps replay from the recording, with no model calls. */
  private async openDecision() {
    const snap = this.snapshot();
    const { relief, cancelled } = this.prior();
    const plans = buildPlans({ snap, scenario: this.world(), prior: { relief, cancelled } });
    const decision: Decision = { status: "debating", round: 1, at: snap.now, plans, model: this.llm.decisionModel };
    const index = this.decisions.length;
    this.decisions.push(decision);
    this.pause();
    const alive = () => this.decisions[index] === decision; // false once a reset or seek-back dropped this decision
    const recording = this.mode === "recorded" ? this.recording : null;
    const recorded = recording ? { ...recording, decision: recording.decisions?.[index] ?? (index === 0 ? recording.decision : undefined) } : null;
    const phaseMsgs = (recorded?.messages ?? []).filter((m) => m.phase === "decision" && Math.abs(m.t - decision.at) <= 2);

    // 1. Debate
    if (recorded) {
      for (const m of phaseMsgs.filter((x) => x.stance)) {
        await sleep(DEBATE_REPLAY_MS);
        if (!alive()) return;
        decision.round = m.stance!.round;
        this.agents.show(m);
      }
    } else if (this.llm.debateRounds) {
      this.agents.phase = "decision";
      try {
        await this.agents.debate(planLines(plans), (r) => {
          decision.round = r;
          this.publish();
        }, this.llm.debateRounds);
      } finally {
        this.agents.phase = undefined;
      }
    }
    if (!alive()) return;

    // 2. AI check: safety first, then cost and loss
    decision.status = "scoring";
    this.publish();
    try {
      // Recorded mode never calls a model: a decision point the recording lacks is shown unscored instead.
      if (recording && !recorded?.decision) throw new Error("not in this recording");
      const scored = recorded?.decision ? recorded.decision : await this.score(snap, plans);
      if (!alive()) return;
      decision.plans = plans.map((p): Plan => ({ ...p, probability: scored.probabilities[p.id] ?? 0 }));
      decision.confidence = scored.confidence;
      decision.verdict = scored.verdict;
      const v = scored.verdict;
      this.log({
        t: decision.at, actor: "system", who: this.llm.decisionModel, action: v ? `recommends plan ${v.pick}` : "scored plans",
        detail: v ? `${v.reason} ${CRITERIA.map((c) => `${c.label} ${fmt(v.scores[c.id])}`).join("; ")}.` : fmt(scored.probabilities),
      });
    } catch (e) {
      if (!alive()) return;
      // The human can still decide on the computed impacts alone; the plans are shown unscored.
      decision.error = `decision model unavailable: ${(e as Error).message.slice(0, 160)}`;
      this.log({ t: decision.at, actor: "system", who: this.llm.decisionModel, action: "scoring failed", detail: decision.error });
    }

    // 3. The duty manager briefs the human (live), or the recorded brief replays
    if (recorded) {
      for (const m of phaseMsgs.filter((x) => !x.stance)) {
        await sleep(DEBATE_REPLAY_MS);
        if (!alive()) return;
        this.agents.show(m);
      }
    } else if (this.llm.debateRounds && decision.verdict) {
      this.agents.phase = "decision";
      try {
        await this.agents.runSeat("ops-duty-manager", `The debate is over and the AI check (a safety gate, then six weighted criteria) says: ${decision.verdict.reason} Brief the human approver in one sentence, including any safety warning. You do not approve.`, 1);
      } finally {
        this.agents.phase = undefined;
      }
    }
    if (!alive()) return;
    decision.status = "ready";
    this.saveLive();
    this.publish();
  }

  /** One decision-model call: the overall question plus one question per criterion; the gate and weights are applied in code. */
  private async score(snap: Snapshot, plans: Plan[]): Promise<NonNullable<Recording["decision"]>> {
    const state = decisionState({ snap, scenario: this.scenario }, plans);
    const byPlan = (a: { probabilities: Record<string, number> }) => Object.fromEntries(plans.map((p) => [p.id, a.probabilities[planOption(p)] ?? 0]));
    if (!this.llm.decideMany) {
      const a = await this.llm.decide({ model: this.llm.decisionModel, state, question: PLAN_QUESTION, options: plans.map(planOption) });
      return { probabilities: byPlan(a), confidence: a.confidence };
    }
    const answers = await this.llm.decideMany({
      model: this.llm.decisionModel,
      state,
      questions: { overall: { question: PLAN_QUESTION, options: Object.fromEntries(plans.map((p) => [planOption(p), null])) }, ...criteriaQuestions(plans, planOption) },
    });
    const model = Object.fromEntries(CRITERIA.map((c) => [c.id, byPlan(answers[c.id])])) as Verdict["scores"];
    const b = blend(plans, model);
    const v = weightedVerdict(plans, b.scores);
    const flag = b.disagree?.length ? ` The model's judgement differed from the numbers on ${b.disagree.join(", ")}; the blend keeps both.` : "";
    return { probabilities: byPlan(answers.overall), confidence: answers.overall.confidence, verdict: { ...b, ...v, reason: v.reason + flag } };
  }

  /** Only reachable through the human approval endpoint; agents have no tool for it. */
  approve(planId: Plan["id"]): Decision {
    if (!this.decision || this.decision.status !== "ready") throw new Error("no decision is waiting for approval");
    if (this.decision.approved) throw new Error("already approved");
    const plan = this.decision.plans.find((p) => p.id === planId);
    if (!plan) throw new Error("unknown plan");
    this.decision.approved = { planId, at: Math.floor(this.now), by: "human" };
    this.log({ t: Math.floor(this.now), actor: "human", who: "approver", action: `approved plan ${planId}`, detail: plan.summary });
    if (this.mode === "live") {
      // The seats now carry out the approved plan and call out what happens next.
      const brief = `The human approver has just approved plan ${plan.id}: ${plan.title}. ${plan.summary}`;
      void this.agents.runSeat("crew-control", `${brief} Call out what happens next for the crews.`, 1);
      void this.agents.runSeat("guest-recovery", `${brief} Call out what this means for the guests.`, 1);
    }
    this.start();
    return this.decision;
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    clearTimeout(this.idleTimer);
    this.subscribers.add(fn);
    fn(this.snapshot());
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) this.idleTimer = setTimeout(() => this.reset(), IDLE_RESET_MS);
    };
  }

  private publish() {
    const s = this.snapshot();
    for (const fn of this.subscribers) fn(s);
  }

  start(speed?: number) {
    if (speed) this.speed = speed;
    if (this.running) return this.publish();
    this.running = true;
    this.timer = setInterval(() => {
      this.now = Math.min(this.scenario.end, this.now + (this.speed * TICK_MS) / 1000 / 60);
      if (this.mode === "recorded" && this.recording) this.agents.replay(this.recording.messages, this.now);
      else this.agents.tick(this.now);
      // the next decision point opens once the previous decision has been approved
      const next = (this.llm.decisionPoints ?? [this.llm.decisionAt])[this.decisions.length];
      if (next !== undefined && (!this.decision || this.decision.approved) && this.now >= next) void this.openDecision();
      if (this.now >= this.scenario.end) this.pause();
      this.publish();
    }, TICK_MS);
    this.publish();
  }

  pause() {
    this.running = false;
    clearInterval(this.timer);
    this.publish();
  }

  reset() {
    this.pause();
    this.now = this.scenario.start;
    this.agents.reset();
    this.decisions = [];
    this.audit = [];
    this.publish();
  }

  seek(minute: number) {
    this.now = Math.max(this.scenario.start, Math.min(this.scenario.end, minute));
    // Rewinding past the decision point reopens it later; keeping it would let an approval predate its own plans.
    this.decisions = this.decisions.filter((d) => d.at <= this.now);
    this.publish();
  }
}
