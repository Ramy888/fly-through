// "Fog at the hub": synthetic scenario inspired by a documented fog day at a Gulf hub.
// Fictional airline (flight prefix FT), invented flights, crews and guest counts.
import type { AirportId } from "../shared/geo.ts";
import type { Crew, Flight, Scenario, ScenarioEvent } from "../shared/types.ts";
import type { Cue } from "./orchestrator.ts";

const t = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// 16 inbound flights diverted as the fog closes the hub (06:00–06:44), as on the real day: DWC, SHJ, Al Ain, Bahrain.
const DIVERSIONS: [string, string, number, AirportId, string][] = [
  ["FT 402", "London", 298, "DWC", "06:00"],
  ["FT 212", "Mumbai", 276, "DWC", "06:04"],
  ["FT 918", "Manila", 312, "SHJ", "06:07"],
  ["FT 455", "Cairo", 184, "AAN", "06:10"],
  ["FT 064", "Frankfurt", 301, "DWC", "06:13"],
  ["FT 288", "Karachi", 174, "SHJ", "06:16"],
  ["FT 530", "Riyadh", 142, "BAH", "06:18"],
  ["FT 721", "Bangkok", 289, "DWC", "06:21"],
  ["FT 352", "Colombo", 168, "AAN", "06:24"],
  ["FT 610", "Nairobi", 196, "SHJ", "06:27"],
  ["FT 117", "Paris", 305, "DWC", "06:30"],
  ["FT 893", "Jakarta", 280, "BAH", "06:33"],
  ["FT 246", "Delhi", 270, "AAN", "06:36"],
  ["FT 377", "Istanbul", 188, "SHJ", "06:38"],
  ["FT 006", "New York", 326, "DWC", "06:41"],
  ["FT 559", "Muscat", 96, "BAH", "06:44"],
];

// Crew report times the evening before / overnight; a few are already close to their limit.
const REPORT: Record<string, [string, number]> = {
  "FT 402": ["-00:20", 2], // reported 23:40 the day before
  "FT 212": ["00:10", 2],
  "FT 918": ["-00:25", 2],
  "FT 455": ["-00:30", 2],
  "FT 064": ["00:05", 2],
  "FT 288": ["00:40", 2],
  "FT 530": ["02:10", 2],
  "FT 721": ["-03:23", 2], // C07: hits its limit at 07:37
  "FT 352": ["-00:05", 2],
  "FT 610": ["-02:45", 2],
  "FT 117": ["00:20", 2],
  "FT 893": ["-01:50", 2], // C12 at Bahrain: at risk, and no road for a standby crew
  "FT 246": ["00:15", 2],
  "FT 377": ["01:10", 2],
  "FT 006": ["-03:00", 2], // second-tightest: about 78 min left at 06:42
  "FT 559": ["03:40", 2],
};

const minutes = (s: string) => (s.startsWith("-") ? -t(s.slice(1)) : t(s));

const flights: Flight[] = DIVERSIONS.map(([id, from, pax, to, at], i) => ({
  id,
  from,
  pax,
  // C07 flies FT 721 (the crew the story is about); otherwise numbered in diversion order.
  crewId: id === "FT 721" ? "C07" : id === "FT 530" ? "C08" : `C${String(i + 1).padStart(2, "0")}`,
  scheduledArrival: t(at) + 5,
  divertTo: to,
  divertAt: t(at),
}));

const crews: Crew[] = [
  ...flights.map((f) => ({ id: f.crewId, report: minutes(REPORT[f.id][0]), sectors: REPORT[f.id][1], base: "HUB" as AirportId })),
  // Standby crews waiting at the hub crew centre.
  { id: "S1", report: t("05:00"), sectors: 2, base: "HUB", standby: true },
  { id: "S2", report: t("05:00"), sectors: 2, base: "HUB", standby: true },
  { id: "S3", report: t("05:30"), sectors: 2, base: "HUB", standby: true },
];

const events: ScenarioEvent[] = [
  { t: t("05:52"), kind: "fog", text: "Fog at the hub: visibility 150 m, arrivals stopped", visibilityM: 150 },
  ...flights.map((f) => ({ t: f.divertAt!, kind: "diversion" as const, flightId: f.id, text: `${f.id} from ${f.from} diverts to ${f.divertTo} (${f.pax} guests)` })),
  { t: t("06:50"), kind: "crew_call", text: "Crew calls spike: 9 crews calling the crew line" },
  { t: t("09:00"), kind: "fog_lifting", text: "Fog starting to lift at the hub" },
];

/** When seats are woken up, and what they are asked to look at. Their replies come from the model + tools. */
export const FOG_CUES: Cue[] = [
  { t: t("05:53"), seats: ["ops-duty-manager", "hub-control"], prompt: "Fog has just been reported at the hub. Assess the situation and call it out." },
  { t: t("06:08"), seats: ["network-control", "guest-recovery"], prompt: "Diversions are coming in. Report where the diverted flights are and what it means for guests." },
  { t: t("06:35"), seats: ["crew-control"], prompt: "Check crew duty time at the diversion airports. Flag any crew at risk of going out of hours and what cover exists." },
  { t: t("06:50"), seats: ["crew-hotline"], prompt: "Crews are calling the crew line from the diversion airports. Summarise what they report and pass anything urgent to Crew Control." },
  { t: t("06:56"), seats: ["ops-duty-manager"], prompt: "Pull the picture together: what are the main recovery options to put to the human approver?" },
];

export const FOG_AT_HUB: Scenario = {
  id: "fog-at-hub",
  title: "Fog at the hub",
  start: t("05:30"),
  end: t("14:00"),
  fogStart: t("05:52"),
  fogLifts: t("09:30"),
  flights,
  crews,
  events: events.sort((a, b) => a.t - b.t),
};
