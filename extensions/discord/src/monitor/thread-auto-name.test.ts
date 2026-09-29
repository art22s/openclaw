import type { APIMessage } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";

const { editChannelMock, getChannelMock, generateThreadTitleMock, hasPermissionMock } = vi.hoisted(
  () => ({
    editChannelMock: vi.fn(),
    getChannelMock: vi.fn(),
    generateThreadTitleMock: vi.fn(),
    hasPermissionMock: vi.fn(),
  }),
);

vi.mock("../internal/discord.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../internal/discord.js")>()),
  editChannel: editChannelMock,
  getChannel: getChannelMock,
}));
vi.mock("../send.permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.permissions.js")>()),
  hasAnyChannelPermissionDiscord: hasPermissionMock,
}));
vi.mock("./thread-title.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-title.js")>()),
  generateThreadTitle: generateThreadTitleMock,
}));

import {
  DiscordThreadAutoNamer,
  resolveDiscordThreadAutoNameThreshold,
  sanitizeDiscordAutoNameTitle,
} from "./thread-auto-name.js";
import {
  DiscordAutoNameMessageCreateListener,
  DiscordAutoNameThreadCreateListener,
} from "./thread-auto-name.listeners.js";

const client = { rest: {} } as Client;

function config(autoName?: number | boolean, workAutoName?: number | boolean): OpenClawConfig {
  return {
    channels: {
      discord: {
        thread: autoName === undefined ? undefined : { autoName },
        accounts:
          workAutoName === undefined ? undefined : { work: { thread: { autoName: workAutoName } } },
      },
    },
  } as OpenClawConfig;
}

