// Minimal client for Vultr Serverless Inference (OpenAI-compatible chat + the /systemone decision API).
// The key is read from the environment only; it never leaves the server.

const BASE = process.env.VULTR_INFERENCE_BASE_URL ?? "https://api.vultrinference.com/v1";

function key(): string {
  const k = process.env.VULTR_INFERENCE_API_KEY;
  if (!k) throw new Error("VULTR_INFERENCE_API_KEY is not set");
  return k;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatResult = { message: Extract<ChatMessage, { role: "assistant" }>; usage?: { total_tokens: number } };

async function post<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vultr ${path} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function chat(opts: {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}): Promise<ChatResult> {
  const data = await post<{ choices: { message: ChatResult["message"] }[]; usage?: { total_tokens: number } }>(
    "/chat/completions",
    {
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools,
      max_tokens: opts.maxTokens ?? 800,
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    },
  );
  return { message: data.choices[0].message, usage: data.usage };
}

export type DecisionAnswer = { choice: string; probabilities: Record<string, number>; confidence: number };

/** Ask a Vultr decision model to pick between options. Returns calibrated probabilities per option. */
export async function decide(opts: {
  model?: string;
  state: string;
  question: string;
  options: string[];
}): Promise<DecisionAnswer> {
  const criteria = Object.fromEntries(opts.options.map((o) => [o, null]));
  const data = await post<{ answers: { q: DecisionAnswer } }>("/systemone", {
    model: opts.model ?? "clef-flash",
    state: opts.state,
    questions: { q: { type: "choice", question: opts.question, criteria } },
  });
  return data.answers.q;
}
