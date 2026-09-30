import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  ProviderUsageResult,
  ProviderUsageWindow,
} from "@bb/provider-bridge-protocol";
import type { AcpLaunchSpec } from "../launch-spec.js";

export function customUsageKind(
  launch: AcpLaunchSpec,
): "claude" | "openrouter" | null {
  const executable = path
    .basename(launch.command)
    .replace(/\.(?:cmd|exe)$/iu, "");
  if (executable === "claude-agent-acp" && launch.env.CLAUDE_CONFIG_DIR?.trim())
    return "claude";
  if (executable !== "opencode") return null;
  try {
    const config = z
      .object({ enabled_providers: z.tuple([z.literal("openrouter")]) })
      .parse(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT ?? "{}"));
    return config.enabled_providers[0];
  } catch {
    return null;
  }
}

async function jsonFile(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch {
    return null;
  }
}

const credentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
    rateLimitTier: z.string().nullish(),
  }),
});
const accountSchema = z.object({
  oauthAccount: z
    .object({
      emailAddress: z.string().email().nullish(),
      accountUuid: z.string().min(1).nullish(),
    })
    .nullish(),
});
const quotaSchema = z.object({
  utilization: z.number().finite().nonnegative().nullish(),
  resets_at: z.string().nullish(),
});
const claudeUsageSchema = z.object({
  five_hour: quotaSchema.nullish(),
  seven_day: quotaSchema.nullish(),
  limits: z
    .array(
      z
        .object({
          kind: z.string(),
          percent: z.number().finite().nonnegative().nullish(),
          resets_at: z.string().nullish(),
          scope: z
            .object({
              model: z.object({ display_name: z.string().min(1) }).nullish(),
            })
            .nullish(),
        })
        .nullable(),
    )
    .nullish(),
});
const authSchema = z.object({
  openrouter: z.object({ type: z.literal("api"), key: z.string().min(1) }),
});
const keySchema = z.object({
  data: z.object({
    usage: z.number().finite().nonnegative(),
    limit: z.number().finite().nonnegative().nullable(),
    limit_remaining: z.number().finite().nullable().optional(),
  }),
});

function reset(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function requestUsage(
  url: string,
  token: string,
  fetchUsage: typeof fetch,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetchUsage(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function readCustomProviderUsage(
  launch: AcpLaunchSpec,
  fetchUsage: typeof fetch = fetch,
): Promise<ProviderUsageResult> {
  const kind = customUsageKind(launch);
  if (kind === null) return { supported: false };
  const env = { ...process.env, ...launch.env };
  const home = env.HOME || os.homedir();
  try {
    if (kind === "claude") {
      const directory = path.resolve(
        launch.cwd ?? process.cwd(),
        launch.env.CLAUDE_CONFIG_DIR,
      );
      const credentials = credentialsSchema.safeParse(
        await jsonFile(path.join(directory, ".credentials.json")),
      );
      if (!credentials.success)
        return { supported: true, usage: { status: "unauthenticated" } };
      const oauth = credentials.data.claudeAiOauth;
      if (oauth.expiresAt != null && oauth.expiresAt <= Date.now())
        return { supported: true, usage: { status: "expired" } };
      const account = accountSchema.safeParse(
        await jsonFile(path.join(directory, ".claude.json")),
      );
      const response = await requestUsage(
        "https://api.anthropic.com/api/oauth/usage",
        oauth.accessToken,
        fetchUsage,
        {
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.0",
        },
      );
      if (response.status === 401)
        return { supported: true, usage: { status: "expired" } };
      if (!response.ok) throw new Error();
      const data = claudeUsageSchema.parse(await response.json());
      const windows: ProviderUsageWindow[] = [];
      for (const [quota, label, windowKind] of [
        [data.five_hour, "Current session", "five-hour"],
        [data.seven_day, "Weekly limit", "weekly"],
      ] as const) {
        if (quota?.utilization != null)
          windows.push({
            label,
            kind: windowKind,
            usedPercent: Math.min(100, quota.utilization),
            resetsAt: reset(quota.resets_at),
          });
      }
      for (const limit of data.limits ?? []) {
        const model = limit?.scope?.model?.display_name;
        if (limit?.kind === "weekly_scoped" && limit.percent != null && model)
          windows.push({
            label: model,
            kind: "weekly",
            model: model.toLowerCase(),
            usedPercent: Math.min(100, limit.percent),
            resetsAt: reset(limit.resets_at),
          });
      }
      const identity = account.success ? account.data.oauthAccount : null;
      const multiplier = oauth.rateLimitTier?.match(/max_(\d+)x/u)?.[1];
      return {
        supported: true,
        usage: {
          status: "ok",
          accountEmail: identity?.emailAddress ?? null,
          accountKey: identity?.accountUuid
            ? `anthropic:account:${identity.accountUuid}`
            : null,
          planLabel: multiplier
            ? `Max (${multiplier}x)`
            : (oauth.subscriptionType ?? null),
          windows,
        },
      };
    }
    const auth = authSchema.safeParse(
      await jsonFile(
        path.join(
          env.XDG_DATA_HOME || path.join(home, ".local", "share"),
          "opencode",
          "auth.json",
        ),
      ),
    );
    const key = auth.success
      ? auth.data.openrouter.key
      : env.OPENROUTER_API_KEY?.trim();
    if (!key) return { supported: true, usage: { status: "unauthenticated" } };
    const response = await requestUsage(
      "https://openrouter.ai/api/v1/key",
      key,
      fetchUsage,
    );
    if (response.status === 401)
      return { supported: true, usage: { status: "expired" } };
    if (!response.ok) throw new Error();
    const { data } = keySchema.parse(await response.json());
    const used =
      data.limit !== null && data.limit_remaining != null
        ? Math.max(0, data.limit - data.limit_remaining)
        : data.usage;
    const windows: ProviderUsageWindow[] =
      data.limit !== null && data.limit > 0
        ? [
            {
              label: "API key budget",
              usedPercent: Math.min(100, (used / data.limit) * 100),
              resetsAt: null,
              cost: {
                usedUsdCents: Math.round(used * 100),
                limitUsdCents: Math.max(1, Math.round(data.limit * 100)),
              },
            },
          ]
        : [];
    return {
      supported: true,
      usage: {
        status: "ok",
        accountEmail: null,
        accountKey: null,
        planLabel: `$${data.usage.toFixed(2)} spent${data.limit === null ? " · No key limit" : data.limit === 0 ? " · Key limit: $0" : ""}`,
        windows,
      },
    };
  } catch {
    return {
      supported: true,
      usage: {
        status: "error",
        message: `${kind === "claude" ? "Claude" : "OpenRouter"} usage could not be fetched. Check credentials and retry.`,
        accountEmail: null,
        planLabel: null,
      },
    };
  }
}
