// How the AI check weighs recovery plans, modelled on how airline operations-control centres decide:
// 1. Flight safety and crew legality are a GATE, checked in code. Every plan that passes is safe enough; a plan is never
//    "safer" just because it flies less. Remaining risks are shown to the human as warnings.
// 2. Plans that pass are scored on six criteria from a study of OCC experts (IHSSR 8(2), 2024: safety 35.5%, security 25.6%,
//    passenger satisfaction 16.6%, punctuality 11.7%, environment 6.4%, cost 3.8%, schedule 1.9%). Safety becomes the gate,
//    so the other six weights are rescaled to sum to 1. The decision model scores each criterion from facts computed here.
// Every number below is a SIMPLIFIED ILLUSTRATIVE model, not airline, ATC or regulatory data.
import type { Criterion, Plan, Scenario, Snapshot, Verdict } from "../shared/types.ts";
import { returnSchedule } from "./recovery.ts";
import { crewStatus } from "./rules.ts";

const STUDY: Record<Criterion, number> = { security: 0.256, passengers: 0.166, punctuality: 0.117, environment: 0.064, cost: 0.038, schedule: 0.019 };
const SUM = Object.values(STUDY).reduce((a, b) => a + b, 0);
export const WEIGHTS = Object.fromEntries(Object.entries(STUDY).map(([k, w]) => [k, w / SUM])) as Record<Criterion, number>;

export const CRITERIA: { id: Criterion; label: string; question: string }[] = [
  { id: "security", label: "Security", question: "Which plan carries the least security risk from crowds of guests stranded for long hours at outstation terminals?" },
  { id: "passengers", label: "Passengers", question: "Which plan harms passengers least: the fewest guests who lose their journey or are stranded overnight?" },
  { id: "punctuality", label: "Punctuality", question: "Which plan has the shortest delays and gets the last aircraft home soonest?" },
  { id: "environment", label: "Environment", question: "Which plan adds the least extra CO2 from empty ferry flights, positioning and road moves?" },
  { id: "cost", label: "Cost", question: "Which plan costs the airline the least money?" },
  { id: "schedule", label: "Schedule", question: "Which plan returns the most aircraft and crews in time for the afternoon schedule?" },
];

const AFTERNOON_BANK = 12 * 60; // aircraft home by 12:00 make the afternoon departures
const CO2_FERRY_T = 4.5; // an empty ferry flight home for a cancelled aircraft (illustrative, ~35 min narrowbody/widebody mix)
const CO2_BUS_T = 0.2; // one crew bus trip
const LONG_WAIT_MIN = 6 * 60; // GCAA care: hotel for guests stuck this long, or whose flight is cancelled
const REBOOK_AFTER_MIN = 4 * 60; // cancelled flights' guests leave on later departures about 4 h after reopening

type Ctx = { snap: Snapshot; scenario: Scenario };

/** Facts per criterion and the safety gate, computed in code from each plan's own trip-home schedule. */
export function assess(plans: Plan[], { snap, scenario }: Ctx): Plan[] {
  return plans.map((p) => {
    const schedule = returnSchedule(scenario, scenario.fogLifts, p, snap.now);
    const cancelled = new Set(p.cancelled ?? []);
    const diverted = scenario.flights.filter((f) => f.divertTo);
    const leaves = (id: string) => (cancelled.has(id) ? scenario.fogLifts + REBOOK_AFTER_MIN : schedule.find((r) => r.flight === id)!.depart);
    const waits = diverted.map((f) => ({ pax: f.pax, min: leaves(f.id) - f.divertAt! }));
    const guestHours = Math.round(waits.reduce((n, w) => n + (w.pax * w.min) / 60, 0));
    const longestH = Math.max(...waits.map((w) => w.min)) / 60;
    const hotelGuests = diverted.filter((f, i) => cancelled.has(f.id) || waits[i].min >= LONG_WAIT_MIN).reduce((n, f) => n + f.pax, 0);
    const lastHome = schedule.length ? Math.max(...schedule.map((r) => r.land)) : scenario.fogLifts;
    const homeByBank = schedule.filter((r) => r.land <= AFTERNOON_BANK).length;
    const roadTrips = (p.buses?.length ?? 0) + schedule.filter((r) => r.crew === "fresh crew" && r.from !== "BAH").length;
    const co2 = cancelled.size * CO2_FERRY_T + roadTrips * CO2_BUS_T;

    // Gate: every crew that flies an aircraft home is inside its duty limit when it lands (original, bussed standby or fresh).
    const legal = schedule.every((r) => {
      if (r.crew === "fresh crew") return true;
      const c = scenario.crews.find((x) => x.id === r.crew);
      return !!c && r.land <= crewStatus(c, 0).dutyEnds;
    });
    const timedOut = p.metrics.crewsTotal - p.metrics.crewsKeptLegal;
    const warning =
      (p.buses?.length ? `Buses drive out through fog (visibility ${snap.visibilityM} m): convoy, low speed, stand down if it thickens.` : "") +
      (timedOut ? ` ${timedOut} crew${timedOut > 1 ? "s" : ""} time out away from base: any request to extend duty must be refused.` : "");

    return {
      ...p,
      gate: { passes: legal, warning: warning.trim() || undefined },
      harm: {
        security: guestHours,
        passengers: p.metrics.guestsLost ?? 0,
        punctuality: p.metrics.avgDelayMin,
        environment: co2,
        cost: p.metrics.costAed,
        schedule: diverted.length - homeByBank,
      },
      criteria: {
        security: `${guestHours.toLocaleString("en-US")} guest-hours waiting at outstation terminals; longest wait ${longestH.toFixed(1)} h.`,
        passengers: `Harm: ${(p.metrics.guestsLost ?? 0).toLocaleString("en-US")} guests lose their journey${hotelGuests ? `, ${hotelGuests.toLocaleString("en-US")} of them stranded until a later flight (hotel owed under GCAA care rules)` : ""}.`,
        punctuality: `Average delay ${p.metrics.avgDelayMin} min; last aircraft home ${hm(lastHome)}${cancelled.size ? ` (${cancelled.size} cancelled)` : ""}.`,
        environment: `${co2.toFixed(1)} t extra CO2 (${cancelled.size} empty ferry flights, ${roadTrips} crew bus trips).`,
        cost: `AED ${(p.metrics.costAed / 1e6).toFixed(2)} million.`,
        schedule: `${homeByBank} of ${diverted.length} aircraft home by ${hm(AFTERNOON_BANK)} for the afternoon schedule.`,
      },
    };
  });
}

