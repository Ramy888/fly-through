// Runs the seat agents: cues fire as sim time passes, seats act in parallel, handoffs wake the addressed seat.
import { SEATS, type Plan, type SeatAction, type SeatId, type Snapshot, type WarMessage } from "../shared/types.ts";
import { ACTION_TOOL, ownsActions } from "./actions.ts";
import { COMMON_PROMPT, DEBATE_TOOLS, ROLES, SEAT_NAME, TOOLS, debatePrompt, runTool } from "./agents.ts";
import type { ChatMessage, ToolSpec, chat as chatFn } from "./llm.ts";

export type Cue = { t: number; seats: SeatId[]; prompt: string };

const MAX_TOOL_ROUNDS = 3;
const MAX_HOPS = 1; // a handoff wakes the addressed seat once; its reply cannot trigger further hops
const KEEP_MESSAGES = 40;

export class Orchestrator {
  messages: WarMessage[] = [];
  all: WarMessage[] = []; // every message of this run, for the recording
  thinking = new Set<SeatId>();
  stats = { messages: 0, handoffs: 0, toolBacked: 0 }; // whole run; `messages` above keeps only the latest window
  phase?: "decision"; // set while the sim is paused at a decision point
  actions: SeatAction[] = []; // every action record posted or replayed this run (a card's later resolution reuses its id)
  private fired = new Set<number>();
  private replayed = new Set<number>(); // recorded message ids already shown (the message window drops old ones)
  private nextId = 1;
  private epoch = 0; // bumped on reset so late replies from a previous run are dropped

  constructor(
    private cues: Cue[],
    private deps: {
      chat: typeof chatFn;
      model: string;
      snapshot: () => Snapshot;
      fogLifts: number;
      onChange: () => void;
      onPost?: (m: WarMessage) => void;
      // a seat asks to carry out an action; the sim prices it, checks the budget and runs it (or raises a card)
      requestAction?: (seat: SeatId, args: Record<string, unknown>) => Promise<{ result: unknown; post?: { text: string; action: SeatAction } }>;
    },
  ) {}

  reset() {
    this.epoch++;
    this.messages = [];
    this.all = [];
    this.thinking = new Set();
    this.stats = { messages: 0, handoffs: 0, toolBacked: 0 };
    this.actions = [];
    this.phase = undefined;
    this.replayed.clear();
    this.fired.clear();
  }

  /** Called on every sim tick: fire each cue whose time has been reached, once. */
  tick(now: number) {
    this.cues.forEach((cue, i) => {
      if (cue.t <= now && !this.fired.has(i)) {
        this.fired.add(i);
        for (const seat of cue.seats) void this.runSeat(seat, cue.prompt, 0);
      }
    });
  }

  /** Recorded mode: post the recorded messages whose time has come, and show seats as thinking just before they speak. */
  replay(recorded: WarMessage[], now: number) {
    let changed = false;
    for (const m of recorded) {
      // decision-phase messages are replayed in order by the sim while it is paused there
      if (m.t <= now && !m.phase && !this.replayed.has(m.id)) {
        this.replayed.add(m.id);
        this.messages.push(m);
        this.count(m);
        changed = true;
      }
    }
    const ahead = new Set(recorded.filter((m) => m.t > now && m.t - now <= 2).map((m) => m.from));
    if (changed || ahead.size !== this.thinking.size || [...ahead].some((s) => !this.thinking.has(s))) {
      this.thinking = ahead;
      this.messages = this.messages.slice(-KEEP_MESSAGES);
      this.deps.onChange();
    }
  }

  /** Recorded mode: show one recorded message now (used for the decision-phase replay). */
  show(m: WarMessage) {
    if (this.replayed.has(m.id)) return;
    this.replayed.add(m.id);
    this.messages.push(m);
    this.count(m);
    if (this.messages.length > KEEP_MESSAGES) this.messages.shift();
    this.deps.onChange();
  }

  private count(m: WarMessage) {
    if (m.action) this.actions.push(m.action);
    this.stats.messages++;
    if (m.to) this.stats.handoffs++;
    if (m.tools?.length) this.stats.toolBacked++;
  }

  /** Two debate rounds: every seat takes a position, then answers the strongest argument against it. */
  async debate(planLines: string, onRound: (round: number) => void, rounds = 2): Promise<void> {
    const firstId = this.nextId;
    for (let round = 1; round <= rounds; round++) {
      onRound(round);
      const positions = this.all
        .filter((m) => m.id >= firstId && m.stance?.round === 1)
        .map((m) => `- ${SEAT_NAME[m.from]}: plan ${m.stance!.plan}, because ${m.text}`)
        .join("\n");
      await this.idle(); // a seat still answering a handoff would otherwise miss the round
      await Promise.all(SEATS.map((s) => this.runSeat(s.id, debatePrompt(s.id, round, planLines, positions), MAX_HOPS, { tools: DEBATE_TOOLS, round })));
    }
  }

