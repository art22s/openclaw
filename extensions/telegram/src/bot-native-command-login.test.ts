import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  type ModelsAuthLoginFlowOptions,
  ProviderAuthConfigApplyError,
} from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Register shared mocks before importing the login runtime values.
import {
  createLoginResult,
  createOwnerLoginConfig,
  loginSessionMocks,
  registerLoginCommand,
  resetLoginCommandMocks,
  type TelegramLoginFlow,
} from "./bot-native-command-login.test-support.js";
import { createTelegramGroupCommandContext } from "./bot-native-commands.fixture-test-support.js";
import {
  deliverReplies,
  createPrivateCommandContext,
} from "./bot-native-commands.menu-test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

describe("registerTelegramNativeCommands /login", () => {
  beforeEach(resetLoginCommandMocks);

  it("delivers the core provider menu and its method continuation without starting login", async () => {
    const loginFlow = vi.fn();
    const { handler, nativeCommandCallbackDispatcher } = registerLoginCommand({
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
      loginFlow,
    });
    await handler(createPrivateCommandContext({ match: "", userId: 200 }));
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("Choose a provider") })],
      }),
    );
    expect(loginFlow).not.toHaveBeenCalled();
    await nativeCommandCallbackDispatcher?.({
      botUser: telegramBotInfoForTest,
      callbackQuery: {
        id: "provider-selection",
        from: { id: 200, is_bot: false, first_name: "Owner" },
        chat_instance: "private-chat",
        message: {
          message_id: 101,
          date: 1,
          chat: { id: 100, type: "private", first_name: "Owner" },
        },
      },
      commandText: "/login oauth/openai/openai",
    });
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({ text: expect.stringContaining("Choose how to connect") }),
        ],
      }),
    );
    expect(loginFlow).not.toHaveBeenCalled();
  });

  it("handles /login codex by sending the device code before login completes", async () => {
    let loginParams: ModelsAuthLoginFlowOptions | undefined;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      loginParams = params;
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "ABCD-EFGH",
        expiresInMinutes: 15,
        message: [
          "Open this URL in your LOCAL browser and enter the code below.",
          "URL: https://auth.openai.com/codex/device",
        ].join("\n"),
      });
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage, setMyCommands } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    expect(setMyCommands).toHaveBeenCalledOnce();
    const registeredCommands = setMyCommands.mock.calls[0]?.[0];
    expect(registeredCommands).toContainEqual({
      command: "login",
      description: "Connect a model provider.",
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    expect(loginParams).toMatchObject({ provider: "openai", method: "device-code", agent: "main" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 5_000 });

    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts[0]).toContain("URL: https://auth.openai.com/codex/device");
    expect(texts[0]).toContain("Code: <code>ABCD-EFGH</code>");
    expect(texts[0]).toContain("Never share it.");
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
    expect(texts.at(-1)).toContain("OpenAI login complete. Try your request again now.");
  });

  it.each([
    {
      authRefresh: "gateway-rejected",
      message:
        "OpenAI credentials saved, but the Gateway could not apply the auth update. Check the Gateway logs, restart the Gateway, then use /models.",
    },
    {
      authRefresh: "gateway-unreachable",
      message:
        "OpenAI credentials saved, but the Gateway could not be reached to apply them. Restart the Gateway, then use /models.",
    },
  ] as const)(
    "reports saved credentials without immediate retry guidance when refresh is $authRefresh",
    async ({ authRefresh, message }) => {
      const loginFlow = vi.fn(async () => createLoginResult("openai:codex", authRefresh));
      const { handler, sendMessage } = registerLoginCommand({
        cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
        loginFlow,
      });

      await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

      expect(sendMessage).toHaveBeenCalledWith(100, message, {});
      expect(sendMessage).not.toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        expect.any(Object),
      );
    },
  );

  it("releases the chat lane only after structured device-code delivery", async () => {
    const allowDeviceCode = createDeferred<void>();
    const finishLogin = createDeferred<void>();
    let loginCompleted = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("Preparing Codex login…");
      await allowDeviceCode.promise;
      if (!params.prompter.deviceCode) {
        throw new Error("expected structured device-code delivery");
      }
      await params.prompter.deviceCode({
        title: "OpenAI Codex device code",
        code: "PENDING-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      loginCompleted = true;
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    let handlerReturned = false;
    const handlerTask = handler(createPrivateCommandContext({ match: "codex", userId: 200 })).then(
      () => {
        handlerReturned = true;
      },
    );
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "Preparing Codex login…",
      ),
    );
    expect(handlerReturned).toBe(false);

    allowDeviceCode.resolve();
    await handlerTask;

    expect(loginCompleted).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>PENDING-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() => expect(loginCompleted).toBe(true));
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );
  });

  it("routes the login button through the non-blocking native login flow", async () => {
    const finishLogin = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "BUTTON-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      return createLoginResult("openai:codex");
    });
    const { nativeCommandCallbackDispatcher, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });
    if (!nativeCommandCallbackDispatcher) {
      throw new Error("expected login callback dispatcher to be registered");
    }
    const callbackQuery = {
      id: "login-button",
      chat_instance: "login-button-chat",
      data: "tgcmd:/login codex",
      from: { id: 200, is_bot: false, first_name: "Bob", username: "bob" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: "private" as const, first_name: "Owner" },
        reply_markup: {
          inline_keyboard: [[{ text: "Log in to Codex", callback_data: "tgcmd:/login codex" }]],
        },
      },
    };

    await expect(
      nativeCommandCallbackDispatcher({
        commandText: "/login codex",
        botUser: telegramBotInfoForTest,
        callbackQuery,
      }),
    ).resolves.toEqual({ handled: true, clearButtons: true });

    expect(loginFlow).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>BUTTON-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );
  });

  it.each(["all", "keep"])(
    "completes deferred %s consent through a fresh dispatcher",
    async (choice) => {
      const accepted = vi.fn();
      loginSessionMocks.completeModelAccess.mockImplementation(
        async (
          params: Parameters<
            typeof import("../../../src/commands/models/auth-model-policy.js").completeProviderModelAccess
          >[0],
        ) => {
          if (!params.prepared) {
            throw new Error("expected model access request");
          }
          accepted(await params.prompter.select(params.prepared.prompt));
        },
      );
      const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
        await params.prompter.deviceCode?.({ title: "Sign in", code: "MODEL-ACCESS" });
        if (!params.onModelAccessRequested) {
          throw new Error("expected deferred model access");
        }
        params.onModelAccessRequested({
          provider: "openai",
          providerLabel: "OpenAI",
          agentId: "main",
          policy: { path: "agents.defaults.modelPolicy.allow", refs: ["openai/gpt-5.4"] },
          prompt: {
            message: "Credentials saved. Your current model restrictions may hide OpenAI models.",
            initialValue: "keep",
            options: [
              { value: "all", label: "Show all OpenAI models" },
              { value: "keep", label: "Keep current restrictions" },
            ],
          },
        });
        return createLoginResult("openai:consent");
      });
      const cfg = createOwnerLoginConfig();
      const first = registerLoginCommand({ cfg, loginFlow });
      await first.handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
      await vi.waitFor(() => expect(deliverReplies).toHaveBeenCalled());
      const delivery = vi.mocked((await import("./bot/delivery.replies.js")).deliverReplies);
      const buttons = delivery.mock.calls
        .at(-1)?.[0]
        .replies[0]?.presentation?.blocks.find((block) => block.type === "buttons");
      expect(buttons).toMatchObject({
        buttons: [
          {
            label: "Show all OpenAI models",
            action: { type: "command", command: expect.stringMatching(/^\/login choice /) },
          },
          {
            label: "Keep current restrictions",
            action: { type: "command", command: expect.stringMatching(/^\/login choice /) },
          },
        ],
      });
      const button = buttons?.buttons[choice === "all" ? 0 : 1];
      if (button?.action?.type !== "command") {
        throw new Error("expected typed command button");
      }
      const commandText = button.action.command;
      expect(accepted).not.toHaveBeenCalled();
      const fresh = registerLoginCommand({ cfg, loginFlow, accountId: first.accountId });
      const dispatch = fresh.nativeCommandCallbackDispatcher;
      if (!dispatch) {
        throw new Error("expected native callback dispatcher");
      }
      let callbackId = 0;
      const click = (chatId: number) =>
        dispatch({
          commandText,
          botUser: telegramBotInfoForTest,
          callbackQuery: {
            id: `model-access-${++callbackId}`,
            chat_instance: "private-chat",
            from: { id: 200, is_bot: false, first_name: "Owner" },
            message: {
              message_id: 101,
              date: 1,
              chat: { id: chatId, type: "private", first_name: "Owner" },
            },
          },
        });
      await click(101);
      expect(accepted).not.toHaveBeenCalled();
      await click(100);
      expect(accepted).toHaveBeenCalledExactlyOnceWith(choice);
      expect(fresh.sendMessage).toHaveBeenLastCalledWith(
        100,
        expect.stringContaining(
          choice === "all"
            ? "All OpenAI models are now visible."
            : "Current model restrictions kept.",
        ),
        {},
      );
      await click(100);
      expect(accepted).toHaveBeenCalledOnce();
      expect(loginFlow).toHaveBeenCalledOnce();
    },
  );

  it("rejects group /login codex without sending the device code publicly", async () => {
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("URL: https://auth.openai.com/codex/device\nCode: SECRET");
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      allowFrom: ["200"],
    });

    await handler(createTelegramGroupCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts).toContain(
      "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.",
    );
    expect(texts.join("\n")).not.toContain("SECRET");
    expect(texts.join("\n")).not.toContain("https://auth.openai.com/codex/device");
  });

  it("rejects /login for authorized senders who are not owners", async () => {
    const loginFlow = vi.fn(async () => ({
      providerId: "openai",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          allowFrom: { telegram: ["200"] },
          ownerAllowFrom: ["999"],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "Only a configured OpenClaw owner/admin can start provider login from this channel.",
    );
  });

  it("dedupes active /login flows for the same Telegram thread", async () => {
    const deferred = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "FIRST-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await deferred.promise;
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    deferred.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );

    expect(loginFlow).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "OpenAI login is already active for this Telegram chat. Complete it, or wait for it to expire before requesting a new one.",
    );
  });

  it("rejects credential persistence after the command owner is removed", async () => {
    const deferred = createDeferred<void>();
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const cfg: OpenClawConfig = {
      commands,
      agents: { list: [{ id: "main", default: true }] },
    };
    let currentConfig = cfg;
    const persist = vi.fn();
    const loginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({ title: "Sign in", code: "OWNER-CODE" });
      await deferred.promise;
      opts.assertCurrent?.();
      persist();
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg,
      loginFlow,
      getRuntimeConfig: () => currentConfig,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    currentConfig = { ...cfg, commands: { native: true, ownerAllowFrom: ["999"] } };
    deferred.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
      ),
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the prior Telegram pin when the owner is revoked after patch preparation", async () => {
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const previous: SessionEntry = {
      sessionId: "revoked-telegram-owner-session",
      updatedAt: 1,
      authProfileOverride: "openai:prior",
      authProfileOverrideSource: "user",
    };
    const store = { "agent:main:main": previous };
    loginSessionMocks.loadSessionStore.mockReturnValue(store);
    loginSessionMocks.patchSessionEntry.mockImplementationOnce(
      async (
        write: Parameters<
          typeof import("openclaw/plugin-sdk/session-store-runtime").patchSessionEntry
        >[0],
      ) => {
        const patch = await write.update({ ...previous }, { existingEntry: previous });
        commands.ownerAllowFrom = ["999"];
        write.assertCommitAllowed?.();
        store["agent:main:main"] = patch ? { ...previous, ...patch } : previous;
        return store["agent:main:main"];
      },
    );
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => createLoginResult("openai:saved"));
    const { handler, sendMessage } = registerLoginCommand({ cfg: { commands }, loginFlow });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(store["agent:main:main"]).toBe(previous);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
    );
  });

  it("releases a failed flow before any device code is delivered", async () => {
    const loginFlow = vi.fn(async () => {
      throw new Error("device-code request failed");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).toHaveBeenCalledTimes(2);
    expect(
      sendMessage.mock.calls.filter(
        (call) =>
          call[1] ===
          "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
      ),
    ).toHaveLength(2);
  });

  it("reports saved credentials when provider settings fail after device login", async () => {
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SAVED-CODE" });
      throw new ProviderAuthConfigApplyError(new Error("provider config write failed"));
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[0]?.[1]).toContain("Code: <code>SAVED-CODE</code>");
    expect(sendMessage).toHaveBeenLastCalledWith(
      100,
      "OpenAI credentials saved, but provider settings could not be applied. Review the provider settings and check the Gateway logs before trying again.",
      {},
    );
    expect(loginSessionMocks.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("does not report auth failure when only the terminal notification fails", async () => {
    const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SUCCESS-CODE" });
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      runtime,
    });
    sendMessage.mockResolvedValueOnce({ message_id: 999 });
    sendMessage.mockRejectedValueOnce(new Error("Telegram unavailable"));

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await vi.waitFor(() =>
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("result notification failed"),
      ),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
    );
  });

  it("blocks provider prompts and terminal messages after Telegram stops", async () => {
    const shutdown = new AbortController();
    let loginSettled = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "ABORT-CODE" });
      if (!params.signal) {
        throw new Error("expected login owner signal");
      }
      const signal = params.signal;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("Telegram stopped"),
              ),
            { once: true },
          );
        });
        throw new Error("unreachable");
      } catch {
        await params.prompter.note("Trouble with device code login?", "OAuth help");
      } finally {
        loginSettled = true;
      }
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      abortSignal: shutdown.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    shutdown.abort(new Error("Telegram stopped"));
    await vi.waitFor(() => expect(loginSettled).toBe(true));

    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toHaveLength(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("ABORT-CODE");
  });

  it("keeps pending login alive across a polling-cycle restart", async () => {
    const account = new AbortController();
    const pollingCycle = new AbortController();
    const finishLogin = createDeferred<void>();
    let loginSignal: AbortSignal | undefined;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      loginSignal = params.signal;
      await params.prompter.deviceCode?.({ title: "Codex login", code: "RESTART-CODE" });
      await finishLogin.promise;
      return createLoginResult("openai:codex");
    });
    const { accountId, handler, sendMessage, sendMessageTelegram } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      abortSignal: account.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    pollingCycle.abort(new Error("recoverable polling restart"));
    sendMessage.mockRejectedValue(new Error("retired polling bot"));
    sendMessageTelegram.mockResolvedValueOnce({ messageId: "1000", chatId: "100" });

    expect(loginSignal?.aborted).toBe(false);
    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        "telegram:100",
        "OpenAI login complete. Try your request again now.",
        expect.objectContaining({ accountId, token: "token" }),
      ),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it("moves the target session to the profile returned by Telegram /login codex", async () => {
    const finishLogin = createDeferred<void>();
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        authProfileOverride: "openai:owner@example.com",
        sessionId: "sess-main",
        updatedAt: 1,
      },
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "ABCD-EFGH",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      return createLoginResult("openai:new-owner@example.com");
    });

    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    expect(loginSessionMocks.patchSessionEntry).not.toHaveBeenCalled();
    finishLogin.resolve();

    expect(runModelsAuthLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        method: "device-code",
        agent: "main",
      }),
    );
    expect(
      (runModelsAuthLoginFlow.mock.calls[0]?.[0] as { profileId?: string } | undefined)?.profileId,
    ).toBeUndefined();
    await vi.waitFor(() =>
      expect(loginSessionMocks.patchSessionEntry).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
        requireWriteSuccess: true,
        skipMaintenance: true,
        assertCommitAllowed: expect.any(Function),
        update: expect.any(Function),
      }),
    );
    const patchUpdate = (
      loginSessionMocks.patchSessionEntry.mock.calls[0]?.[0] as {
        update?: (entry: Record<string, unknown>) => Record<string, unknown>;
      }
    )?.update?.({
      authProfileOverride: "openai:owner@example.com",
      sessionId: "sess-main",
      updatedAt: 1,
    });
    expect(patchUpdate).toEqual({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        {},
      ),
    );
  });

  it("moves a session created while Telegram login is pending to the returned profile", async () => {
    const finishLogin = createDeferred<void>();
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "NEW-SESSION",
      });
      await finishLogin.promise;
      return createLoginResult("openai:new-owner@example.com");
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore = {
      "agent:main:main": {
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() => expect(loginSessionMocks.patchSessionEntry).toHaveBeenCalledTimes(1));
    const update = (
      loginSessionMocks.patchSessionEntry.mock.calls[0]?.[0] as {
        update?: (entry: SessionEntry) => Partial<SessionEntry> | null;
      }
    )?.update;
    expect(
      update?.({
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      }),
    ).toEqual({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        {},
      ),
    );
  });

  it("preserves a later user-selected profile on a session created during Telegram login", async () => {
    const finishLogin = createDeferred<void>();
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "LATER-USER-SELECTION",
      });
      await finishLogin.promise;
      return createLoginResult("openai:login-profile");
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore = {
      "agent:main:main": {
        authProfileOverride: "openai:later-user-profile",
        authProfileOverrideSource: "user",
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
        {},
      ),
    );
    expect(sessionStore["agent:main:main"]?.authProfileOverride).toBe("openai:later-user-profile");
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });

  it("marks a same-profile Telegram login as user-selected", async () => {
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        sessionId: "sess-main",
        updatedAt: 1,
      },
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
      createLoginResult("openai:owner@example.com"),
    );
    const { handler } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    const update = (
      loginSessionMocks.patchSessionEntry.mock.calls[0]?.[0] as {
        update?: (entry: Record<string, unknown>) => Record<string, unknown>;
      }
    )?.update;
    expect(update).toBeTypeOf("function");
    expect(
      update?.({
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        sessionId: "sess-main",
        updatedAt: 1,
      }),
    ).toEqual({
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    expect(
      update?.({
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "user",
        sessionId: "sess-main",
        updatedAt: 2,
      }),
    ).toBeNull();
  });

  it.each([
    {
      authRefresh: "refreshed",
      message:
        "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
    },
    {
      authRefresh: "gateway-rejected",
      message:
        "OpenAI credentials saved, but the Gateway could not apply the auth update. Check the Gateway logs, restart the Gateway, then use /models. Also, this Telegram session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
    },
    {
      authRefresh: "gateway-unreachable",
      message:
        "OpenAI credentials saved, but the Gateway could not be reached to apply them. Restart the Gateway, then use /models. Also, this Telegram session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
    },
  ] as const)(
    "preserves $authRefresh when Telegram cannot persist the returned session profile",
    async ({ authRefresh, message }) => {
      loginSessionMocks.loadSessionStore.mockReturnValue({
        "agent:main:main": {
          authProfileOverride: "openai:old-owner@example.com",
          sessionId: "sess-main",
          updatedAt: 1,
        },
      });
      loginSessionMocks.patchSessionEntry.mockRejectedValueOnce(new Error("write failed"));
      const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
        createLoginResult("openai:new-owner@example.com", authRefresh),
      );
      const { handler, sendMessage } = registerLoginCommand({
        accountId: "default",
        cfg: {
          commands: { native: true, ownerAllowFrom: ["200"] },
        } as OpenClawConfig,
        allowFrom: ["200"],
        loginFlow: runModelsAuthLoginFlow,
      });

      await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

      expect(sendMessage).toHaveBeenCalledWith(100, message, {});
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        expect.stringContaining("could not switch"),
        {},
      );
      expect(sendMessage).not.toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        expect.any(Object),
      );
    },
  );

  it("reports partial success when Telegram login returns no OpenAI profile", async () => {
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });

  it("revalidates an unchanged Telegram profile after device login", async () => {
    const previousEntry = {
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
      sessionId: "sess-main",
      updatedAt: 1,
    };
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": previousEntry,
    });
    loginSessionMocks.patchSessionEntry.mockImplementationOnce(async (params) => {
      const concurrentEntry = {
        ...previousEntry,
        authProfileOverride: "openai:concurrent-owner@example.com",
        updatedAt: 2,
      };
      const patch = await params.update({ ...concurrentEntry });
      params.assertCommitAllowed?.();
      return patch ? { ...concurrentEntry, ...patch } : concurrentEntry;
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
      createLoginResult("openai:owner@example.com"),
    );
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login openai/openai-device-code`, or select the profile manually.",
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });
});
