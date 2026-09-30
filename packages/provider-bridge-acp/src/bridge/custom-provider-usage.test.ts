import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  customUsageKind,
  readCustomProviderUsage,
} from "./custom-provider-usage.js";
import { getAcpProviderUsage } from "./provider-maintenance.js";
import type { AcpLaunchSpec } from "../launch-spec.js";

function launch(command: string, env: Record<string, string>): AcpLaunchSpec {
  return { command, args: [], env, displayName: "Custom" };
}

it("reads the configured Claude profile and preserves its identity and quotas", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bb-claude-profile-"));
  try {
    await writeFile(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "profile-token",
          expiresAt: Date.now() + 60_000,
          subscriptionType: "max",
          rateLimitTier: "max_20x",
        },
      }),
    );
    await writeFile(
      path.join(dir, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          emailAddress: "second@example.com",
          accountUuid: "second-account",
        },
      }),
    );
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        five_hour: { utilization: 34, resets_at: "2026-10-02T12:00:00Z" },
        seven_day: { utilization: 110, resets_at: "invalid" },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 45,
            scope: { model: { display_name: "Sonnet" } },
          },
        ],
      }),
    );
    const result = await readCustomProviderUsage(
      launch("/opt/runtime/claude-agent-acp", { CLAUDE_CONFIG_DIR: dir }),
      request,
    );
    expect(result).toMatchObject({
      supported: true,
      usage: {
        status: "ok",
        accountEmail: "second@example.com",
        accountKey: "anthropic:account:second-account",
        planLabel: "Max (20x)",
        windows: [
          { usedPercent: 34, resetsAt: "2026-10-02T12:00:00.000Z" },
          { usedPercent: 100, resetsAt: null },
          { model: "sonnet", usedPercent: 45 },
        ],
      },
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer profile-token",
        }),
        redirect: "error",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("profile-token");
    await writeFile(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "expired-token", expiresAt: 1 },
      }),
    );
    expect(
      await readCustomProviderUsage(
        launch("claude-agent-acp", { CLAUDE_CONFIG_DIR: dir }),
        request,
      ),
    ).toEqual({ supported: true, usage: { status: "expired" } });
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not fall back to another Claude account when the profile is missing", async () => {
  const request = vi.fn<typeof fetch>();
  expect(
    await readCustomProviderUsage(
      launch("claude-agent-acp", {
        CLAUDE_CONFIG_DIR: "/nonexistent/bb-profile",
      }),
      request,
    ),
  ).toEqual({ supported: true, usage: { status: "unauthenticated" } });
  expect(request).not.toHaveBeenCalled();
});

it("reads OpenCode auth and uses remaining key budget rather than lifetime spend", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bb-openrouter-"));
  try {
    await mkdir(path.join(dir, "opencode"));
    await writeFile(
      path.join(dir, "opencode", "auth.json"),
      JSON.stringify({ openrouter: { type: "api", key: "local-key" } }),
    );
    const agent = launch("/opt/runtime/opencode", {
      XDG_DATA_HOME: dir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: ["openrouter"],
      }),
    });
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { usage: 150, limit: 100, limit_remaining: 75 } }),
    );
    expect(await readCustomProviderUsage(agent, request)).toMatchObject({
      supported: true,
      usage: {
        status: "ok",
        windows: [
          {
            usedPercent: 25,
            cost: { usedUsdCents: 2500, limitUsdCents: 10000 },
          },
        ],
      },
    });
    expect(request).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/key",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer local-key" }),
      }),
    );
    request.mockImplementation(async () =>
      Response.json({ data: { usage: 12.34, limit: null } }),
    );
    expect(await readCustomProviderUsage(agent, request)).toMatchObject({
      usage: {
        status: "ok",
        planLabel: "$12.34 spent · No key limit",
        windows: [],
      },
    });
    request.mockImplementation(
      async () => new Response("secret response", { status: 401 }),
    );
    expect(await readCustomProviderUsage(agent, request)).toEqual({
      supported: true,
      usage: { status: "expired" },
    });
    request.mockImplementation(async () => {
      throw new Error("local-key");
    });
    const failed = await readCustomProviderUsage(agent, request);
    expect(failed).toMatchObject({ usage: { status: "error" } });
    expect(JSON.stringify(failed)).not.toContain("local-key");
    request.mockImplementation(async () =>
      Response.json({ data: { usage: "wrong" } }),
    );
    expect(await readCustomProviderUsage(agent, request)).toMatchObject({
      usage: { status: "error" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps unrelated ACP agents unsupported and missing executables uninstalled", async () => {
  expect(
    customUsageKind(launch("opencode", { OPENCODE_CONFIG_CONTENT: "{}" })),
  ).toBeNull();
  expect(
    customUsageKind(launch("wrapper", { CLAUDE_CONFIG_DIR: "/profile" })),
  ).toBeNull();
  expect(
    await getAcpProviderUsage({
      command: "/nonexistent/claude-agent-acp",
      launchSpec: launch("/nonexistent/claude-agent-acp", {
        CLAUDE_CONFIG_DIR: "/profile",
      }),
      maintenance: undefined,
    }),
  ).toEqual({ supported: true, usage: { status: "not_installed" } });
  expect(
    await getAcpProviderUsage({ command: "unknown", maintenance: undefined }),
  ).toEqual({ supported: false });
});
