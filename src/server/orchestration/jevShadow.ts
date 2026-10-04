import { createHash } from "node:crypto";

export type JevGate = "knowledge" | "scope" | "verification" | "routing" |
  "run_score" | "feedback" | "curator";
export type JevMode = "off" | "shadow" | "active";
export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export interface JevRequest {
  gate: JevGate;
  mode: JevMode;
  state: unknown;
  questions: Record<string, JevQuestion>;
  // The caller must review the exact payload. This flag is not a privacy scanner.
  reviewedForExternalTransmission: boolean;
  taskVersion: string;
  rubricVersion: string;
}
export interface JevUsage { input_tokens: number; output_tokens: number }
export interface JevResponse {
  model: string;
  answers: Record<string, unknown>;
  usage: JevUsage;
}
export interface JevShadowResult {
  status: "off" | "held" | "shadow";
  gate: JevGate;
  key: string | null;
  reason: string | null;
  response: JevResponse | null;
  estimatedUsd: number | null;
  elapsedMs: number | null;
}
export type JevProvider = (payload: { state: unknown;
  questions: Record<string, JevQuestion> }) => Promise<unknown>;

// The price is a versioned estimate for reporting, never a provider billing cap.
export const JEV_INPUT_USD_PER_MILLION = 0.042;
const MAX_PAYLOAD_CHARS = 8_000;
const VALID_GATES: JevGate[] = ["knowledge", "scope", "verification", "routing",
  "run_score", "feedback", "curator"];

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function distribution(value: unknown, keys: string[]): boolean {
  if (!object(value) || Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key) &&
        typeof value[key] === "number" && Number.isFinite(value[key]) &&
        (value[key] as number) >= 0 && (value[key] as number) <= 1)) return false;
  const sum = keys.reduce((total, key) => total + (value[key] as number), 0);
  return Math.abs(sum - 1) <= 0.001;
}
function responseFor(raw: unknown, questions: Record<string, JevQuestion>): JevResponse {
  if (!object(raw) || typeof raw.model !== "string" || !raw.model ||
      !object(raw.answers) ||
      !object(raw.usage) || !whole(raw.usage.input_tokens) ||
      !whole(raw.usage.output_tokens)) throw new Error("Jev response shape invalid");
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers[id];
    if (!object(answer) || answer.type !== question.type) {
      throw new Error(`Jev answer missing or wrong type: ${id}`);
    }
    if (question.type === "noul") {
      if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul) ||
          answer.noul < 0 || answer.noul > 1)
        throw new Error(`Jev noul invalid: ${id}`);
    } else {
      const selected = question.type === "choice" ? answer.choice : answer.score;
      const levels = question.type === "choice" ? Object.keys(question.criteria) :
        question.criteria.map((_, index) => String(index));
      const legend = object(answer.legend) ? answer.legend : null;
      if (!distribution(answer.probabilities, levels) ||
          (question.type === "score" &&
           (!legend || levels.some((level, index) =>
             legend[level] !== question.criteria[index]))) ||
          (question.type === "choice" &&
            (typeof selected !== "string" ||
             !Object.hasOwn(question.criteria, selected))) ||
          (question.type === "score" &&
            (typeof selected !== "number" || !Number.isFinite(selected) ||
             selected < 0 || selected > question.criteria.length - 1)) ||
          typeof answer.confidence !== "number" ||
          !Number.isFinite(answer.confidence) ||
          answer.confidence < 0 || answer.confidence > 1)
        throw new Error(`Jev choice/score invalid: ${id}`);
    }
  }
  return raw as unknown as JevResponse;
}

export function validateJevRequest(request: JevRequest): string {
  if (!VALID_GATES.includes(request.gate) ||
      !["off", "shadow", "active"].includes(request.mode))
    throw new Error("Jev gate or mode invalid");
  if (!request.taskVersion || !request.rubricVersion) throw new Error("Jev version missing");
  const entries = Object.entries(request.questions);
  if (entries.length < 1 || entries.length > 7) throw new Error("Jev question count invalid");
  for (const [id, question] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(id) || !object(question) ||
        typeof question.instructions !== "string" || !question.instructions.trim())
      throw new Error("Jev question invalid");
    if (question.type === "choice") {
      if (!object(question.criteria) || Object.keys(question.criteria).length < 2 ||
          !Object.values(question.criteria).every((value) =>
            typeof value === "string" && value.trim()))
        throw new Error("Jev criteria invalid");
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 ||
          question.criteria.length > 10 ||
          !question.criteria.every((value) => typeof value === "string" && value.trim()))
        throw new Error("Jev criteria invalid");
    } else if (question.type !== "noul") throw new Error("Jev question type invalid");
  }
  const payload = JSON.stringify({ state: request.state, questions: request.questions });
  if (!payload || payload.length > MAX_PAYLOAD_CHARS) throw new Error("Jev payload too large");
  return createHash("sha256").update(JSON.stringify({ gate: request.gate,
    taskVersion: request.taskVersion, rubricVersion: request.rubricVersion,
    payload })).digest("hex");
}

/** One advisory call. The caller supplies a durable, at-most-once dispatch ledger. */
export async function evaluateJevShadow(request: JevRequest, provider: JevProvider):
    Promise<JevShadowResult> {
  const key = validateJevRequest(request);
  if (request.mode === "off") return { status: "off", gate: request.gate, key,
    reason: null, response: null, estimatedUsd: null, elapsedMs: null };
  if (!request.reviewedForExternalTransmission) return { status: "held",
    gate: request.gate, key, reason: "payload was not reviewed for external transmission",
    response: null, estimatedUsd: null, elapsedMs: null };
  // Active decisions need a separate calibrated policy path. Shadow cannot change work.
  if (request.mode === "active") return { status: "held", gate: request.gate,
    key, reason: "active policy has not been enabled", response: null,
    estimatedUsd: null, elapsedMs: null };
  const start = Date.now();
  const raw = await provider({ state: request.state, questions: request.questions });
  const response = responseFor(raw, request.questions);
  return { status: "shadow", gate: request.gate, key, reason: null, response,
    estimatedUsd: response.usage.input_tokens * JEV_INPUT_USD_PER_MILLION / 1_000_000,
    elapsedMs: Date.now() - start };
}

export function typeSafeJevProvider(options: { apiKey: string; timeoutMs?: number;
    fetchImpl?: typeof fetch }): JevProvider {
  if (!options.apiKey) throw new Error("TypeSafe API key missing");
  const send = options.fetchImpl ?? fetch;
  return async (payload) => {
    const response = await send("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-1.13.0", ...payload }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
    return response.json();
  };
}
