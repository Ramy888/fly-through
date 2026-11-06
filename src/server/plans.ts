// Recovery plans: the options and their impacts are computed in code; the decision model only weighs them.
// Cost figures are a SIMPLIFIED ILLUSTRATIVE model (AED), not airline data.
import type { AirportId } from "../shared/geo.ts";
import type { Plan, Scenario, Snapshot } from "../shared/types.ts";
import { assess } from "./criteria.ts";
import type { Relief } from "./recovery.ts";
import { busMinutes } from "./rules.ts";

const COST = { hotelMealPerGuest: 250, cancelPerFlight: 150_000, bus: 2_000, delayPerGuestHour: 100 };
const REOPEN_BUFFER = 60; // crews must still be legal 60 min after the fog lifts to fly back

// prior: what earlier approved decisions already set in motion (relief crews on their way, cancelled flights).
export type Ctx = { snap: Snapshot; scenario: Scenario; prior?: { relief: Relief[]; cancelled: string[] } };

/** Crews stuck at a diversion airport who will be out of hours before they can fly back, and not already covered. */
function crewsAtRisk({ snap, scenario, prior }: Ctx) {
  const flyBack = scenario.fogLifts + REOPEN_BUFFER;
  const covered = new Set(prior?.relief.map((r) => r.replaces));
  const cancelled = new Set(prior?.cancelled);
  return snap.crews
    .filter((c) => !c.standby && c.at !== "HUB" && c.dutyEnds < flyBack && !covered.has(c.id) && !cancelled.has(flightOfCrew(scenario, c.id).id))
    .sort((a, b) => a.dutyEnds - b.dutyEnds);
}

const flightOfCrew = (s: Scenario, crewId: string) => s.flights.find((f) => f.crewId === crewId)!;

