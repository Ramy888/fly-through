// Seat agents: one role prompt per ops-room seat plus tools that read facts computed in code.
import { AIRPORTS, type AirportId } from "../shared/geo.ts";
import { SEATS, type SeatId, type Snapshot } from "../shared/types.ts";
import type { ToolSpec } from "./llm.ts";
import { busMinutes } from "./rules.ts";

const hhmm = (m: number) => {
  const d = ((Math.floor(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
};

export const COMMON_PROMPT = `You are an AI agent sitting in one seat of a fictional Gulf hub airline's operations-control room during a disruption.
Rules:
- Reply in at most 2 short sentences and 35 words, like a real ops-room call-out. No markdown, no lists.
- Every number you state (minutes, crews, guests, times) must come from a tool result or the facts given to you. Never invent numbers.
- Use send_message at most once per turn, only to hand a specific task to the seat that owns it.
- You never approve, dispatch, activate or execute anything, and never say you did. You propose; only the human approver decides.`;

export const ROLES: Record<SeatId, string> = {
  "ops-duty-manager": "You are the Ops Duty Manager. You own the overall picture and the decision process: set priorities, ask seats for inputs, and frame recovery options for the human approver.",
  "crew-control": "You are Crew Control. You own crew legality: duty time left, which crews will go out of hours, and which standby crews can cover. Flag any crew under 90 minutes.",
  "network-control": "You are Network Control. You own the flights and aircraft: diversions, which airport each diverted flight is at, and how to bring aircraft back to the hub when it reopens.",
  "hub-control": "You are Hub Control. You own the hub airport on the ground: arrivals and departures status in fog, gates, stands and turnaround once it reopens.",
  "guest-recovery": "You are Guest Recovery. You own guests: how many are stuck, rebooking, meals and hotels, and communication to them.",
  "crew-hotline": "You are the Crew Hotline. You take calls from crews stuck at diversion airports and pass their location and status to Crew Control.",
};

export const SEAT_NAME = Object.fromEntries(SEATS.map((s) => [s.id, s.name])) as Record<SeatId, string>;
const SEAT_IDS = SEATS.map((s) => s.id);
const AIRPORT_IDS = Object.keys(AIRPORTS) as AirportId[];

export const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "get_situation",
      description: "Current hub status: time, visibility, whether the hub is closed, fog forecast, diverted flights per airport and guests stuck.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_crew_status",
      description: "Duty time left for crews (computed by the duty-rules engine). Optionally filter by airport. Sorted tightest first.",
      parameters: { type: "object", properties: { airport: { type: "string", enum: AIRPORT_IDS } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_time",
      description: "Minutes to move a crew by road between two airports (null = no road, needs a positioning flight).",
      parameters: {
        type: "object",
        properties: { from: { type: "string", enum: AIRPORT_IDS }, to: { type: "string", enum: AIRPORT_IDS } },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recovery",
      description: "The reopening wave (computed in code): hub arrival rate, aircraft landed and in the air, the next landings with the crew flying each one, and aircraft still waiting for a fresh crew.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Hand a task or question to another seat in the ops room.",
      parameters: {
        type: "object",
        properties: { to: { type: "string", enum: SEAT_IDS }, text: { type: "string", description: "One short sentence." } },
        required: ["to", "text"],
      },
    },
  },
];

// Debate at a decision point: seats check facts, then state a position. No handoffs while the room is debating.
export const DEBATE_TOOLS: ToolSpec[] = [
  ...TOOLS.filter((t) => t.function.name !== "send_message"),
  {
    type: "function",
    function: {
      name: "take_position",
      description: "State which plan the room should recommend to the human approver, and why. Call exactly once.",
      parameters: {
        type: "object",
        properties: { plan: { type: "string", enum: ["A", "B", "C"] }, reason: { type: "string", description: "At most 25 words, from your seat's point of view." } },
        required: ["plan", "reason"],
      },
    },
  },
];

// What each seat weighs first in a debate: each owns one of the criteria the AI check scores, so the room argues from
// real, different concerns. Safety is a gate every plan must pass, not something to maximise by flying less.
export const DEBATE_LENS: Record<SeatId, string> = {
  "ops-duty-manager": "cost and environment, and the balance across all criteria",
  "crew-control": "the safety gate: crew legality and fatigue (a plan that passes the gate is safe enough; do not prefer a plan just because it flies less)",
  "network-control": "punctuality and the schedule: delays, the last aircraft home, and aircraft back for the afternoon",
  "hub-control": "security and ground operations: crowds stranded at outstation terminals, buses on fogbound roads",
  "guest-recovery": "passengers: guests who lose their journey and the welfare care they are owed",
  "crew-hotline": "the crews away from base: their rest, hotels and what they are being asked to do",
};

export function debatePrompt(seat: SeatId, round: number, plans: string, positions: string): string {
  const lens = `Argue from your seat's main concern, ${DEBATE_LENS[seat]}. Do not just agree with others: if you back the popular plan, name a risk it carries.`;
  return round === 1
    ? `DECISION POINT, debate round 1. The sim is paused for the human approver. The plans, with impacts computed in code:\n${plans}\n${lens} Check a fact with a tool if you need one, then call take_position once.`
    : `DECISION POINT, debate round 2. The plans:\n${plans}\nPositions from round 1:\n${positions}\n${lens} Answer the strongest argument against your view and name the seat that made it. Keep or change your plan, then call take_position once.`;
}

/** Run a read-only tool against the current snapshot. send_message is handled by the orchestrator. */
export function runTool(name: string, args: Record<string, unknown>, snap: Snapshot, fogLifts: number): unknown {
  switch (name) {
    case "get_situation":
      return {
        time: hhmm(snap.now),
        visibilityM: snap.visibilityM,
        hubClosed: snap.hubClosed,
        fogForecastToLift: hhmm(fogLifts),
        diverted: snap.diverted.map((d) => ({ airport: d.airport, flights: d.flights.length, guests: d.pax })),
        guestsStuck: snap.guestsStuck,
      };
    case "get_crew_status": {
      const at = args.airport as AirportId | undefined;
      const row = (c: (typeof snap.crews)[number]) => ({ crew: c.id, at: c.at, dutyLeftMin: Math.max(0, Math.round(c.dutyLeftMin)), dutyEnds: hhmm(c.dutyEnds), state: c.state });
      const inAirport = snap.crews.filter((c) => !at || c.at === at);
      return {
        // Operating crews, tightest first (only the 8 tightest, to keep the model's context small).
        operating: inAirport.filter((c) => !c.standby).sort((a, b) => a.dutyLeftMin - b.dutyLeftMin).slice(0, 8).map(row),
        // Standby crews are always listed in full so no seat concludes there is no cover.
        standby: snap.crews.filter((c) => c.standby).map(row),
      };
    }
    case "get_recovery": {
      const r = snap.recovery;
      if (!r) return { error: "no recovery plan yet" };
      const row = (x: (typeof r.schedule)[number]) => ({ flight: x.flight, from: x.from, crew: x.crew, departs: hhmm(x.depart), lands: hhmm(x.land) });
      return {
        hubArrivalsPerHour: 20,
        landed: r.landed,
        total: r.total,
        inTheAir: r.schedule.filter((x) => x.depart <= snap.now && snap.now < x.land).map(row),
        nextLandings: r.schedule.filter((x) => x.depart > snap.now).slice(0, 5).map(row),
        waitingForFreshCrew: r.schedule.filter((x) => x.crew === "fresh crew" && x.land > snap.now).map(row),
        guestsStuck: snap.guestsStuck,
      };
    }
    case "get_bus_time": {
      const from = args.from as AirportId;
      const to = args.to as AirportId;
      if (!AIRPORTS[from] || !AIRPORTS[to]) return { error: "unknown airport" };
      return { from, to, minutes: busMinutes(from, to) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
