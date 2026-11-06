// Reopening wave: when the fog lifts, diverted aircraft fly home in hub arrival slots.
// Computed in code from the scenario and the approved plan; agents read it through a tool.
// Simplified illustrative model: fixed slot rate and flight times, not airline or ATC data.
import type { AirportId } from "../shared/geo.ts";
import type { Plan, ReturnFlight, Scenario } from "../shared/types.ts";
import { busMinutes, crewStatus } from "./rules.ts";

export const SLOT_MIN = 3; // hub arrival rate after reopening: one every 3 min (20 per hour)
export const FLY_MIN: Record<AirportId, number> = { HUB: 0, DWC: 30, SHJ: 35, AAN: 25, BAH: 75 };
const TURNAROUND = 30; // a fresh crew flown out to Bahrain leaves on the first hub departure after reopening
const RELEASE_BEFORE = 30; // diverted flights may take off at most 30 min before the hub reopens

export type Return = ReturnFlight; // crew: the original, a bussed standby, or "fresh crew"

/** When a fresh crew from the hub can be at the airport once the hub reopens. */
function freshCrewAt(airport: AirportId, reopen: number): number {
  const road = busMinutes("HUB", airport);
  return road === null ? reopen + TURNAROUND + FLY_MIN[airport] : reopen + road;
}

/** A standby crew sent to relieve another, and when it can be at the aircraft. */
export type Relief = { crew: string; replaces: string; readyAt: number };
export const reliefOf = (plan: Pick<Plan, "buses"> | undefined, approvedAt: number): Relief[] =>
  (plan?.buses ?? []).map((b) => ({ crew: b.crew, replaces: b.replaces, readyAt: approvedAt + b.minutes }));

/**
 * Hub arrival slots from `reopen`, one every SLOT_MIN. Each diverted flight flies home with its original crew if that crew
 * can land before its duty ends; else with a standby sent to relieve it (from any approved plan); else with a fresh crew sent
 * after reopening. Cancelled flights stay where they are.
 */
export function returnSchedule(s: Scenario, reopen: number, opts: { relief?: Relief[]; cancelled?: string[] } = {}): Return[] {
  const cancelled = new Set(opts.cancelled ?? []);
  const diverted = s.flights.filter((f) => f.divertTo && !cancelled.has(f.id));
  const taken = new Set<number>();
  const nextSlot = (earliest: number) => {
    let t = reopen + Math.max(0, Math.ceil((earliest - reopen) / SLOT_MIN)) * SLOT_MIN;
    while (taken.has(t)) t += SLOT_MIN;
    taken.add(t);
    return t;
  };
  const dutyEnds = (crewId: string) => {
    const c = s.crews.find((x) => x.id === crewId)!;
    return crewStatus(c, 0).dutyEnds;
  };
  // Crews closest to their limit get the first slots, so as many as possible fly their own aircraft home.
  const order = [...diverted].sort((a, b) => dutyEnds(a.crewId) - dutyEnds(b.crewId) || b.pax - a.pax);
  const out: Return[] = [];
  for (const f of order) {
    const from = f.divertTo!;
    const fly = FLY_MIN[from];
    const own = dutyEnds(f.crewId);
    const relief = opts.relief?.find((r) => r.replaces === f.crewId);
    let land: number;
    let crew: string;
    const earliest = Math.max(reopen, reopen - RELEASE_BEFORE + fly);
    if (own >= earliest) {
      // try the original crew first; give the slot back if it would land after its duty ends
      land = nextSlot(earliest);
      if (land <= own) crew = f.crewId;
      else {
        taken.delete(land);
        ({ land, crew } = substitute());
      }
    } else ({ land, crew } = substitute());
    out.push({ flight: f.id, from, pax: f.pax, crew, depart: land - fly, land });

    function substitute() {
      const ready = relief ? relief.readyAt : freshCrewAt(from, reopen);
      return { land: nextSlot(Math.max(earliest, ready + fly)), crew: relief ? relief.crew : "fresh crew" };
    }
  }
  return out.sort((a, b) => a.land - b.land);
}
