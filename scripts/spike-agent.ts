// T2 spike: can a seat agent call a tool through Vultr Serverless Inference, and which model is fastest?
// Run: node --env-file=.env --import tsx scripts/spike-agent.ts
import { chat, decide, type ChatMessage, type ToolSpec } from "../src/server/llm.ts";

const tools: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "get_crew_status",
      description: "Return duty time left for every crew at an airport.",
      parameters: { type: "object", properties: { airport: { type: "string" } }, required: ["airport"] },
    },
  },
];

function getCrewStatus(airport: string) {
  return { airport, crews: [{ id: "C07", dutyLeftMin: 55 }, { id: "C12", dutyLeftMin: 130 }] };
}

const MODELS = ["qwen3.8-flash-next", "glm-5.3-flash", "deepseek-v4.1-flash-1017"];

for (const model of MODELS) {
  const t0 = Date.now();
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are Crew Control in an airline ops room. Use tools for facts. Answer in one short sentence." },
      { role: "user", content: "Fog at the hub. Which crew at DWC is closest to its duty limit?" },
    ];
    const first = await chat({ model, messages, tools, reasoningEffort: "low" });
    const call = first.message.tool_calls?.[0];
    if (!call) {
      console.log(`${model}: NO TOOL CALL (${Date.now() - t0} ms): ${first.message.content?.slice(0, 80)}`);
      continue;
    }
    const args = JSON.parse(call.function.arguments) as { airport: string };
    messages.push(first.message, { role: "tool", tool_call_id: call.id, content: JSON.stringify(getCrewStatus(args.airport)) });
    const second = await chat({ model, messages, tools, reasoningEffort: "low" });
    console.log(`${model}: tool=${call.function.name}(${call.function.arguments}) ${Date.now() - t0} ms -> ${second.message.content?.trim().slice(0, 120)}`);
  } catch (e) {
    console.log(`${model}: ERROR ${(e as Error).message.slice(0, 160)} (${Date.now() - t0} ms)`);
  }
}

const t1 = Date.now();
const d = await decide({
  state: "Fog at the hub until ~09:30. 3 standby crews 40-50 min away by bus. Crew C07 illegal at 07:37.",
  question: "Which recovery plan is most likely to keep every crew legal and protect the most guests?",
  options: ["A: Wait for fog", "B: Bus standby crews now", "C: Cancel 4 flights"],
});
console.log(`decision: ${d.choice} ${JSON.stringify(d.probabilities)} (${Date.now() - t1} ms)`);