function store(): PluginStateSyncKeyedStore<boolean> {
  const values = new Map<string, boolean>();
  return {
    lookup: (key) => values.get(key),
    registerIfAbsent: (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
  } as PluginStateSyncKeyedStore<boolean>;
}

function message(id: string, channelId: string, authorId = "user", bot = false): APIMessage {
  return {
    id,
    channel_id: channelId,
    author: { id: authorId, bot },
    type: 0,
    content: `Message ${id}`,
  } as APIMessage;
}

function createThread(namer: DiscordThreadAutoNamer, id: string, parentId = "parent"): void {
  namer.onThreadCreate({
    id,
    parent_id: parentId,
    guild_id: "guild",
    name: "Untitled",
    newly_created: true,
  });
}

beforeEach(() => {
  editChannelMock.mockReset().mockResolvedValue({});
  getChannelMock.mockReset().mockResolvedValue({ name: "Untitled" });
  generateThreadTitleMock.mockReset().mockResolvedValue("Release planning");
  hasPermissionMock.mockReset().mockResolvedValue(true);
});

describe("Discord thread auto-naming", () => {
  it("resolves disabled defaults, true, numeric thresholds, and account overrides", () => {
    expect(resolveDiscordThreadAutoNameThreshold(config(), "default")).toBe(0);
    expect(resolveDiscordThreadAutoNameThreshold(config(true), "default")).toBe(5);
    expect(resolveDiscordThreadAutoNameThreshold(config(3), "default")).toBe(3);
    expect(resolveDiscordThreadAutoNameThreshold(config(3, false), "work")).toBe(0);
    expect(resolveDiscordThreadAutoNameThreshold(config(3, 7), "work")).toBe(7);
  });

  it("removes Discord markup and controls and stays within 100 UTF-16 characters", () => {
    expect(sanitizeDiscordAutoNameTitle("**Deploy**\n<@123> `plan`\u0000 #now")).toBe(
      "Deploy plan now",
    );
    expect(sanitizeDiscordAutoNameTitle("*#`\n")).toBeNull();
    expect(sanitizeDiscordAutoNameTitle(`${"a".repeat(99)}😀tail`)).toBe("a".repeat(99));
  });

  it("generates from the first two user/agent messages and claims the thread once", async () => {
    const claims = store();
    const namer = new DiscordThreadAutoNamer({
      cfg: config(2),
      accountId: "default",
      botUserId: "bot",
      claimedStore: claims,
    });
    createThread(namer, "thread");
    expect(namer.onMessage(message("m1", "thread"), client)).toBeUndefined();
    expect(namer.onMessage(message("m1", "thread"), client)).toBeUndefined();
    expect(namer.onMessage(message("other", "thread", "other-bot", true), client)).toBeUndefined();
    await namer.onMessage(message("m2", "thread", "bot", true), client);
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageText: "User: Message m1\nAgent: Message m2",
        maxSourceChars: 1800,
      }),
    );
    expect(editChannelMock).toHaveBeenCalledExactlyOnceWith(client.rest, "thread", {
      body: { name: "Release planning" },
    });
    expect(namer.onMessage(message("m3", "thread"), client)).toBeUndefined();
    const restarted = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: claims,
    });
    createThread(restarted, "thread");
    expect(restarted.onMessage(message("m4", "thread"), client)).toBeUndefined();
    expect(editChannelMock).toHaveBeenCalledTimes(1);
  });

  it("skips a thread renamed by another actor", async () => {
    const namer = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: store(),
    });
    createThread(namer, "thread");
    namer.onThreadUpdate({ id: "thread", name: "Manual title" });
    await namer.onMessage(message("m1", "thread"), client);
    expect(generateThreadTitleMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a manual rename made during title generation", async () => {
    let resolveTitle: (value: string) => void = () => {};
    generateThreadTitleMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveTitle = resolve;
        }),
    );
    const namer = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: store(),
    });
    createThread(namer, "thread");
    const pending = namer.onMessage(message("m1", "thread"), client);
    await vi.waitFor(() => expect(generateThreadTitleMock).toHaveBeenCalledTimes(1));
    namer.onThreadUpdate({ id: "thread", name: "Manual title" });
    resolveTitle("AI title");
    await pending;
    expect(editChannelMock).not.toHaveBeenCalled();
  });

  it("rechecks the current Discord name before patching", async () => {
    getChannelMock.mockResolvedValueOnce({ name: "Manual title" });
    const namer = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: store(),
    });
    createThread(namer, "thread");
    await namer.onMessage(message("m1", "thread"), client);
    expect(editChannelMock).not.toHaveBeenCalled();
  });

  it("receives thread creation and messages through gateway listeners", async () => {
    const namer = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: store(),
    });
    const created = new DiscordAutoNameThreadCreateListener(namer);
    const messages = new DiscordAutoNameMessageCreateListener(namer);
    expect(created.type).toBe("THREAD_CREATE");
    expect(messages.type).toBe("MESSAGE_CREATE");
    created.handle({
      id: "thread",
      parent_id: "parent",
      guild_id: "guild",
      name: "Untitled",
      newly_created: true,
      type: 11,
    } as Parameters<typeof created.handle>[0]);
    messages.handle(message("m1", "thread"), client);
    await vi.waitFor(() => expect(editChannelMock).toHaveBeenCalledTimes(1));
  });

  it("allows only two rename attempts per parent in ten minutes", async () => {
    let now = 10_000;
    const namer = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: store(),
      nowMs: () => now,
    });
    for (const id of ["one", "two", "three"]) {
      createThread(namer, id);
      await namer.onMessage(message(`m-${id}`, id), client);
    }
    expect(editChannelMock).toHaveBeenCalledTimes(2);
    now += 10 * 60_000;
    createThread(namer, "four");
    await namer.onMessage(message("m-four", "four"), client);
    expect(editChannelMock).toHaveBeenCalledTimes(3);
  });

  it("skips silently without Manage Threads permission", async () => {
    hasPermissionMock.mockResolvedValue(false);
    const namer = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: store(),
    });
    createThread(namer, "thread");
    await namer.onMessage(message("m1", "thread"), client);
    expect(generateThreadTitleMock).not.toHaveBeenCalled();
    expect(editChannelMock).not.toHaveBeenCalled();
  });

  it("rechecks permission after title generation and does not patch after revocation", async () => {
    hasPermissionMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const namer = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: store(),
    });
    createThread(namer, "thread");
    await namer.onMessage(message("m1", "thread"), client);
    expect(generateThreadTitleMock).toHaveBeenCalledTimes(1);
    expect(editChannelMock).not.toHaveBeenCalled();
  });

  it("treats Discord 429 as a skipped one-time attempt", async () => {
    editChannelMock.mockRejectedValueOnce({ status: 429 });
    const namer = new DiscordThreadAutoNamer({
      cfg: config(1),
      accountId: "default",
      botUserId: "bot",
      claimedStore: store(),
    });
    createThread(namer, "thread");
    await expect(namer.onMessage(message("m1", "thread"), client)).resolves.toBeUndefined();
    await namer.onMessage(message("m2", "thread"), client);
    expect(editChannelMock).toHaveBeenCalledTimes(1);
  });
});
