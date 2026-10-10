import {
  createEventId,
  getEnvironment,
  getThread,
  listQueuedThreadMessages,
  setThreadExecutionOverride,
  updateThread,
} from "@bb/db";
import { threadScope, type ReasoningLevel, type Thread } from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolveSystemExecutionOptionsForValidation } from "../system/execution-options.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import { resolveThreadExecutionOverrideUpdate } from "./thread-execution-override.js";

export async function switchThreadProvider(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    thread: Thread;
    providerId: string;
    model?: string | null;
    reasoningLevel?: ReasoningLevel | null;
  },
): Promise<NonNullable<ReturnType<typeof getThread>>> {
  return withThreadContextClearGuard(args.thread.id, async () => {
    const thread = getThread(deps.db, args.thread.id);
    if (!thread)
      throw new ApiError(404, "thread_not_found", "Thread not found");
    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      (thread.status !== "idle" && thread.status !== "error")
    ) {
      throw new ApiError(
        409,
        "invalid_request",
        "Wait for the current turn to finish before switching providers",
      );
    }
    if (
      deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(thread.id)
    ) {
      throw new ApiError(
        409,
        "awaiting_user_interaction",
        "Resolve the pending interaction before switching providers",
      );
    }
    if (listQueuedThreadMessages(deps.db, thread.id).length > 0) {
      throw new ApiError(
        409,
        "invalid_request",
        "Send or remove queued messages before switching providers",
      );
    }
    const environment = thread.environmentId
      ? getEnvironment(deps.db, thread.environmentId)
      : null;
    if (!environment || environment.status !== "ready")
      throw new ApiError(
        409,
        "invalid_request",
        "Thread workspace must be ready before switching providers",
      );
    const catalog = await resolveSystemExecutionOptionsForValidation(
      deps,
      { environmentId: environment.id, providerId: args.providerId },
      args.model ?? null,
    );
    if (
      !catalog.providers.some(
        (provider) => provider.id === args.providerId && provider.available,
      ) ||
      catalog.modelLoadError !== null
    ) {
      throw new ApiError(
        503,
        "model_catalog_unavailable",
        "The selected provider's model catalog is unavailable",
      );
    }
    const models = [...catalog.models, ...catalog.selectedOnlyModels];
    const model =
      args.model ??
      catalog.models.find((candidate) => candidate.isDefault)?.model ??
      catalog.models[0]?.model;
    if (!model)
      throw new ApiError(
        503,
        "model_catalog_unavailable",
        "The selected provider offers no models",
      );
    const next = resolveThreadExecutionOverrideUpdate(deps.providerRegistry, {
      existing: { modelOverride: null, reasoningLevelOverride: null },
      patch: { model, reasoningLevel: args.reasoningLevel ?? null },
      models,
      providerId: args.providerId,
      fallbackModel: model,
    });
    await stopThreadForCurrentState(deps, thread, environment, {
      requireStopped: true,
    });
    const current = getThread(deps.db, thread.id);
    if (!current || (current.status !== "idle" && current.status !== "error"))
      throw new ApiError(
        409,
        "invalid_request",
        "Thread became active while switching providers",
      );
    if (
      current.archivedAt !== null ||
      current.deletedAt !== null ||
      current.environmentId !== environment.id ||
      listQueuedThreadMessages(deps.db, thread.id).length > 0
    ) {
      throw new ApiError(
        409,
        "invalid_request",
        "Thread changed while switching providers; try again",
      );
    }
    return deps.db.transaction((tx) => {
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "system/operation",
        scope: threadScope(),
        data: {
          operation: "provider_switch",
          operationId: createEventId(),
          status: "completed",
          message: `Switched from ${thread.providerId} to ${args.providerId}. Conversation history and workspace retained.`,
          metadata: {
            fromProviderId: thread.providerId,
            toProviderId: args.providerId,
          },
        },
      });
      setThreadExecutionOverride(tx, { threadId: thread.id, ...next });
      const updated = updateThread(tx, deps.hub, thread.id, {
        providerId: args.providerId,
      });
      if (!updated)
        throw new ApiError(404, "thread_not_found", "Thread not found");
      return updated;
    });
  });
}
