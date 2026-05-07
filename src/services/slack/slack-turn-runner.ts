import type { CodexInputItem } from "../codex/app-server-client.js";
import { CodexBroker } from "../codex/codex-broker.js";
import { logger } from "../../logger.js";
import type {
  CodexTurnResult,
  PersistedAgentTraceEvent,
  PersistedCodexTurnStatus,
  PersistedCodexTurnUsage,
  SlackInputMessage,
  SlackSessionRecord
} from "../../types.js";
import { SessionManager } from "../session-manager.js";
import { SlackApi } from "./slack-api.js";
import { formatSlackMessageForCodex } from "./slack-message-format.js";
import { SlackInboundStore } from "./slack-inbound-store.js";
import {
  isMissingCodexThreadError,
  isRecoverableCodexTurnFailure
} from "./slack-conversation-utils.js";

export class SlackTurnRunner {
  readonly #codex: CodexBroker;
  readonly #slackApi: SlackApi;
  readonly #sessions: SessionManager;
  readonly #inboundStore: SlackInboundStore;

  constructor(options: {
    readonly codex: CodexBroker;
    readonly slackApi: SlackApi;
    readonly sessions: SessionManager;
    readonly inboundStore: SlackInboundStore;
  }) {
    this.#codex = options.codex;
    this.#slackApi = options.slackApi;
    this.#sessions = options.sessions;
    this.#inboundStore = options.inboundStore;
  }