/** One decision-model call: one question per criterion, each option described by its computed facts. */
export function criteriaQuestions(plans: Plan[], option: (p: Plan) => string) {
  return Object.fromEntries(
    CRITERIA.map((c) => [c.id, { question: c.question, options: Object.fromEntries(plans.map((p) => [option(p), p.criteria?.[c.id] ?? null])) }]),
  );
}

const FACTS_SHARE = 0.5; // each criterion's score: half from the computed numbers, half from the model's judgement

/** Scores from the numbers alone: the least harm gets the most, shares sum to 1 (equal when the plans tie). */
export function factScores(plans: Plan[]): Record<Criterion, Partial<Record<Plan["id"], number>>> {
  return Object.fromEntries(
    CRITERIA.map((c) => {
      const harm = plans.map((p) => p.harm?.[c.id] ?? 0);
      const max = Math.max(...harm);
      const room = harm.map((h) => max - h + (max === Math.min(...harm) ? 1 : max * 0.05)); // small floor so the worst isn't zero
      const sum = room.reduce((a, b) => a + b, 0);
      return [c.id, Object.fromEntries(plans.map((p, i) => [p.id, room[i] / sum]))];
    }),
  ) as Record<Criterion, Partial<Record<Plan["id"], number>>>;
}

/** Blend facts and model per criterion, and flag criteria where the model's favourite contradicts the numbers. */
export function blend(plans: Plan[], model: Verdict["scores"]): Pick<Verdict, "scores" | "facts" | "model" | "disagree"> {
  const facts = factScores(plans);
  const top = (s: Partial<Record<Plan["id"], number>>) => plans.reduce((a, b) => ((s[b.id] ?? 0) > (s[a.id] ?? 0) ? b : a)).id;
  const scores = Object.fromEntries(
    CRITERIA.map((c) => [c.id, Object.fromEntries(plans.map((p) => [p.id, FACTS_SHARE * (facts[c.id][p.id] ?? 0) + (1 - FACTS_SHARE) * (model[c.id]?.[p.id] ?? 0)]))]),
  ) as Verdict["scores"];
  // Flag only when the model's favourite is not one of the least-harm plans (ties on the numbers are not disagreements).
  const disagree = CRITERIA.filter((c) => {
    const harm = (id: Plan["id"]) => plans.find((p) => p.id === id)!.harm?.[c.id] ?? 0;
    return harm(top(model[c.id] ?? {})) > Math.min(...plans.map((p) => harm(p.id)));
  }).map((c) => c.id);
  return { scores, facts, model, disagree };
}

/** Gate first, then the weighted sum of the criterion scores; explains which plan led which criterion. */
export function weightedVerdict(plans: Plan[], scores: Verdict["scores"]): Pick<Verdict, "gate" | "weights" | "totals" | "pick" | "reason"> {
  const gate = Object.fromEntries(plans.map((p) => [p.id, { passes: p.gate?.passes !== false, warning: p.gate?.warning }])) as Verdict["gate"];
  const passing = plans.filter((p) => gate[p.id]!.passes);
  const totals = Object.fromEntries(
    plans.map((p) => [p.id, gate[p.id]!.passes ? CRITERIA.reduce((n, c) => n + WEIGHTS[c.id] * (scores[c.id]?.[p.id] ?? 0), 0) : 0]),
  ) as Verdict["totals"];
  const pick = (passing.length ? passing : plans).reduce((a, b) => ((totals[b.id] ?? 0) > (totals[a.id] ?? 0) ? b : a)).id;
  const leads = CRITERIA.filter((c) => {
    const s = scores[c.id] ?? {};
    return passing.every((p) => (s[pick] ?? 0) >= (s[p.id] ?? 0));
  }).map((c) => c.label.toLowerCase());
  const failed = plans.filter((p) => !gate[p.id]!.passes).map((p) => p.id);
  const gateText = failed.length ? `Plan ${failed.join(", ")} fails the safety gate.` : `All ${plans.length} plans pass the safety gate.`;
  const ranked = [...passing].sort((a, b) => (totals[b.id] ?? 0) - (totals[a.id] ?? 0)).map((p) => `${p.id} ${Math.round((totals[p.id] ?? 0) * 100)}`);
  const reason = `${gateText} Weighted score: ${ranked.join(", ")}. ${pick} leads on ${leads.length ? leads.join(", ") : "the weighted total"}.`;
  return { gate, weights: WEIGHTS, totals, pick, reason };
}

function hm(m: number) {
  const d = ((Math.floor(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
}