export function buildPlans(ctx: Ctx): Plan[] {
  const { snap, scenario } = ctx;
  const atRisk = crewsAtRisk(ctx);
  const divertedPax = snap.diverted.reduce((n, d) => n + d.pax, 0);
  const waitHours = Math.max(0, (scenario.fogLifts + REOPEN_BUFFER - snap.now) / 60);
  const operating = snap.crews.filter((c) => !c.standby && c.at !== "HUB").length;

  // A: hold everything until the fog lifts. Flights whose crew times out are stuck until a fresh crew arrives (+3 h).
  const paxStrandedA = atRisk.reduce((n, c) => n + flightOfCrew(scenario, c.id).pax, 0);
  const planA: Plan = {
    id: "A",
    title: "Wait for the fog to lift",
    summary: `Hold all ${snap.diverted.reduce((n, d) => n + d.flights.length, 0)} diverted flights until the hub reopens around ${hm(scenario.fogLifts)}.`,
    actions: ["Hold diverted flights", "Guest care at diversion airports"],
    metrics: {
      guestsProtected: divertedPax - paxStrandedA,
      guestsLost: paxStrandedA,
      crewsKeptLegal: operating - atRisk.length,
      crewsTotal: operating,
      avgDelayMin: Math.round(waitHours * 60 + (paxStrandedA / Math.max(1, divertedPax)) * 180),
      costAed: Math.round(paxStrandedA * COST.hotelMealPerGuest + divertedPax * waitHours * COST.delayPerGuestHour),
    },
  };

  // B: bus standby crews from the hub to the airports where crews time out, if they arrive before those crews are needed.
  // standby crews at the hub, on duty now, and not already sent out under an earlier decision
  const sent = new Set(ctx.prior?.relief.map((r) => r.crew));
  const onDuty = (id: string) => scenario.crews.find((c) => c.id === id)!.report <= snap.now;
  const standby = snap.crews.filter((c) => c.standby && c.at === "HUB" && c.state === "legal" && !sent.has(c.id) && onDuty(c.id));
  const assignments: Plan["buses"] = [];
  for (const c of atRisk) {
    const s = standby[assignments.length];
    const mins = busMinutes("HUB", c.at as AirportId);
    if (!s || mins === null) continue; // no standby left, or no road (Bahrain)
    assignments.push({ crew: s.id, replaces: c.id, to: c.at as AirportId, minutes: mins });
  }
  const covered = new Set(assignments.map((a) => a.replaces));
  const paxStrandedB = atRisk.filter((c) => !covered.has(c.id)).reduce((n, c) => n + flightOfCrew(scenario, c.id).pax, 0);
  const planB: Plan = {
    id: "B",
    title: "Bus standby crews now",
    summary: assignments.length
      ? `Send ${assignments.length} standby crew${assignments.length > 1 ? "s" : ""} by road (${assignments.map((a) => `${a.crew}→${a.to} ${a.minutes} min`).join(", ")}) to relieve ${assignments.map((a) => a.replaces).join(", ")}.`
      : "No standby crew can reach the airports at risk in time.",
    actions: assignments.map((a) => `${a.crew} by bus to ${a.to} (${a.minutes} min), relieves ${a.replaces}`),
    buses: assignments,
    metrics: {
      guestsProtected: divertedPax - paxStrandedB,
      guestsLost: paxStrandedB,
      crewsKeptLegal: operating - atRisk.length + assignments.length,
      crewsTotal: operating,
      avgDelayMin: Math.round(waitHours * 60 + (paxStrandedB / Math.max(1, divertedPax)) * 180),
      costAed: Math.round(paxStrandedB * COST.hotelMealPerGuest + divertedPax * waitHours * COST.delayPerGuestHour + assignments.length * COST.bus),
    },
  };

  // C: cancel the flights whose crews time out (up to 4) and rebook their guests on later flights.
  const cancelled = atRisk.slice(0, 4).map((c) => flightOfCrew(scenario, c.id));
  const paxCancelled = cancelled.reduce((n, f) => n + f.pax, 0);
  const planC: Plan = {
    id: "C",
    title: `Cancel ${cancelled.length} flight${cancelled.length === 1 ? "" : "s"}`,
    summary: `Cancel ${cancelled.map((f) => f.id).join(", ")} and rebook ${paxCancelled} guests on later departures.`,
    actions: cancelled.map((f) => `Cancel ${f.id} (${f.pax} guests rebooked)`),
    cancelled: cancelled.map((f) => f.id),
    metrics: {
      guestsProtected: divertedPax - paxCancelled,
      guestsLost: paxCancelled,
      crewsKeptLegal: operating - Math.max(0, atRisk.length - cancelled.length),
      crewsTotal: operating,
      avgDelayMin: Math.round(waitHours * 60 + (paxCancelled / Math.max(1, divertedPax)) * 600),
      costAed: Math.round(cancelled.length * COST.cancelPerFlight + paxCancelled * COST.hotelMealPerGuest + divertedPax * waitHours * COST.delayPerGuestHour),
    },
  };

  return assess([planA, planB, planC], ctx); // safety gate and per-criterion facts
}

/** The text the decision model reads: computed facts, each plan's computed impact, and the seats' latest messages. */
export function decisionState(ctx: Ctx, plans: Plan[]): string {
  const { snap, scenario } = ctx;
  const atRisk = crewsAtRisk(ctx).map((c) => `${c.id} at ${c.at} (out of hours at ${hm(c.dutyEnds)})`);
  const lines = [
    `Time ${hm(snap.now)}. Fog at the hub, visibility ${snap.visibilityM} m, forecast to lift at ${hm(scenario.fogLifts)}.`,
    `${snap.diverted.reduce((n, d) => n + d.flights.length, 0)} flights diverted (${snap.diverted.map((d) => `${d.flights.length} at ${d.airport}`).join(", ")}), ${snap.guestsStuck} guests stuck.`,
    `Crews that will be out of hours before they can fly back: ${atRisk.join("; ") || "none"}.`,
    ...plans.map(
      (p) =>
        `Plan ${p.id}: ${p.title}. ${p.summary} Guests protected ${p.metrics.guestsProtected}, crews kept legal ${p.metrics.crewsKeptLegal}/${p.metrics.crewsTotal}, average delay ${p.metrics.avgDelayMin} min, cost AED ${p.metrics.costAed}.`,
    ),
    "Ops-room messages:",
    ...snap.messages.slice(-8).map((m) => `- ${m.from}${m.to ? ` to ${m.to}` : ""}: ${m.text}`),
  ];
  return lines.join("\n");
}

export const PLAN_QUESTION = "Which recovery plan keeps every crew legal and protects the most guests at a reasonable cost?";
export const planOption = (p: Plan) => `${p.id}: ${p.title}`;

function hm(m: number) {
  const d = ((Math.floor(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
}
