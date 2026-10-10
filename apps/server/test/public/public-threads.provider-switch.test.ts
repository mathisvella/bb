import { resolveThreadForkPoint } from "../../src/services/threads/thread-fork-history.js";
import { describe, expect, it } from "vitest";
import {
  getLastStoredProviderThreadId,
  getStoredProviderSession,
  getThread,
  getThreadExecutionOverride,
  listEvents,
  threads,
} from "@bb/db";
import { buildSwitchedProviderContext } from "../../src/services/threads/thread-provider-context.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedQueuedMessage,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function fixture(harness: TestAppHarness, status: "idle" | "active" = "idle") {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    threadId: thread.id,
    providerThreadId: "old-codex-session",
    inputText: "Keep the workspace and finish the task",
  });
  const responder = registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle: ({ command }) => {
      if (command.type === "provider.list_models")
        return {
          ok: true,
          result: {
            models: [
              {
                id: "claude-opus-5-5",
                model: "claude-opus-5-5",
                displayName: "Opus 5.5",
                description: "",
                isDefault: true,
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium", description: "" },
                ],
                defaultReasoningEffort: "medium",
              },
            ],
            selectedOnlyModels: [],
          },
        };
      if (command.type === "thread.stop")
        return { ok: true, result: { providerCheckpointId: null } };
      if (command.type === "thread.start")
        return { ok: true, result: { providerThreadId: "new-claude-session" } };
      if (command.type === "host.list_files")
        return { ok: true, result: { files: [], truncated: false } };
      if (command.type === "host.read_file")
        return { ok: false, errorCode: "ENOENT", errorMessage: "Missing" };
      throw new Error(`Unexpected command ${command.type}`);
    },
  });
  return { thread, responder };
}

function patch(harness: TestAppHarness, threadId: string, body: object) {
  return harness.app.request(`/api/v1/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("provider changes in an existing thread", () => {
  it("keeps the thread, workspace and history, retires the old session and seeds the next provider", async () => {
    await withTestHarness(async (harness) => {
      const { thread, responder } = fixture(harness);
      const oldHistory = listEvents(harness.db, { threadId: thread.id });
      const response = await patch(harness, thread.id, {
        providerId: "claude-code",
        model: "claude-opus-5-5",
        reasoningLevel: "medium",
      });
      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        id: thread.id,
        environmentId: thread.environmentId,
        providerId: "claude-code",
      });
      expect(harness.db.select().from(threads).all()).toHaveLength(1);
      expect(
        listEvents(harness.db, { threadId: thread.id }).slice(
          0,
          oldHistory.length,
        ),
      ).toEqual(oldHistory);
      expect(getLastStoredProviderThreadId(harness.db, thread.id)).toBeNull();
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: "claude-opus-5-5",
        reasoningLevelOverride: "medium",
      });
      expect(buildSwitchedProviderContext(harness.deps, thread.id)).toContain(
        "Keep the workspace and finish the task",
      );
      const sent = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Continue" }],
            mode: "start",
          }),
        },
      );
      expect(sent.status).toBe(200);
      await expect
        .poll(() =>
          responder.requests.find(
            (request) => request.command.type === "thread.start",
          ),
        )
        .toBeDefined();
      const start = responder.requests.find(
        (request) => request.command.type === "thread.start",
      )?.command;
      if (!start || start.type !== "thread.start")
        throw new Error("Expected a new provider session");
      expect(start.providerId).toBe("claude-code");
      expect(start.threadId).toBe(thread.id);
      expect(start.instructions).toContain(
        "Keep the workspace and finish the task",
      );
      expect(start.fork).toBeUndefined();
    });
  });

  it("refuses to reassign queued work to a different provider", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness);
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queued work", mentions: [] }],
      });
      const response = await patch(harness, thread.id, {
        providerId: "claude-code",
      });
      expect(response.status).toBe(409);
      expect(getThread(harness.db, thread.id)?.providerId).toBe("codex");
    });
  });

  it("retains the original ownership of retired provider sessions", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness);
      expect(
        (await patch(harness, thread.id, { providerId: "claude-code" })).status,
      ).toBe(200);
      const other = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: "codex",
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: thread.environmentId,
        threadId: other.id,
        providerThreadId: "old-codex-session",
      });
      expect(getStoredProviderSession(harness.db, other.id)).toMatchObject({
        kind: "foreign",
        claimantThreadIds: [thread.id],
      });
    });
  });

  it.each([2, 4, 5, 100])(
    "refuses provider-native forks resolving to the retired session at sequence %s",
    async (sourceSeqEnd) => {
      await withTestHarness(async (harness) => {
        const { thread } = fixture(harness);
        seedTurnStarted(harness.deps, {
          threadId: thread.id,
          environmentId: thread.environmentId,
          providerThreadId: "old-codex-session",
          turnId: "retired-turn",
          sequence: 3,
        });
        expect(
          (await patch(harness, thread.id, { providerId: "claude-code" }))
            .status,
        ).toBe(200);
        const changed = getThread(harness.db, thread.id);
        if (!changed) throw new Error("Expected the existing thread");
        expect(() =>
          resolveThreadForkPoint(harness.deps, {
            sourceThread: changed,
            sourceSeqEnd,
          }),
        ).toThrow("previous provider session");
      });
    },
  );

  it.each(["active", "invalid model", "unknown provider"])(
    "leaves the thread and old session untouched on %s",
    async (failure) => {
      await withTestHarness(async (harness) => {
        const { thread } = fixture(
          harness,
          failure === "active" ? "active" : "idle",
        );
        const response = await patch(harness, thread.id, {
          providerId:
            failure === "unknown provider" ? "missing" : "claude-code",
          model: failure === "invalid model" ? "gpt-5" : "claude-opus-5-5",
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(getThread(harness.db, thread.id)?.providerId).toBe("codex");
        expect(getLastStoredProviderThreadId(harness.db, thread.id)).toBe(
          "old-codex-session",
        );
        expect(buildSwitchedProviderContext(harness.deps, thread.id)).toBe("");
      });
    },
  );
});
