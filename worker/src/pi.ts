import {
  type LoadExtensionsResult,
  type ResourceLoader,
  type ResourceDiagnostic,
  type Skill,
  type PromptTemplate,
  type Theme,
  createExtensionRuntime,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { resolve } from "node:path";

const EMPTY_EXTENSIONS: LoadExtensionsResult = {
  extensions: [],
  errors: [],
  runtime: createExtensionRuntime(),
};

export type ProviderFailureKind = "authentication" | "limits" | "unavailable" | "unknown";

export function providerFailure(error: unknown, providerId?: string): { kind: ProviderFailureKind; message: string } {
  const source = error instanceof Error ? error.message : String(error);
  const message = source.toLowerCase();
  if (/(auth|login|oauth|credential|token|401|403)/.test(message)) {
    return { kind: "authentication", message: providerId === "openrouter" ? "OpenRouter authentication is unavailable. Check the worker credential file." : "Provider authentication is unavailable. Run worker login." };
  }
  if (/(limit|quota|rate.?limit|429|usage)/.test(message)) {
    return { kind: "limits", message: "Provider limits are currently exhausted." };
  }
  if (/(unavailable|network|timeout|timed out|5\d\d|abort)/.test(message)) {
    return { kind: "unavailable", message: "Provider is unavailable. Try again later." };
  }
  return { kind: "unknown", message: "The assistant could not complete this reply." };
}

function failureMessage(model: Model<any>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: providerFailure(error, model.provider).message,
    timestamp: Date.now(),
  };
}

function failureStream(model: Model<any>, error: unknown): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const message = failureMessage(model, error);
  queueMicrotask(() => {
    output.push({ type: "error", reason: "error", error: message });
    output.end();
  });
  return output;
}

function sanitizeStream(model: Model<any>, source: AssistantMessageEventStream): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "error") {
          output.push({ ...event, error: { ...event.error, errorMessage: providerFailure(event.error.errorMessage ?? "provider failure", model.provider).message } });
        } else {
          output.push(event);
        }
      }
    } catch (error) {
      output.push({ type: "error", reason: "error", error: failureMessage(model, error) });
    } finally {
      output.end();
    }
  })().catch(() => {
    // The body catches all provider failures. This final guard prevents an unhandled rejection.
    output.end();
  });
  return output;
}

function safelyCreateStream(model: Model<any>, create: () => AssistantMessageEventStream): AssistantMessageEventStream {
  try {
    return sanitizeStream(model, create());
  } catch (error) {
    return failureStream(model, error);
  }
}

/** Replaces one provider's model stream before Pi can persist an error message. */
export function installSanitizedProvider(runtime: ModelRuntime, providerId: string): void {
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error("The required provider is unavailable in the pinned Pi runtime.");
  const wrapped: Provider = {
    ...provider,
    stream: ((model, context, options) => safelyCreateStream(model, () => provider.stream(model as never, context, options as never))) as Provider["stream"],
    streamSimple: ((model, context, options) => safelyCreateStream(model, () => provider.streamSimple(model, context, options))) as Provider["streamSimple"],
  };
  runtime.registerNativeProvider(wrapped);
}

/** No resource discovery. Media access is limited to the four domain tools. */
export class RestrictedResourceLoader implements ResourceLoader {
  getExtensions(): LoadExtensionsResult { return EMPTY_EXTENSIONS; }
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } { return { skills: [], diagnostics: [] }; }
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } { return { prompts: [], diagnostics: [] }; }
  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } { return { themes: [], diagnostics: [] }; }
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } { return { agentsFiles: [] }; }
  getSystemPrompt(): string | undefined {
    return `You are Voidstation's Assistant. Reply directly and concisely.
You can identify movies and TV series and manage the Managed library. Movies use Radarr; TV series use Sonarr.
Only media_find, media_details, media_configure, and media_search are available. There is no shell, generic API, or arbitrary filesystem tool.
Use media_find to resolve identity. If more than one choice is returned, present the title, year, type, and external ID of the choices and ask the owner which they mean. Never silently select the first result. Use the explicit resolved TMDB movie ID or TVDB series ID with the other media tools.
Use media_details before changing a title. Use media_configure to add a resolved title or update monitoring and quality. Use media_search only when the owner explicitly asks to search. Configuration changes and searches do not guarantee that a download has started or that media is available.
For TV series, ask whether monitoring covers all seasons, future episodes, no episodes, or named seasons. Movies do not have seasons. Never choose a quality, folder, or title silently. Report tracked, activeDownload, and available separately using tool evidence. Available TV media can be partial; do not claim all episodes are present or promise playback integration. Service results are timestamped historical checks, not live monitoring. Explain tool failures without inventing a status. Do not claim a change or search succeeded unless the tool result says it did.`;
  }
  getSystemPromptSource(): { path: string } | undefined { return undefined; }
  getAppendSystemPrompt(): string[] { return []; }
  getAppendSystemPromptSources(): Array<{ path: string }> { return []; }
  extendResources(): void {}
  async reload(): Promise<void> {}
}

export const emptySettings = () => SettingsManager.inMemory({
  defaultTools: [],
  enableSkillCommands: false,
  defaultProjectTrust: "never",
  enableInstallTelemetry: false,
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
  compaction: { enabled: false },
  retry: { enabled: false, provider: { maxRetries: 0 } },
});

export async function createCodexRuntime(credentialDir: string): Promise<ModelRuntime> {
  const credentialRoot = resolve(credentialDir);
  return ModelRuntime.create({
    authPath: resolve(credentialRoot, "auth.json"),
    modelsPath: null,
    modelsStorePath: resolve(credentialRoot, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

export function codexModel(runtime: ModelRuntime): Model<any> {
  const model = runtime.getModel("openai-codex", "gpt-5.5");
  if (!model) throw new Error("The pinned Pi runtime does not include the required Codex model.");
  return model;
}
