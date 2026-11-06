import type { AirportId } from "./geo.ts";

/** Minutes since 00:00 on the scenario day (negative = the evening before). */
export type SimMinute = number;

export type Flight = {
  id: string; // e.g. "FT 214"
  from: string; // origin city (inbound to the hub)
  pax: number;
  crewId: string;
  scheduledArrival: SimMinute;
  divertTo?: AirportId; // set for flights the fog sends elsewhere
  divertAt?: SimMinute;
};

export type Crew = {
  id: string;
  report: SimMinute; // duty start
  sectors: number; // planned flights in this duty
  base: AirportId; // where the crew is now (standby crews sit at the hub)
  standby?: boolean;
};

export type ScenarioEvent = {
  t: SimMinute;
  kind: "fog" | "diversion" | "crew_call" | "fog_lifting" | "note";
  text: string;
  flightId?: string;
  visibilityM?: number;
};

export type Scenario = {
  id: string;
  title: string;
  start: SimMinute;
  end: SimMinute;
  fogStart: SimMinute;
  fogLifts: SimMinute; // forecast
  flights: Flight[];
  crews: Crew[];
  events: ScenarioEvent[];
};

export type CrewStatus = {
  id: string;
  at: AirportId;
  dutyLeftMin: number; // computed in code, never by a model
  dutyEnds: SimMinute;
  standby: boolean;
  state: "legal" | "caution" | "illegal" | "relieved";
};

export const SEATS = [
  { id: "ops-duty-manager", name: "Ops Duty Manager" },
  { id: "crew-control", name: "Crew Control" },
  { id: "network-control", name: "Network Control" },
  { id: "hub-control", name: "Hub Control" },
  { id: "guest-recovery", name: "Guest Recovery" },
  { id: "crew-hotline", name: "Crew Hotline" },
] as const;

export type SeatId = (typeof SEATS)[number]["id"];

export type WarMessage = {
  id: number;
  t: SimMinute;
  from: SeatId;
  to?: SeatId; // set when one seat hands work to another
  text: string;
  tools?: string[]; // tools the seat called to back this message (shown as evidence)
};

export type Plan = {
  id: "A" | "B" | "C";
  title: string;
  summary: string;
  actions: string[];
  buses?: { crew: string; replaces: string; to: AirportId; minutes: number }[];
  metrics: { guestsProtected: number; crewsKeptLegal: number; crewsTotal: number; avgDelayMin: number; costAed: number };
  probability?: number; // from the Vultr decision model
};

export type Decision = {
  status: "scoring" | "ready" | "error";
  at: SimMinute;
  plans: Plan[];
  model: string;
  confidence?: number;
  error?: string;
  approved?: { planId: Plan["id"]; at: SimMinute; by: "human" };
};

export type Recording = {
  scenarioId: string;
  recordedAt: string; // ISO time of the live run
  agentModel: string;
  decisionModel: string;
  messages: WarMessage[];
  decision?: { probabilities: Partial<Record<Plan["id"], number>>; confidence?: number };
};

export type AuditEntry = { t: SimMinute; actor: "agent" | "human" | "system"; who: string; action: string; detail?: string };

export type Snapshot = {
  mode: "live" | "recorded";
  scenarioId: string;
  now: SimMinute;
  speed: number;
  running: boolean;
  visibilityM: number;
  hubClosed: boolean;
  guestsStuck: number;
  diverted: { airport: AirportId; flights: string[]; pax: number }[];
  crews: CrewStatus[];
  events: ScenarioEvent[]; // events that have happened, oldest first
  messages: WarMessage[]; // latest war-room messages, oldest first
  thinking: SeatId[]; // seats currently calling the model
  decision?: Decision;
};
