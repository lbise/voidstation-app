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

export function providerFailure(error: unknown): { kind: ProviderFailureKind; message: string } {
  const source = error instanceof Error ? error.message : String(error);
  const message = source.toLowerCase();
  if (/(auth|login|oauth|credential|token|401|403)/.test(message)) {
    return { kind: "authentication", message: "Provider authentication is unavailable. Run worker login." };
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
    errorMessage: providerFailure(error).message,
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
          output.push({ ...event, error: { ...event.error, errorMessage: providerFailure(event.error.errorMessage ?? "provider failure").message } });
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

/** A loader with no discovery paths, extensions, packages, skills, prompts, themes, or context files. */
export class EmptyResourceLoader implements ResourceLoader {
  getExtensions(): LoadExtensionsResult { return EMPTY_EXTENSIONS; }
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } { return { skills: [], diagnostics: [] }; }
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } { return { prompts: [], diagnostics: [] }; }
  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } { return { themes: [], diagnostics: [] }; }
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } { return { agentsFiles: [] }; }
  getSystemPrompt(): string | undefined {
    return "You are Voidstation's Assistant. Reply directly and concisely. No Server, media, filesystem, shell, network, or coding tools are available. Do not claim to perform actions you cannot perform.";
  }
  getSystemPromptSource(): { path: string } | undefined { return undefined; }
  getAppendSystemPrompt(): string[] { return []; }
  getAppendSystemPromptSources(): Array<{ path: string }> { return []; }
  extendResources(): void {}
  async reload(): Promise<void> {}
}

export const emptySettings = () => SettingsManager.inMemory({
  defaultTools: [],
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