  async steerActiveTurn(session: SlackSessionRecord, item: SlackInputMessage): Promise<void> {
    const enrichedItem = await this.#enrichMentionedUsers(item);
    const sender = enrichedItem.source !== "background_job_event" && enrichedItem.source !== "recovered_thread_batch" && enrichedItem.senderKind === "user"
      ? await this.#slackApi.getUserIdentity(enrichedItem.userId)
      : null;
    const formattedMessage = formatSlackMessageForCodex(enrichedItem, sender);
    const imageItems = await this.#buildImageInputItems(enrichedItem);
    const steerInput = [
      createTextInputItem([
        enrichedItem.recoveryKind === "missed_thread_messages"
          ? "The broker detected Slack thread messages that were not previously delivered into the active turn."
          : "A newer Slack message arrived while the current turn is still active.",
        enrichedItem.recoveryKind === "missed_thread_messages"
          ? "Review the recovered batch, merge it into the current context, and decide whether you need to adjust the ongoing work or reply now."
          : "Treat it as the latest instruction and adjust the ongoing work accordingly.",
        "",
        formattedMessage
      ].join("\n")),
      ...imageItems
    ];
    await this.#codex.steer(
      session,
      steerInput
    );
    await this.#persistSteeredUserTrace(session, steerInput);
  }

  async buildTurnInput(message: SlackInputMessage): Promise<readonly CodexInputItem[]> {
    const enrichedMessage = await this.#enrichMentionedUsers(message);
    const sender = enrichedMessage.source !== "background_job_event" && enrichedMessage.source !== "recovered_thread_batch" && enrichedMessage.senderKind === "user"
      ? await this.#slackApi.getUserIdentity(enrichedMessage.userId)
      : null;
    const inputText = formatSlackMessageForCodex(enrichedMessage, sender);
    const imageItems = await this.#buildImageInputItems(enrichedMessage);
    return [
      createTextInputItem(inputText),
      ...imageItems
    ];
  }

  async steerReminder(session: SlackSessionRecord, text: string): Promise<void> {
    await this.#codex.steer(session, [createTextInputItem(text)]);
    await this.#persistRuntimeReminderTrace(session, text);
  }

  async runTurnWithRecovery(options: {
    readonly session: SlackSessionRecord;
    readonly sessionKey: string;
    readonly senderUserId: string;
    readonly input: readonly CodexInputItem[];
    readonly messageTsList: readonly string[];
  }): Promise<{
    readonly session: SlackSessionRecord;
    readonly result: CodexTurnResult;
  }> {
    let session = options.session;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedTurn = await this.#codex.startTurn(session, options.input);
      logger.debug("Codex turn started", {
        sessionKey: options.sessionKey,
        turnId: startedTurn.turnId,
        senderUserId: options.senderUserId,
        attempt: attempt + 1
      });
      session = await this.#sessions.setActiveTurnId(
        session.channelId,
        session.rootThreadTs,
        startedTurn.turnId
      );
      await this.#persistTurnStartedTrace(session, startedTurn.turnId, options.input);
      await this.#inboundStore.markMessagesInflightByTs(session, options.messageTsList, startedTurn.turnId);

      try {
        const result = await startedTurn.completion;
        logger.debug("Codex turn completed", {
          sessionKey: options.sessionKey,
          turnId: result.turnId,
          aborted: result.aborted,
          attempt: attempt + 1
        });
        await this.#persistTurnUsage(session, result);
        await this.#persistTurnCompletedTrace(session, result);
        session = await this.#inboundStore.markTurnBatchDone(session, startedTurn.turnId);
        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
        return {
          session,
          result
        };
      } catch (error) {
        const recovered = await this.#recoverTurnResult(session, startedTurn.turnId);

        if (recovered) {
          logger.warn("Recovered Codex turn result from thread snapshot after disconnect", {
            sessionKey: options.sessionKey,
            senderUserId: options.senderUserId,
            turnId: startedTurn.turnId,
            recoveredStatus: recovered.aborted ? "interrupted" : "completed"
          });
          await this.#persistTurnUsage(session, recovered);
          await this.#persistTurnCompletedTrace(session, recovered);
          session = await this.#inboundStore.markTurnBatchDone(session, startedTurn.turnId);
          session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
          return {
            session,
            result: recovered
          };
        }

        const shouldStop = attempt === 1 || !isRecoverableCodexTurnFailure(error);
        if (shouldStop) {
          await this.#persistMissingTurnUsage(session, startedTurn.turnId, "failed");
          await this.#persistFailedTurnTrace(session, startedTurn.turnId, error);
        }

        await this.#inboundStore.resetTurnBatchToPending(session, startedTurn.turnId);
        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);

        if (shouldStop) {
          throw error;
        }

        logger.warn("Codex turn lost during app-server disconnect; retrying once", {
          sessionKey: options.sessionKey,
          senderUserId: options.senderUserId,
          error: error instanceof Error ? error.message : String(error)
        });
        session = await this.#ensureCodexThreadInternal(session);
      }
    }

    throw new Error("Codex turn retry exhausted unexpectedly");
  }

  async readTurnSnapshot(
    session: SlackSessionRecord,
    turnId: string,
    options?: {
      readonly syncActiveTurn?: boolean | undefined;
      readonly treatMissingAsStale?: boolean | undefined;
    }
  ) {
    return await this.#codex.readTurnResult(session, turnId, options);
  }

  async ensureCodexThread(session: SlackSessionRecord): Promise<SlackSessionRecord> {
    return await this.#ensureCodexThreadInternal(session);
  }

  async interrupt(session: SlackSessionRecord): Promise<void> {
    await this.#codex.interrupt(session);
  }

  async #ensureCodexThreadInternal(session: SlackSessionRecord): Promise<SlackSessionRecord> {
    if (session.codexThreadId) {
      try {
        await this.#codex.ensureThread(session);
        return session;
      } catch (error) {
        if (!isMissingCodexThreadError(error)) {
          throw error;
        }

        logger.warn("Stored Codex thread id no longer exists; resetting broker session thread state", {
          sessionKey: session.key,
          codexThreadId: session.codexThreadId,
          error: error instanceof Error ? error.message : String(error)
        });

        session = await this.#sessions.setActiveTurnId(session.channelId, session.rootThreadTs, undefined);
        session = await this.#sessions.setCodexThreadId(session.channelId, session.rootThreadTs, undefined);
      }
    }

    const codexThreadId = await this.#codex.ensureThread(session);
    return await this.#sessions.setCodexThreadId(session.channelId, session.rootThreadTs, codexThreadId);
  }

  async #buildImageInputItems(message: SlackInputMessage): Promise<readonly CodexInputItem[]> {
    const images = [
      ...(message.images ?? []),
      ...((message.batchMessages ?? []).flatMap((entry) => entry.images ?? []))
    ];
    if (images.length === 0) {
      return [];
    }

    const downloaded = await Promise.allSettled(
      images.map(async (image) => ({
        type: "image" as const,
        url: await this.#slackApi.downloadImageAsDataUrl(image),
        fileId: image.fileId
      }))
    );

    return downloaded.flatMap((result) => {
      if (result.status === "fulfilled") {
        return [
          {
            type: "image" as const,
            url: result.value.url
          }
        ];
      }

      logger.warn("Failed to download Slack image attachment for Codex input", {
        source: message.source,
        channelId: message.channelId,
        rootThreadTs: message.rootThreadTs,
        messageTs: message.messageTs,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      });
      return [];
    });
  }

  async #enrichMentionedUsers(message: SlackInputMessage): Promise<SlackInputMessage> {
    if (message.mentionedUsers || !message.mentionedUserIds || message.mentionedUserIds.length === 0) {
      return message;
    }

    const mentionedUsers = (
      await Promise.all(message.mentionedUserIds.map((userId) => this.#slackApi.getUserIdentity(userId)))
    ).filter((user): user is NonNullable<typeof user> => user !== null);

    if (mentionedUsers.length === 0) {
      return message;
    }

    return {
      ...message,
      mentionedUsers
    };
  }

  async #recoverTurnResult(
    session: SlackSessionRecord,
    turnId: string
  ): Promise<CodexTurnResult | null> {
    try {
      const snapshot = await this.#codex.readTurnResult(session, turnId, {
        syncActiveTurn: true
      });

      if (!snapshot) {
        return null;
      }

      if (snapshot.status === "completed") {
        return {
          threadId: session.codexThreadId ?? "",
          turnId,
          finalMessage: snapshot.finalMessage,
          aborted: false,
          generatedImages: snapshot.generatedImages,
          usage: snapshot.usage
        };
      }

      if (snapshot.status === "interrupted") {
        return {
          threadId: session.codexThreadId ?? "",
          turnId,
          finalMessage: snapshot.finalMessage,
          aborted: true,
          generatedImages: snapshot.generatedImages,
          usage: snapshot.usage
        };
      }

      if (snapshot.status === "failed") {
        throw new Error(snapshot.errorMessage ?? "Codex turn failed");
      }

      return null;
    } catch (error) {
      logger.warn("Failed to recover Codex turn result from thread snapshot", {
        sessionKey: session.key,
        turnId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  async #persistTurnUsage(session: SlackSessionRecord, result: CodexTurnResult): Promise<void> {
    const status: PersistedCodexTurnStatus = result.aborted ? "interrupted" : "completed";
    const usage = result.usage;
    await this.#upsertTurnUsage({
      turnId: result.turnId,
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      codexThreadId: result.threadId || session.codexThreadId,
      status,
      source: usage?.source ?? "missing",
      model: usage?.model,
      effort: usage?.effort,
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      rawUsage: usage?.rawUsage,
      startedAt: session.activeTurnId === result.turnId ? session.activeTurnStartedAt : undefined
    });
  }

  async #persistMissingTurnUsage(
    session: SlackSessionRecord,
    turnId: string,
    status: PersistedCodexTurnStatus
  ): Promise<void> {
    await this.#upsertTurnUsage({
      turnId,
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      codexThreadId: session.codexThreadId,
      status,
      source: "missing",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      startedAt: session.activeTurnId === turnId ? session.activeTurnStartedAt : undefined
    });
  }

  async #upsertTurnUsage(record: Omit<PersistedCodexTurnUsage, "createdAt" | "updatedAt" | "completedAt">): Promise<void> {
    const upsert = (this.#sessions as unknown as {
      readonly upsertCodexTurnUsage?: ((usage: PersistedCodexTurnUsage) => Promise<void>) | undefined;
    }).upsertCodexTurnUsage;
    if (typeof upsert !== "function") {
      return;
    }

    const now = new Date().toISOString();
    await upsert.call(this.#sessions, {
      ...record,
      completedAt: now,
      createdAt: record.startedAt ?? now,
      updatedAt: now
    });
  }

  async #persistTurnStartedTrace(
    session: SlackSessionRecord,
    turnId: string,
    input: readonly CodexInputItem[]
  ): Promise<void> {
    const at = session.activeTurnStartedAt ?? new Date().toISOString();
    const baseSequence = traceSequence(at);
    await this.#upsertAgentTraceEvent(session, {
      id: traceEventId(session, "broker", turnId, "turn_started"),
      source: "broker",
      type: "agent_turn_started",
      at,
      sequence: baseSequence,
      title: "回合开始",
      summary: "开始处理 Slack 输入",
      status: "running",
      turnId
    });

    const textInputs = input.filter((item): item is Extract<CodexInputItem, { type: "text" }> => item.type === "text");
    for (const [index, item] of textInputs.entries()) {
      const detail = truncateTraceDetail(item.text);
      await this.#upsertAgentTraceEvent(session, {
        id: traceEventId(session, "broker", turnId, `user_${index}`),
        source: "broker",
        type: "agent_user_message",
        at,
        sequence: baseSequence + index + 1,
        title: "用户消息",
        summary: summarizeTraceText(item.text),
        detail: detail.text,
        detailTruncated: detail.truncated,
        detailOriginalChars: detail.originalChars,
        status: "received",
        role: "user",
        turnId
      });
    }
  }

  async #persistSteeredUserTrace(
    session: SlackSessionRecord,
    input: readonly CodexInputItem[]
  ): Promise<void> {
    const turnId = session.activeTurnId ?? "active";
    const at = new Date().toISOString();
    const baseSequence = traceSequence(at);
    const textInputs = input.filter((item): item is Extract<CodexInputItem, { type: "text" }> => item.type === "text");
    for (const [index, item] of textInputs.entries()) {
      const detail = truncateTraceDetail(item.text);
      await this.#upsertAgentTraceEvent(session, {
        id: traceEventId(session, "broker", turnId, `steer_user_${baseSequence}_${index}`),
        source: "broker",
        type: "agent_user_message",
        at,
        sequence: baseSequence + index,
        title: "用户追发消息",
        summary: summarizeTraceText(item.text),
        detail: detail.text,
        detailTruncated: detail.truncated,
        detailOriginalChars: detail.originalChars,
        status: "received",
        role: "user",
        turnId: session.activeTurnId
      });
    }
  }

  async #persistRuntimeReminderTrace(session: SlackSessionRecord, text: string): Promise<void> {
    const at = new Date().toISOString();
    const sequence = traceSequence(at);
    const detail = truncateTraceDetail(text);
    await this.#upsertAgentTraceEvent(session, {
      id: traceEventId(session, "broker", session.activeTurnId ?? "active", `runtime_reminder_${sequence}`),
      source: "broker",
      type: "agent_runtime_reminder",
      at,
      sequence,
      title: "Runtime 提醒",
      summary: summarizeTraceText(text),
      detail: detail.text,
      detailTruncated: detail.truncated,
      detailOriginalChars: detail.originalChars,
      status: "sent",
      role: "system",
      turnId: session.activeTurnId
    });
  }

  async #persistTurnCompletedTrace(session: SlackSessionRecord, result: CodexTurnResult): Promise<void> {
    const at = new Date().toISOString();
    const baseSequence = traceSequence(at);
    const finalMessage = result.finalMessage.trim();
    if (finalMessage) {
      const detail = truncateTraceDetail(finalMessage);
      await this.#upsertAgentTraceEvent(session, {
        id: traceEventId(session, "broker", result.turnId, "assistant_final"),
        source: "broker",
        type: "agent_assistant_message",
        at,
        sequence: baseSequence,
        title: "Assistant 消息",
        summary: summarizeTraceText(finalMessage),
        detail: detail.text,
        detailTruncated: detail.truncated,
        detailOriginalChars: detail.originalChars,
        status: result.aborted ? "interrupted" : "completed",
        role: "assistant",
        turnId: result.turnId
      });
    }

    await this.#upsertAgentTraceEvent(session, {
      id: traceEventId(session, "broker", result.turnId, "turn_completed"),
      source: "broker",
      type: "agent_turn_completed",
      at,
      sequence: baseSequence + 1,
      title: "回合结束",
      summary: result.aborted ? "回合已中断" : "回合已完成",
      status: result.aborted ? "interrupted" : "completed",
      turnId: result.turnId
    });
  }

  async #persistFailedTurnTrace(session: SlackSessionRecord, turnId: string, error: unknown): Promise<void> {
    const at = new Date().toISOString();
    await this.#upsertAgentTraceEvent(session, {
      id: traceEventId(session, "broker", turnId, "turn_failed"),
      source: "broker",
      type: "agent_turn_completed",
      at,
      sequence: traceSequence(at),
      title: "回合失败",
      summary: error instanceof Error ? error.message : String(error),
      status: "failed",
      turnId
    });
  }

  async #upsertAgentTraceEvent(
    session: SlackSessionRecord,
    event: Omit<PersistedAgentTraceEvent, "sessionKey" | "createdAt" | "updatedAt">
  ): Promise<void> {
    const upsert = (this.#sessions as unknown as {
      readonly upsertAgentTraceEvent?: ((record: PersistedAgentTraceEvent) => Promise<void>) | undefined;
    }).upsertAgentTraceEvent;
    if (typeof upsert !== "function") {
      return;
    }

    const now = new Date().toISOString();
    await upsert.call(this.#sessions, {
      ...event,
      sessionKey: session.key,
      createdAt: now,
      updatedAt: now
    });
  }
}

function createTextInputItem(text: string): CodexInputItem {
  return {
    type: "text",
    text,
    text_elements: []
  };
}

const TRACE_DETAIL_LIMIT = 50_000;

function traceSequence(at: string): number {
  const parsed = Date.parse(at);
  return (Number.isFinite(parsed) ? parsed : Date.now()) * 1000;
}

function traceEventId(session: SlackSessionRecord, source: PersistedAgentTraceEvent["source"], scope: string, kind: string): string {
  return `${session.key}:${source}:${scope}:${kind}`;
}

function summarizeTraceText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function truncateTraceDetail(text: string): {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
} {
  if (text.length <= TRACE_DETAIL_LIMIT) {
    return {
      text,
      truncated: false,
      originalChars: text.length
    };
  }
  return {
    text: text.slice(0, TRACE_DETAIL_LIMIT),
    truncated: true,
    originalChars: text.length
  };
}
