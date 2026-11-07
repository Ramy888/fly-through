// Records the Fly-Through demo in headless Chrome (no Claude overlay, a drawn pointer), replaying the shipped live run.
// Needs the API on :8080 and Vite on :5173. Run: node scripts/demo-video/record.mjs, then inside scripts/demo-video/out:
// ffmpeg -f concat -safe 0 -i list.txt -vf "scale=1920:1080,format=yuv420p" -r 30 -c:v libx264 -crf 18 fly-through-silent.mp4
import { launch, sleep } from "./cdp.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = "http://localhost:5173/";
const API = "http://localhost:8080";
const DIR = fileURLToPath(new URL("./out/", import.meta.url)); // a URL pathname keeps %20 for spaces
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR + "frames", { recursive: true });

const sim = (body) => fetch(API + "/api/sim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const state = async () => {
  const r = await fetch(API + "/api/stream");
  const reader = r.body.getReader();
  let text = "";
  while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.split("data: ")[1].split("\n")[0]);
};
const until = async (test, ms = 60_000) => {
  for (let t = 0; t < ms; t += 400) {
    if (test(await state())) return;
    await sleep(400);
  }
  throw new Error("timed out waiting");
};

await sim({ action: "mode", mode: "recorded" });
const b = await launch({ width: 1600, height: 900, scale: 1.2, port: 9371 });
const cues = [];
const cue = (text) => {
  cues.push({ at: b.mark(), text });
  console.log(b.mark().toFixed(1), text);
};
const hover = (x, y) => b.moveTo({ x, y });
const rect = async (sel) => b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const q=e.getBoundingClientRect();return {x:q.x+q.width/2,y:q.y+q.height/2}})()`);
// jumps in sim time happen off camera: the cut lands on the new moment
const jump = async (minute) => {
  b.pause();
  await sim({ action: "seek", minute });
  await sleep(1500);
  await b.resume();
};

// the pointer shows on the 120× button; the clock itself is started through the API so a missed click can't stall the take
const play = async () => {
  const p = await rect(".controls button:nth-child(4)");
  if (p) await b.moveTo(p);
  await sim({ action: "start", speed: 120 });
  await sleep(300);
};

await b.goto(APP, 7000);
await b.startRec();

// 1. The room before the fog
cue("intro");
await hover(800, 420);
await sleep(4500);

// 2. Fog closes the hub, diversions start
await play();
cue("fog");
await until((s) => s.now >= 6 * 60 + 12);
await hover(900, 470);
await sleep(1500);
await b.click("Pause");

// 3. Each seat has its own thread
cue("seats");
const back = await rect(".chat-back");
if (back) await b.clickAt(back);
await sleep(900);
await b.click("Crew Control");
await sleep(4000);
await b.clickAt(await rect(".chat-back"));
await sleep(700);
await b.click("All seats");
await sleep(1200);

// 4. First decision: the seats debate
await jump(6 * 60 + 52);
await play();
await until((s) => s.decision?.status === "debating");
cue("debate1");
await until((s) => s.decision?.status === "ready", 90_000);

// 5. The AI check: safety gate, then six weighted criteria
cue("check1");
await hover(1380, 300);
await b.wheel(500, { x: 1380, y: 400 });
await sleep(5500);

// 6. Only the human approves
cue("approve1");
await b.evaluate("document.querySelector('.plans .approve-btn')?.scrollIntoView({ block: 'center' })"); // a stale position would click the timeline
await sleep(400);
await b.click("Review & approve plan", { expect: "Approve plan" });
await sleep(1500);
await b.click("Approve plan B", { gone: true });
await sleep(2500);

// 7. The seats act: delegated jobs run in the sandbox; an over-budget request becomes a card for the human
await jump(7 * 60 + 20);
await sim({ action: "start", speed: 60 });
cue("act");
await until((s) => (s.care?.pending.length ?? 0) > 0, 30_000).catch(() => console.log("no card in this stretch"));
await sim({ action: "pause" });
await b.evaluate("document.querySelector('.plans')?.scrollTo({ top: 0, behavior: 'smooth' })");
await sleep(600);
const card = await rect(".action-card");
if (card) await hover(card.x, card.y);
await sleep(5500);
const chip = await rect(".action-chip.done");
if (chip) await hover(chip.x, chip.y);
await sleep(4000);

// 8. Buses on the road, then the met update and a second decision
await jump(8 * 60 + 26);
await play();
cue("slip");
await until((s) => s.decision?.status === "debating" && s.decisions?.length === 2, 60_000);
cue("debate2");
await sleep(2500);
await b.evaluate("document.querySelector('.plans')?.scrollTo({ top: 0, behavior: 'smooth' })");
await sleep(600);
const card2 = await rect(".action-card");
if (card2) await hover(card2.x, card2.y);
await until((s) => s.decision?.status === "ready", 90_000);
await b.wheel(500, { x: 1380, y: 400 });
await sleep(3000);
cue("approve2");
await b.evaluate("document.querySelector('.plans .approve-btn')?.scrollIntoView({ block: 'center' })"); // a stale position would click the timeline
await sleep(400);
await b.click("Review & approve plan", { expect: "Approve plan" });
await sleep(1200);
await b.click("Approve plan B", { gone: true });
{
  const s = await state();
  console.log("after approve2: now", s.now, "approved", JSON.stringify(s.decisions?.map((d) => d.approved)));
}
await sleep(2000);

// 9. The hub reopens: aircraft fly home in their slots
await jump(10 * 60 + 44);
cue("reopen");
await until((s) => (s.recovery?.landed ?? 0) >= 4, 60_000);
await hover(700, 420);
await sleep(3000);

// 10. Debrief once the last aircraft is home
await jump(13 * 60 + 40);
await until((s) => s.recovery && s.recovery.landed === s.recovery.total, 60_000);
await sleep(1500);
cue("debrief");
await sleep(6000);

const { frames, end } = await b.stopRec();
{
  const s = await state();
  const hm = (m) => `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, "0")}`;
  console.log("final", hm(s.now), (s.decisions ?? []).map((d) => `${d.approved?.planId}@${hm(d.approved?.at ?? 0)}`).join(" "), s.recovery.schedule.filter((x) => x.land >= 720).map((x) => `${x.flight} ${x.crew} ${hm(x.land)}`).join(" | "));
}
b.close();
await sim({ action: "reset" });

// frames -> constant 30 fps: each output slot shows the newest frame captured by then
const FPS = 30,
  start = frames[0].t,
  slots = Math.ceil((end - start) * FPS);
const list = [];
let j = 0;
const written = new Map();
for (let s = 0; s < slots; s++) {
  const t = start + s / FPS;
  while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
  if (!written.has(j)) {
    const name = `frames/${String(j).padStart(5, "0")}.jpg`;
    writeFileSync(DIR + name, Buffer.from(frames[j].data, "base64"));
    written.set(j, name);
  }
  list.push(`file '${written.get(j)}'`, `duration ${(1 / FPS).toFixed(6)}`);
}
list.push(list[list.length - 2]);
writeFileSync(DIR + "list.txt", list.join("\n") + "\n");
writeFileSync(DIR + "cues.json", JSON.stringify(cues.map((c) => ({ at: Math.max(0, c.at - start), text: c.text })), null, 1));
console.log(`frames ${frames.length}, length ${(end - start).toFixed(1)} s`);
