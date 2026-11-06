// Hard operational numbers, computed in code so no model can soften them.
// The duty table is a SIMPLIFIED ILLUSTRATIVE rule set for the demo, not a regulatory FTL scheme.
import { AIRPORTS, type AirportId } from "../shared/geo.ts";
import type { Crew, CrewStatus, Scenario, SimMinute, Snapshot } from "../shared/types.ts";

const DAY = 24 * 60;
const CAUTION_MIN = 90;

/** Max flight-duty period in minutes, by local report time, minus 30 min per sector beyond two. */
export function maxDutyMin(report: SimMinute, sectors: number): number {
  const hhmm = ((report % DAY) + DAY) % DAY;
  const base = hhmm >= 6 * 60 && hhmm < 13 * 60 + 30 ? 13 * 60 : hhmm >= 13 * 60 + 30 && hhmm < 17 * 60 + 30 ? 12 * 60 : 11 * 60;
  return base - Math.max(0, sectors - 2) * 30;
}

export function crewStatus(crew: Crew, now: SimMinute): CrewStatus {
  const dutyEnds = crew.report + maxDutyMin(crew.report, crew.sectors);
  const dutyLeftMin = dutyEnds - now;
  return {
    id: crew.id,
    at: crew.base,
    dutyEnds,
    dutyLeftMin,
    standby: !!crew.standby,
    state: dutyLeftMin <= 0 ? "illegal" : dutyLeftMin <= CAUTION_MIN ? "caution" : "legal",
  };
}

function haversineKm([lng1, lat1]: readonly [number, number], [lng2, lat2]: readonly [number, number]): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Bus time between two airports: road ≈ 1.25 × straight line at 90 km/h, plus 15 min to board.
 *  Returns null when there is no road (Bahrain): that crew needs a positioning flight. */
export function busMinutes(from: AirportId, to: AirportId): number | null {
  if (from === to) return 0;
  if (from === "BAH" || to === "BAH") return null;
  const km = haversineKm(AIRPORTS[from].pos, AIRPORTS[to].pos) * 1.25;
  return Math.round((km / 90) * 60 + 15);
}

/** Visibility at the hub: 6 km before the fog, 150 m in it, recovering linearly over the last 30 min. */
export function visibilityM(s: Scenario, now: SimMinute): number {
  if (now < s.fogStart) return 6000;
  if (now >= s.fogLifts) return 6000;
  const lifting = s.fogLifts - 30;
  if (now < lifting) return 150;
  return Math.round(150 + ((now - lifting) / 30) * (6000 - 150));
}

/** Build the full state at a moment in time. Pure: same scenario + minute → same snapshot. */
export function snapshotAt(s: Scenario, now: SimMinute, speed = 1, running = false): Snapshot {
  const vis = visibilityM(s, now);
  const hubClosed = vis < 550; // below CAT I minima in this simplified model
  const divertedFlights = s.flights.filter((f) => f.divertTo && f.divertAt !== undefined && f.divertAt <= now && now < s.fogLifts + 60);
  const byAirport = new Map<AirportId, Snapshot["diverted"][number]>();
  for (const f of divertedFlights) {
    const e = byAirport.get(f.divertTo!) ?? { airport: f.divertTo!, flights: [], pax: 0 };
    e.flights.push(f.id);
    e.pax += f.pax;
    byAirport.set(f.divertTo!, e);
  }
  // Guests stuck: everyone on a diverted flight, plus guests booked on hub departures held by the closure.
  const heldDepartures = hubClosed ? Math.floor((now - s.fogStart) / 10) * 180 : 0;
  const guestsStuck = divertedFlights.reduce((n, f) => n + f.pax, 0) + Math.max(0, heldDepartures);

  const crews = s.crews.map((c) => {
    const flight = divertedFlights.find((f) => f.crewId === c.id);
    return crewStatus(flight ? { ...c, base: flight.divertTo! } : c, now);
  });

  return {
    mode: "live",
    scenarioId: s.id,
    now,
    speed,
    running,
    visibilityM: vis,
    hubClosed,
    guestsStuck,
    diverted: [...byAirport.values()],
    crews,
    events: s.events.filter((e) => e.t <= now),
    messages: [],
    thinking: [],
  };
}
