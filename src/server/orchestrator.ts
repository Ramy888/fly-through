// Runs the seat agents: cues fire as sim time passes, seats act in parallel, handoffs wake the addressed seat.
import type { SeatId, Snapshot, WarMessage } from "../shared/types.ts";
import { COMMON_PROMPT, ROLES, SEAT_NAME, TOOLS, runTool } from "./agents.ts";
import type { ChatMessage, chat as chatFn } from "./llm.ts";

export type Cue = { t: number; seats: SeatId[]; prompt: string };

const MAX_TOOL_ROUNDS = 3;
const MAX_HOPS = 1; // a handoff wakes the addressed seat once; its reply cannot trigger further hops
const KEEP_MESSAGES = 40;

export class Orchestrator {
  messages: WarMessage[] = [];
  all: WarMessage[] = []; // every message of this run, for the recording
  thinking = new Set<SeatId>();
  private fired = new Set<number>();
  private nextId = 1;
  private epoch = 0; // bumped on reset so late replies from a previous run are dropped

  constructor(
    private cues: Cue[],
    private deps: { chat: typeof chatFn; model: string; snapshot: () => Snapshot; fogLifts: number; onChange: () => void; onPost?: (m: WarMessage) => void },
  ) {}

  reset() {
    this.epoch++;
    this.messages = [];
    this.all = [];
    this.thinking = new Set();
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
    const shown = new Set(this.messages.map((m) => m.id));
    let changed = false;
    for (const m of recorded) {
      if (m.t <= now && !shown.has(m.id)) {
        this.messages.push(m);
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

  private post(m: Omit<WarMessage, "id">) {
    const msg = { ...m, id: this.nextId++ };
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

  async runSeat(seat: SeatId, prompt: string, hop: number): Promise<void> {
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
        const { message } = await this.deps.chat({ model: this.deps.model, messages: msgs, tools: TOOLS, reasoningEffort: "low", maxTokens: 400 });
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
          used.push(call.function.name);
          let result: unknown;
          if (call.function.name === "send_message") {
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