  /** Wait (up to 20 s) until no seat is mid-turn. */
  private async idle() {
    for (let i = 0; i < 100 && this.thinking.size > 0; i++) await new Promise((r) => setTimeout(r, 200));
  }

  /** The sim posts an action's outcome for the seat that asked (e.g. after the human decides on a card). */
  postAction(seat: SeatId, text: string, action: SeatAction) {
    this.post({ t: this.deps.snapshot().now, from: seat, text, action });
  }

  private post(m: Omit<WarMessage, "id">) {
    const msg: WarMessage = { ...m, id: this.nextId++, ...(this.phase ? { phase: this.phase } : {}) };
    this.count(msg);
    this.messages.push(msg);
    this.all.push(msg);
    if (this.messages.length > KEEP_MESSAGES) this.messages.shift();
    this.deps.onPost?.(msg);
    this.deps.onChange();
  }

  private transcript(): string {
    return this.messages
      .slice(-10)
      .map((m) => `${SEAT_NAME[m.from]}${m.to ? ` → ${SEAT_NAME[m.to]}` : ""}: ${m.text}`)
      .join("\n");
  }

  async runSeat(seat: SeatId, prompt: string, hop: number, opts: { tools?: ToolSpec[]; round?: number } = {}): Promise<void> {
    if (this.thinking.has(seat)) return; // one call per seat at a time
    const epoch = this.epoch;
    this.thinking.add(seat);
    this.deps.onChange();
    const used: string[] = [];
    try {
      const msgs: ChatMessage[] = [
        { role: "system", content: `${COMMON_PROMPT}\n\n${ROLES[seat]}` },
        { role: "user", content: `Recent ops-room messages:\n${this.transcript() || "(none yet)"}\n\nNow: ${prompt}` },
      ];
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const tools = opts.tools ?? (ownsActions(seat) && this.deps.requestAction ? [...TOOLS, ACTION_TOOL] : TOOLS);
        const { message } = await this.deps.chat({ model: this.deps.model, messages: msgs, tools, reasoningEffort: "low", maxTokens: 400 });
        if (epoch !== this.epoch) return;
        msgs.push(message);
        const calls = message.tool_calls ?? [];
        if (calls.length === 0) {
          const text = message.content?.trim();
          if (text) this.post({ t: this.deps.snapshot().now, from: seat, text, tools: used.length ? [...new Set(used)] : undefined });
          return;
        }
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            /* malformed arguments: the tool reports the error back to the model */
          }
          if (call.function.name === "take_position") {
            const plan = args.plan as Plan["id"];
            const reason = String(args.reason ?? "").trim();
            if (["A", "B", "C"].includes(plan) && reason) {
              this.post({ t: this.deps.snapshot().now, from: seat, text: reason, stance: { plan, round: opts.round ?? 1 }, tools: used.length ? [...new Set(used)] : undefined });
              return; // a position ends the seat's turn
            }
            msgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "plan must be A, B or C, with a reason" }) });
            continue;
          }
          used.push(call.function.name);
          let result: unknown;
          if (call.function.name === "request_action" && this.deps.requestAction) {
            const r = await this.deps.requestAction(seat, args);
            if (epoch !== this.epoch) return;
            if (r.post) this.post({ t: this.deps.snapshot().now, from: seat, text: r.post.text, action: r.post.action, tools: [...new Set(used)] });
            result = r.result;
          } else if (call.function.name === "send_message") {
            const to = args.to as SeatId;
            const text = String(args.text ?? "").trim();
            if (ROLES[to] && to !== seat && text) {
              this.post({ t: this.deps.snapshot().now, from: seat, to, text });
              if (hop < MAX_HOPS) void this.runSeat(to, `${SEAT_NAME[seat]} asked you: "${text}". Respond.`, hop + 1);
              result = { delivered: true };
            } else result = { delivered: false, error: "invalid recipient or empty text" };
          } else {
            result = runTool(call.function.name, args, this.deps.snapshot(), this.deps.fogLifts);
          }
          msgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    } catch (e) {
      if (epoch === this.epoch) console.error(`[agent ${seat}]`, (e as Error).message);
    } finally {
      if (epoch === this.epoch) {
        this.thinking.delete(seat);
        this.deps.onChange();
      }
    }
  }
}
