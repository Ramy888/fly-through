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

/**
 * Hub arrival slots from `reopen`, one every SLOT_MIN. Each diverted flight flies home with its original crew if that crew
 * can land before its duty ends; else with the standby bussed out under the approved plan; else with a fresh crew sent
 * after reopening. Cancelled flights (plan C) stay where they are.
 */
export function returnSchedule(s: Scenario, reopen: number, plan?: Pick<Plan, "buses" | "cancelled">, approvedAt?: number): Return[] {
  const cancelled = new Set(plan?.cancelled ?? []);
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
    const relief = plan?.buses?.find((b) => b.replaces === f.crewId);
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
      const ready = relief && approvedAt !== undefined ? approvedAt + relief.minutes : freshCrewAt(from, reopen);
      return { land: nextSlot(Math.max(earliest, ready + fly)), crew: relief && approvedAt !== undefined ? relief.crew : "fresh crew" };
    }
  }
  return out.sort((a, b) => a.land - b.land);
}
