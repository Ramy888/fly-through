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
  // Afternoon reserves, called in early when the morning goes wrong; on duty from 08:00.
  { id: "S4", report: t("08:00"), sectors: 2, base: "HUB", standby: true },
  { id: "S5", report: t("08:00"), sectors: 2, base: "HUB", standby: true },
  { id: "S6", report: t("08:00"), sectors: 2, base: "HUB", standby: true },
];

const events: ScenarioEvent[] = [
  { t: t("05:52"), kind: "fog", text: "Fog at the hub: visibility 150 m, arrivals stopped", visibilityM: 150 },
  ...flights.map((f) => ({ t: f.divertAt!, kind: "diversion" as const, flightId: f.id, text: `${f.id} from ${f.from} diverts to ${f.divertTo} (${f.pax} guests)` })),
  { t: t("06:50"), kind: "crew_call", text: "Crew calls spike: 9 crews calling the crew line" },
  { t: t("08:30"), kind: "forecast", text: "Met update: the fog now lifts at 10:45, not 09:30" },
  { t: t("10:15"), kind: "fog_lifting", text: "Fog starting to lift at the hub" },
  { t: t("10:45"), kind: "reopen", text: "Hub reopens: arrivals restart at 20 per hour" },
];

/** When seats are woken up, and what they are asked to look at. Their replies come from the model + tools. */
export const FOG_CUES: Cue[] = [
  { t: t("05:53"), seats: ["ops-duty-manager", "hub-control"], prompt: "Fog has just been reported at the hub. Assess the situation and call it out." },
  { t: t("06:08"), seats: ["network-control", "guest-recovery"], prompt: "Diversions are coming in. Report where the diverted flights are and what it means for guests." },
  { t: t("06:35"), seats: ["crew-control"], prompt: "Check crew duty time at the diversion airports. Flag any crew at risk of going out of hours and what cover exists." },
  { t: t("06:50"), seats: ["crew-hotline"], prompt: "Crews are calling the crew line from the diversion airports. Summarise what they report and pass anything urgent to Crew Control." },
  { t: t("06:56"), seats: ["ops-duty-manager"], prompt: "Pull the picture together: what are the main recovery options to put to the human approver?" },
  // After the decision: the seats carry the day through to the end of the recovery.
  { t: t("07:25"), seats: ["crew-hotline", "guest-recovery"], prompt: "The room is now carrying out the recovery. Crew Hotline: book rest for any crew that has timed out. Guest Recovery: guests have waited over an hour; book meal vouchers for the guests at each diversion airport, and hotel rooms for the airport with the most guests." },
  { t: t("08:15"), seats: ["crew-control"], prompt: "Check crew status at the diversion airports now: which crews are relieved, which have timed out, and who is legal to fly each aircraft home." },
  { t: t("08:31"), seats: ["hub-control", "crew-control"], prompt: "Met update: the fog now lifts at 10:45, not 09:30. Check what this changes for your area: which crews now time out before they can fly home. Crew Control: Bahrain has no road; check get_recovery and decide whether to position a fresh crew there now." },
  { t: t("10:20"), seats: ["hub-control", "network-control"], prompt: "The fog is lifting. Check the recovery plan with get_recovery and call out the first arrival slots and what the hub must be ready for." },
  { t: t("11:05"), seats: ["network-control"], prompt: "Arrivals have restarted. Report progress with get_recovery: landed, in the air, and any aircraft waiting for a fresh crew and why." },
  { t: t("11:30"), seats: ["guest-recovery", "crew-hotline"], prompt: "Report the guests still stuck and the crews still away from the hub, and what is being done for each." },
  { t: t("12:15"), seats: ["crew-control"], prompt: "Which aircraft still need a fresh crew, when does that crew get there, and is anyone at risk of going out of hours?" },
  { t: t("13:15"), seats: ["ops-duty-manager"], prompt: "The recovery is ending. Summarise for the human approver: aircraft home, guests still stuck, open issues, and one lesson for next time." },
];

export const FOG_AT_HUB: Scenario = {
  id: "fog-at-hub",
  title: "Fog at the hub",
  start: t("05:30"),
  end: t("15:00"),
  fogStart: t("05:52"),
  fogLifts: t("09:30"),
  forecastChange: { at: t("08:30"), fogLifts: t("10:45") }, // the fog lasts 75 min longer than forecast
  flights,
  crews,
  events: events.sort((a, b) => a.t - b.t),
};
