import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Sim } from "./sim.ts";
import { FOG_AT_HUB, FOG_CUES } from "./scenario.ts";
import { chat, decide } from "./llm.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Recording } from "../shared/types.ts";

const app = Fastify({ logger: { level: "info" } });
const root = join(dirname(fileURLToPath(import.meta.url)), "../../dist/client");
// The latest live run is saved here and replayed in "recorded" mode. A curated run can be shipped in recordings/.
const RUNS = join(dirname(fileURLToPath(import.meta.url)), "../../runs");
const LIVE_RUN = join(RUNS, "last-live.json");
const SHIPPED_RUN = join(dirname(fileURLToPath(import.meta.url)), "../../recordings/fog-at-hub.json");
const store = {
  load: (): Recording | null => {
    for (const f of [LIVE_RUN, SHIPPED_RUN]) if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as Recording;
    return null;
  },
  save: (r: Recording) => {
    mkdirSync(RUNS, { recursive: true });
    writeFileSync(LIVE_RUN, JSON.stringify(r));
  },
};

const sim = new Sim(FOG_AT_HUB, FOG_CUES, {
  chat,
  model: process.env.AGENT_MODEL ?? "glm-5.3-flash",
  decide,
  decisionModel: process.env.DECISION_MODEL ?? "clef-flash",
  decisionAt: 6 * 60 + 58,
}, store);
// On the public deployment visitors start on the recorded run (no inference spend); "Use live AI" switches over.
if (process.env.DEFAULT_MODE === "recorded" && sim.setMode("recorded")) app.log.warn("no recording found; starting in live mode");

// Human-only approval: the browser gets an approver cookie; the agents run server-side and have no tool that can approve.
const APPROVER = randomBytes(24).toString("hex");
const hasApprover = (cookie?: string) => {
  const v = /(?:^|;\s*)approver=([a-f0-9]+)/.exec(cookie ?? "")?.[1] ?? "";
  return v.length === APPROVER.length && timingSafeEqual(Buffer.from(v), Buffer.from(APPROVER));
};

app.get("/api/health", async () => ({ ok: true, service: "fly-through", time: new Date().toISOString() }));

app.get("/api/scenario", async () => ({
  id: sim.scenario.id,
  title: sim.scenario.title,
  start: sim.scenario.start,
  end: sim.scenario.end,
  fogStart: sim.scenario.fogStart,
  fogLifts: sim.scenario.fogLifts,
  events: sim.scenario.events,
}));

// Server-sent events: one snapshot per sim tick.
app.get("/api/stream", (req, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const off = sim.subscribe((s) => reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`));
  req.raw.on("close", off);
});

type SimAction = { action: "start" | "pause" | "reset" | "seek" | "mode"; speed?: number; minute?: number; mode?: "live" | "recorded" };
app.post<{ Body: SimAction }>("/api/sim", async (req, reply) => {
  const { action, speed, minute } = req.body ?? ({} as SimAction);
  if (action === "start") sim.start(typeof speed === "number" && speed > 0 && speed <= 600 ? speed : undefined);
  else if (action === "pause") sim.pause();
  else if (action === "reset") sim.reset();
  else if (action === "seek" && typeof minute === "number") sim.seek(minute);
  else if (action === "mode" && (req.body.mode === "live" || req.body.mode === "recorded")) {
    const err = sim.setMode(req.body.mode);
    if (err) return reply.code(409).send({ error: err });
  }
  else return reply.code(400).send({ error: "unknown action" });
  return sim.snapshot();
});

// Every agent call-out, model score and human approval, with who did it (mirrors the agent/human split of Vultr Audit Logs).
app.get("/api/audit", async () => sim.audit);

app.get("/api/session", async (_req, reply) => {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header("Set-Cookie", `approver=${APPROVER}; HttpOnly; SameSite=Strict; Path=/api${secure}`);
  return { ok: true };
});

app.post<{ Body: { planId?: string } }>("/api/approve", async (req, reply) => {
  if (!hasApprover(req.headers.cookie)) return reply.code(403).send({ error: "only the human approver can approve a plan" });
  const id = req.body?.planId;
  if (id !== "A" && id !== "B" && id !== "C") return reply.code(400).send({ error: "planId must be A, B or C" });
  try {
    return sim.approve(id);
  } catch (e) {
    return reply.code(409).send({ error: (e as Error).message });
  }
});

if (process.env.NODE_ENV === "production") {
  await app.register(fastifyStatic, { root });
}

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
