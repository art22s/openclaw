// Names newly created Discord threads from their first user/agent conversation.
import { MessageType, PermissionFlagsBits, type APIMessage } from "discord-api-types/v10";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/config-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveDiscordAccountConfig } from "../accounts.js";
import { editChannel, getChannel, type Client } from "../internal/discord.js";
import { getDiscordRuntime } from "../runtime.js";
import { hasAnyChannelPermissionDiscord } from "../send.permissions.js";
import { generateThreadTitle } from "./thread-title.js";

const DEFAULT_MESSAGE_THRESHOLD = 5;
const MAX_TRACKED_THREADS = 10_000;
const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 350;
const MAX_TRANSCRIPT_CHARS = 1_800;
const RENAME_WINDOW_MS = 10 * 60_000;

type ThreadCreateEvent = {
  id: string;
  guild_id?: string;
  parent_id?: string | null;
  name?: string | null;
  newly_created?: boolean;
};

type ThreadState = {
  guildId: string;
  parentId: string;
  originalName: string;
  count: number;
  seenMessages: Set<string>;
  transcript: string[];
  claimed: boolean;
  canceled: boolean;
};

export function resolveDiscordThreadAutoNameThreshold(
  cfg: OpenClawConfig,
  accountId: string,
): number {
  const value =
    resolveDiscordAccountConfig(cfg, accountId)?.thread?.autoName ??
    cfg.channels?.discord?.thread?.autoName ??
    false;
  return value === true ? DEFAULT_MESSAGE_THRESHOLD : value === false ? 0 : value;
}

