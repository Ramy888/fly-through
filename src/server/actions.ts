// Seat actions: the work a seat may carry out itself. Prices, owners and budgets are in code; every action runs as a
// fixed job in a disposable sandbox (see sandbox/runner.py). Within the seat's budget it runs at once ("delegated");
// above it, it waits for the human approver. Prices are simplified and illustrative.
import { AIRPORTS, type AirportId } from "../shared/geo.ts";
import type { ActionKind, Care, SeatAction, SeatId } from "../shared/types.ts";
import type { ToolSpec } from "./llm.ts";

export const CATALOG: Record<ActionKind, { owners: SeatId[]; unitAed: number; unit: string; max: number; label: (q: number, a: string) => string }> = {
  hotel_block: { owners: ["guest-recovery"], unitAed: 250, unit: "guest", max: 5000, label: (q, a) => `hotel rooms for ${q.toLocaleString("en-US")} guests at ${a}` },
  meal_vouchers: { owners: ["guest-recovery"], unitAed: 40, unit: "guest", max: 5000, label: (q, a) => `${q.toLocaleString("en-US")} meal vouchers at ${a}` },
  crew_rest: { owners: ["crew-hotline", "crew-control"], unitAed: 600, unit: "crew", max: 20, label: (q, a) => `rest rooms for ${q} crew${q > 1 ? "s" : ""} at ${a}` },
  position_crew: { owners: ["crew-control"], unitAed: 18_000, unit: "trip", max: 1, label: (_q, a) => `a positioning trip for a fresh crew to ${a}` },
};

// Delegated authority per seat (AED). Anything that would take a seat past it goes to the human.
export const BUDGET: Partial<Record<SeatId, number>> = { "guest-recovery": 300_000, "crew-control": 15_000, "crew-hotline": 10_000 };

const DIVERSION_AIRPORTS = (Object.keys(AIRPORTS) as AirportId[]).filter((a) => a !== "HUB");

export const ACTION_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "request_action",
    description:
      "Carry out an action your seat owns. Within your delegated budget it runs at once as a job in a sandbox; above it, it goes to the human approver as a card. " +
      "Guest care is for guests who have waited at least 60 minutes. Kinds: hotel_block (quantity = guests, AED 250 each), meal_vouchers (quantity = guests, AED 40 each), crew_rest (quantity = crews, AED 600 each), " +
      "position_crew (a fresh crew to an airport with no road, by road to DXB then a flight; quantity 1, AED 18,000).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: Object.keys(CATALOG) },
        airport: { type: "string", enum: DIVERSION_AIRPORTS },
        quantity: { type: "integer", minimum: 1 },
        reason: { type: "string", description: "One short sentence." },
      },
      required: ["kind", "airport", "quantity"],
    },
  },
};

export const ownsActions = (seat: SeatId) => Object.values(CATALOG).some((c) => c.owners.includes(seat));
export const costOf = (kind: ActionKind, quantity: number) => CATALOG[kind].unitAed * quantity;

/** The sandbox job and its parameters for an action. */
export function jobFor(a: Pick<SeatAction, "kind" | "airport" | "quantity">, now: number): { job: string; params: Record<string, string | number> } {
  switch (a.kind) {
    case "hotel_block":
    case "meal_vouchers":
      return { job: a.kind, params: { airport: a.airport, guests: a.quantity } };
    case "crew_rest":
      return { job: a.kind, params: { airport: a.airport, crews: a.quantity } };
    case "position_crew":
      return { job: a.kind, params: { airport: a.airport, now: Math.floor(now) } };
  }
}

/** Latest state of every action (a pending card is later resolved under the same id). */
export function latestActions(all: SeatAction[]): SeatAction[] {
  const byId = new Map<number, SeatAction>();
  for (const a of all) byId.set(a.id, a);
  return [...byId.values()];
}

export function careOf(all: SeatAction[]): Care {
  const latest = latestActions(all);
  const ok = latest.filter((a) => a.status === "done" || a.status === "approved");
  const sum = (k: ActionKind) => ok.filter((a) => a.kind === k).reduce((n, a) => n + a.quantity, 0);
  const budgets: Care["budgets"] = {};
  for (const [seat, limit] of Object.entries(BUDGET) as [SeatId, number][]) {
    // the delegated budget counts only what the seat ran on its own; what the human approved is the human's call
    budgets[seat] = { limit, spent: ok.filter((a) => a.requestedBy === seat && a.by === "delegated").reduce((n, a) => n + a.costAed, 0) };
  }
  return {
    hotelGuests: sum("hotel_block"),
    vouchers: sum("meal_vouchers"),
    crewRooms: sum("crew_rest") * 6,
    spentAed: ok.reduce((n, a) => n + a.costAed, 0),
    budgets,
    pending: latest.filter((a) => a.status === "pending"),
  };
}

export type RunnerResult = { ok: boolean; result?: { summary: string; checksum: string; rows: number; ready_at?: number }; ms?: number; image?: string; runtime?: string; limits?: string; error?: string };
export type Sandbox = (job: string, params: Record<string, string | number>) => Promise<RunnerResult>;

/** The runner over HTTP (production: an internal-only service that owns the Docker socket). */
export const httpSandbox =
  (url: string): Sandbox =>
  async (job, params) => {
    const r = await fetch(`${url}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job, params }), signal: AbortSignal.timeout(20_000) });
    return (await r.json()) as RunnerResult;
  };
