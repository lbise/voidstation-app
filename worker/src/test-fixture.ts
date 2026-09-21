import {
  calculateCost,
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

interface FixtureChunk {
  text: string;
  delayMs?: number;
}

interface FixturePartText { type: "text"; text: string; delayMs?: number; }
interface FixturePartToolCall { type: "toolCall"; name: string; arguments: Record<string, unknown>; }
type FixturePart = FixturePartText | FixturePartToolCall;

interface FixtureStep {
  text?: string;
  chunks?: FixtureChunk[];
  parts?: FixturePart[];
  delayMs?: number;
  error?: "authentication" | "limits" | "unavailable" | "hang";
  rawError?: string;
  fault?: "construct" | "iterator";
  ignoreAbort?: boolean;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
}

interface Fixture {
  steps: FixtureStep[];
}

let invocation = 0;

function fixturePath(): string {
  const value = process.env.VOIDSTATION_TEST_MODEL_FILE;
  if (!value || !isAbsolute(value)) throw new Error("The test model fixture path must be absolute.");
  return value;
}

function readStep(): FixtureStep {
  const fixture = JSON.parse(readFileSync(fixturePath(), "utf8")) as Fixture;
  if (!Array.isArray(fixture.steps) || fixture.steps.length === 0) throw new Error("The test model fixture needs at least one step.");
  const step = fixture.steps[invocation % fixture.steps.length] ?? {};
  invocation += 1;
  return step;
}

function scrub(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\b(sk|sess|tok)_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .slice(0, 8_000);
}

function capture(context: Context): void {
  const path = process.env.VOIDSTATION_TEST_ASSERTIONS_FILE;
  if (!path || !isAbsolute(path)) return;
  const messages = context.messages.map((message) => scrub(JSON.stringify(message)));
  appendFileSync(path, `${JSON.stringify({ messages, systemPrompt: scrub(context.systemPrompt ?? ""), tools: (context.tools ?? []).map((tool) => tool.name) })}\n`, { mode: 0o600 });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("unavailable"));
    }, { once: true });
  });
}

export function installFixtureModel(runtime: ModelRuntime): Model<any> {
  const model: Model<"fixture"> = {
    id: "fixture",
    name: "Voidstation deterministic fixture",
    provider: "voidstation-test",
    api: "fixture",
    baseUrl: "http://fixture.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  const streamSimple = (selected: Model<any>, context: Context, options?: SimpleStreamOptions) => {
    capture(context);
    const step = readStep();
    if (step.fault === "construct") throw new Error(`unavailable: ${step.rawError ?? "fixture construction failure"}`);
    if (step.fault === "iterator") {
      return {
        async *[Symbol.asyncIterator]() {
          throw new Error(`unavailable: ${step.rawError ?? "fixture iterator failure"}`);
        },
      } as unknown as AssistantMessageEventStream;
    }
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      try {
        if (step.error === "hang") {
          if (step.ignoreAbort) await new Promise<void>(() => {});
          await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("unavailable")), { once: true }));
        }
        if (step.delayMs) await sleep(step.delayMs, options?.signal);
        if (step.error) throw new Error(`${step.error}: ${step.rawError ?? step.error}`);
        const parts = step.parts ?? step.toolCalls?.map((call) => ({ type: "toolCall" as const, ...call }));
        if (parts) {
          stream.push({ type: "start", partial: output });
          for (const [index, part] of parts.entries()) {
            if (part.type === "toolCall") {
              const toolCall = { type: "toolCall" as const, id: `fixture-${invocation}-${index}`, name: part.name, arguments: part.arguments };
              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
              stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
            } else {
              if (typeof part.text !== "string" || (part.delayMs !== undefined && (!Number.isFinite(part.delayMs) || part.delayMs < 0))) throw new Error("unavailable: invalid fixture parts");
              if (part.delayMs) await sleep(part.delayMs, options?.signal);
              output.content.push({ type: "text", text: part.text });
              stream.push({ type: "text_start", contentIndex: index, partial: output });
              stream.push({ type: "text_delta", contentIndex: index, delta: part.text, partial: output });
              stream.push({ type: "text_end", contentIndex: index, content: part.text, partial: output });
            }
          }
          output.stopReason = parts.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
          calculateCost(selected, output.usage);
          stream.push({ type: "done", reason: output.stopReason, message: output });
          stream.end();
          return;
        }
        const chunks = step.chunks ?? [{ text: step.text ?? "" }];
        if (!Array.isArray(chunks) || chunks.some((chunk) => typeof chunk?.text !== "string" || (chunk.delayMs !== undefined && (!Number.isFinite(chunk.delayMs) || chunk.delayMs < 0)))) {
          throw new Error("unavailable: invalid fixture chunks");
        }
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "start", partial: output });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        for (const chunk of chunks) {
          if (chunk.delayMs) await sleep(chunk.delayMs, options?.signal);
          const block = output.content[0];
          if (block.type === "text") block.text += chunk.text;
          stream.push({ type: "text_delta", contentIndex: 0, delta: chunk.text, partial: output });
        }
        const complete = output.content[0];
        stream.push({ type: "text_end", contentIndex: 0, content: complete.type === "text" ? complete.text : "", partial: output });
        output.stopReason = "stop";
        calculateCost(selected, output.usage);
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : "unavailable";
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  };

  runtime.registerNativeProvider(createProvider({
    id: "voidstation-test",
    name: "Voidstation deterministic fixture",
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
    models: [model],
    api: { stream: streamSimple, streamSimple },
  }));
  return runtime.getModel("voidstation-test", "fixture")!;
}