export function sanitizeDiscordAutoNameTitle(raw: string): string | null {
  const title = raw
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\*|_|~|`|>|#|\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(title, 100).trim() || null;
}

function isConversationMessage(message: APIMessage, botUserId: string): boolean {
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) {
    return false;
  }
  if (message.author.bot && message.author.id !== botUserId) {
    return false;
  }
  return Boolean(
    message.content?.trim() ||
    message.attachments?.length ||
    message.embeds?.length ||
    message.sticker_items?.length,
  );
}

function formatTranscriptLine(message: APIMessage, botUserId: string): string {
  const role = message.author.id === botUserId ? "Agent" : "User";
  const content = message.content?.replace(/\s+/g, " ").trim() || "[attachment]";
  return `${role}: ${truncateUtf16Safe(content, MAX_MESSAGE_CHARS)}`;
}

function buildTranscript(lines: string[]): string {
  const selected: string[] = [];
  let remaining = MAX_TRANSCRIPT_CHARS;
  for (let index = lines.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    selected.unshift(truncateUtf16Safe(line, remaining));
    remaining -= line.length + 1;
  }
  return selected.join("\n");
}

export class DiscordThreadAutoNamer {
  private readonly threads = new Map<string, ThreadState>();
  private readonly renamesByParent = new Map<string, number[]>();
  private readonly threshold: number;
  private readonly claimedStore: PluginStateSyncKeyedStore<boolean>;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      accountId: string;
      botUserId: string;
      claimedStore?: PluginStateSyncKeyedStore<boolean>;
      nowMs?: () => number;
    },
  ) {
    this.threshold = resolveDiscordThreadAutoNameThreshold(params.cfg, params.accountId);
    this.claimedStore =
      params.claimedStore ??
      getDiscordRuntime().state.openSyncKeyedStore<boolean>({
        namespace: "thread-auto-name-claims",
        maxEntries: 100_000,
        overflowPolicy: "reject-new",
      });
  }

  get enabled(): boolean {
    return this.threshold > 0;
  }

  onThreadCreate(data: ThreadCreateEvent): void {
    if (!this.enabled || data.newly_created === false || !data.parent_id || !data.guild_id) {
      return;
    }
    const key = this.key(data.id);
    if (this.claimedStore.lookup(key) || this.threads.has(data.id)) {
      return;
    }
    this.threads.set(data.id, {
      guildId: data.guild_id,
      parentId: data.parent_id,
      originalName: data.name ?? "",
      count: 0,
      seenMessages: new Set(),
      transcript: [],
      claimed: false,
      canceled: false,
    });
    pruneMapToMaxSize(this.threads, MAX_TRACKED_THREADS);
  }

  onThreadUpdate(data: { id: string; name?: string | null }): void {
    const state = this.threads.get(data.id);
    if (state && data.name && data.name !== state.originalName) {
      state.claimed = true;
      state.canceled = true;
      this.claimedStore.registerIfAbsent(this.key(data.id), true);
      this.threads.delete(data.id);
    }
  }

  onThreadDelete(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state) {
      state.canceled = true;
    }
    this.threads.delete(threadId);
  }

  onMessage(message: APIMessage, client: Client): Promise<void> | undefined {
    const state = this.threads.get(message.channel_id);
    if (!state || state.claimed || state.seenMessages.has(message.id)) {
      return undefined;
    }
    if (!isConversationMessage(message, this.params.botUserId)) {
      return undefined;
    }
    state.seenMessages.add(message.id);
    state.count += 1;
    state.transcript.push(formatTranscriptLine(message, this.params.botUserId));
    if (state.transcript.length > MAX_TRANSCRIPT_MESSAGES) {
      state.transcript.shift();
    }
    if (state.count < this.threshold) {
      return undefined;
    }
    state.claimed = true;
    try {
      if (!this.claimedStore.registerIfAbsent(this.key(message.channel_id), true)) {
        this.threads.delete(message.channel_id);
        return undefined;
      }
    } catch {
      // Without a durable claim, a restart could rename the same thread again.
      this.threads.delete(message.channel_id);
      return undefined;
    }
    return this.renameThread(message.channel_id, state, client);
  }

  private key(threadId: string): string {
    return `${this.params.accountId}:${threadId}`;
  }

  private async canRename(state: ThreadState, threadId: string, client: Client): Promise<boolean> {
    return await hasAnyChannelPermissionDiscord(
      state.guildId,
      threadId,
      this.params.botUserId,
      [PermissionFlagsBits.ManageThreads],
      { cfg: this.params.cfg, accountId: this.params.accountId, rest: client.rest },
    );
  }

  private reserveRename(parentId: string): boolean {
    const now = this.params.nowMs?.() ?? Date.now();
    const recent = (this.renamesByParent.get(parentId) ?? []).filter(
      (at) => now - at < RENAME_WINDOW_MS,
    );
    if (recent.length >= 2) {
      return false;
    }
    recent.push(now);
    this.renamesByParent.set(parentId, recent);
    pruneMapToMaxSize(this.renamesByParent, MAX_TRACKED_THREADS);
    return true;
  }

  private async renameThread(threadId: string, state: ThreadState, client: Client): Promise<void> {
    try {
      if (!(await this.canRename(state, threadId, client))) {
        return;
      }
      const generated = await generateThreadTitle({
        cfg: this.params.cfg,
        agentId: resolveDefaultAgentId(this.params.cfg),
        messageText: buildTranscript(state.transcript),
        maxSourceChars: MAX_TRANSCRIPT_CHARS,
        timeoutMs: 15_000,
      });
      const title = generated && sanitizeDiscordAutoNameTitle(generated);
      if (!title || title === state.originalName || state.canceled) {
        return;
      }
      // Authority and rate capacity are checked after the model turn, immediately before PATCH.
      if (!(await this.canRename(state, threadId, client)) || state.canceled) {
        return;
      }
      const current = await getChannel(client.rest, threadId);
      if (!("name" in current) || current.name !== state.originalName || state.canceled) {
        return;
      }
      if (!this.reserveRename(state.parentId)) {
        return;
      }
      await editChannel(client.rest, threadId, { body: { name: title } });
    } catch (error) {
      // Discord may still return 403/429 when permissions or its shared bucket change.
      // The durable claim prevents repeated PATCH attempts or gateway crashes.
      const status =
        (error as { status?: unknown; statusCode?: unknown })?.status ??
        (error as { statusCode?: unknown })?.statusCode;
      if (status !== 403 && status !== 429) {
        logVerbose(`discord: thread auto-name failed for ${threadId}`);
      }
    } finally {
      if (this.threads.get(threadId) === state) {
        this.threads.delete(threadId);
      }
    }
  }
}
