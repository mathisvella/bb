import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { environments, events, getThread, threads } from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { loadFailedTurn, retryChain } from "./turn-failed.js";
import { retryFailedTurn } from "./turn-retry.js";

const AUTO_RESUME_WINDOW_MS = 24 * 60 * 60 * 1_000;
const AUTO_RESUME_SPACING_MS = 30_000;
const MAX_AUTO_RESUME_THREADS = 50;
const MAX_AUTO_RESUME_ATTEMPTS = 3;

export async function queueHostInterruptedThreadResumes(
  deps: LoggedPendingInteractionWorkSessionDeps,
  hostId: string,
): Promise<void> {
  const interrupted = deps.db
    .select({ threadId: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .innerJoin(events, eq(events.threadId, threads.id))
    .where(
      and(
        eq(environments.hostId, hostId),
        eq(threads.status, "error"),
        isNull(threads.deletedAt),
        isNull(threads.archivedAt),
        eq(events.type, "system/thread/interrupted"),
        gte(events.createdAt, Date.now() - AUTO_RESUME_WINDOW_MS),
        sql`json_extract(${events.data}, '$.reason') = 'host-daemon-restarted'`,
        sql`${events.sequence} = (
          SELECT MAX(latest.sequence)
          FROM events AS latest
          WHERE latest.thread_id = ${events.threadId}
        )`,
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(MAX_AUTO_RESUME_THREADS)
    .all();

  let scheduled = 0;
  for (const { threadId } of interrupted) {
    const thread = getThread(deps.db, threadId);
    if (thread?.status !== "error") {
      continue;
    }
    const failed = loadFailedTurn(deps.db, threadId);
    if (failed === null || retryChain(failed.request).attemptNumber >= MAX_AUTO_RESUME_ATTEMPTS) {
      continue;
    }
    try {
      await retryFailedTurn(deps, {
        thread,
        request: {
          turnRequestId: failed.request.requestId,
          sendAt: Date.now() + (scheduled + 1) * AUTO_RESUME_SPACING_MS,
          reason: "Host restarted",
        },
      });
      scheduled += 1;
    } catch (error) {
      deps.logger.warn({ error, hostId, threadId }, "Could not queue interrupted thread resume");
    }
  }
  if (scheduled > 0) {
    deps.logger.info({ hostId, scheduled }, "Queued interrupted threads to resume after host reconnect");
  }
}
