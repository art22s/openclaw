import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsAuthLoginFlowResult } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  resetNativeCommandMenuMocks,
} from "./bot-native-commands.menu-test-support.js";

const loginSessionMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
  patchSessionEntry: vi.fn(),
  completeModelAccess: vi.fn(),
}));

vi.mock("../../../src/commands/models/auth-model-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/commands/models/auth-model-policy.js")>()),
  completeProviderModelAccess: loginSessionMocks.completeModelAccess,
}));

vi.mock("./bot-native-commands.runtime.js", () => ({
  ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: true })),
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
  getAgentScopedMediaLocalRoots: vi.fn(() => []),
  getSessionEntry: loginSessionMocks.getSessionEntry,
  resolveChunkMode: vi.fn(() => "length"),
  resolveThreadSessionKeys: vi.fn(
    ({
      baseSessionKey,
      parentSessionKey,
    }: {
      baseSessionKey: string;
      parentSessionKey?: string;
    }) => ({
      sessionKey: baseSessionKey,
      parentSessionKey,
    }),
  ),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntry: loginSessionMocks.getSessionEntry,
    resolveStorePath: loginSessionMocks.resolveStorePath,
    patchSessionEntry: loginSessionMocks.patchSessionEntry,
  };
});

type LoginFlowMock = ReturnType<typeof vi.fn>;
export type TelegramLoginFlow = NonNullable<TelegramNativeCommandDeps["runModelsAuthLoginFlow"]>;

let loginAccountIndex = 0;

export function createLoginResult(
  profileId: string,
  authRefresh: ModelsAuthLoginFlowResult["authRefresh"] = "refreshed",
): ModelsAuthLoginFlowResult {
  return {
    providerId: "openai",
    methodId: "device-code",
    authRefresh,
    profiles: [{ profileId, provider: "openai", mode: "oauth" }],
  };
}

export function createOwnerLoginConfig(): OpenClawConfig {
  return {
    commands: { native: true, ownerAllowFrom: ["200"] },
    agents: { list: [{ id: "main", default: true }] },
  };
}

export function registerLoginCommand(params: {
  cfg: OpenClawConfig;
  loginFlow: LoginFlowMock;
  accountId?: string;
  allowFrom?: string[];
  abortSignal?: AbortSignal;
  runtime?: RuntimeEnv;
  getRuntimeConfig?: () => OpenClawConfig;
}) {
  const botHarness = createCommandBot();
  const accountId = params.accountId ?? `login-test-${++loginAccountIndex}`;
  const cfg = {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults: { model: "openai/gpt-5.4", ...params.cfg.agents?.defaults },
    },
  };
  const nativeParams = createNativeCommandTestParams(cfg, {
    accountId,
    bot: botHarness.bot,
    allowFrom: params.allowFrom ?? ["200"],
    ...(params.abortSignal
      ? {
          opts: {
            token: "token",
            accountAbortSignal: params.abortSignal,
          },
        }
      : {}),
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
  const sendMessageTelegram = vi.fn(async (_to, text) => {
    const result = await botHarness.bot.api.sendMessage(100, text, {});
    return { messageId: String(result.message_id), chatId: "100" };
  });
  const nativeCommandCallbackDispatcher = withPluginRuntimeRegistryScope(
    createEmptyPluginRegistry(),
    () =>
      registerTelegramNativeCommands({
        ...nativeParams,
        telegramDeps: {
          ...nativeParams.telegramDeps,
          ...(params.getRuntimeConfig ? { getRuntimeConfig: params.getRuntimeConfig } : {}),
          runModelsAuthLoginFlow: params.loginFlow,
          sendMessageTelegram,
        } as never,
      }),
  );
  const handler = botHarness.commandHandlers.get("login");
  if (!handler) {
    throw new Error("expected login command handler to be registered");
  }
  return {
    ...botHarness,
    accountId,
    handler,
    nativeCommandCallbackDispatcher,
    sendMessageTelegram,
  };
}

export { loginSessionMocks };

export function resetLoginCommandMocks() {
  resetNativeCommandMenuMocks();
  loginSessionMocks.completeModelAccess.mockReset();
  loginSessionMocks.loadSessionStore.mockReset().mockReturnValue({});
  loginSessionMocks.getSessionEntry
    .mockReset()
    .mockImplementation(
      ({ storePath, sessionKey }: { storePath: string; sessionKey: string }) =>
        loginSessionMocks.loadSessionStore(storePath)[sessionKey],
    );
  loginSessionMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  loginSessionMocks.patchSessionEntry.mockReset().mockImplementation(async (params) => {
    const current = loginSessionMocks.loadSessionStore(params.storePath)[params.sessionKey];
    if (!current) {
      return null;
    }
    const patch = await params.update({ ...current });
    params.assertCommitAllowed?.();
    return patch ? { ...current, ...patch } : current;
  });
}
