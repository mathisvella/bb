import { usageSnapshotSchema } from "./usage-schema.js";
import { expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { usageListMethod, usageFetchMethod } from "./usage-source-contract.js";

it("lists cheaply, fetches only the selected source/provider, preserves failed measurements, and evicts removed resources", async () => {
  let enabled = true;
  let failure = false;
  let hasWork = true;
  const rpc = vi.fn(async ({ pluginId, method, input }) => {
    if (method === usageListMethod)
      return pluginId === "pool"
        ? {
            label: "Account Pooler",
            resources: [
              {
                id: "claude",
                providerId: "claude-code",
                label: "claude@example.com",
                scope: { kind: "shared" },
              },
              {
                id: "personal",
                providerId: "codex",
                label: "personal@example.com",
                scope: { kind: "shared" },
              },
              ...(hasWork
                ? [
                    {
                      id: "work",
                      providerId: "codex",
                      label: "work@example.com",
                      scope: { kind: "shared" },
                    },
                  ]
                : []),
            ],
          }
        : {
            resources: [
              {
                id: "host",
                providerId: "codex",
                label: "Codex",
                scope: { kind: "host", hostId: "host", hostName: "Machine" },
              },
            ],
          };
    if (failure) throw new Error("Upstream failed");
    return {
      observedAt: 123,
      usage: {
        status: "ok",
        accountEmail: `${input.resourceId}@example.com`,
        planLabel: null,
        windows: [
          {
            id: "week",
            label: "Weekly",
            usedPercent: 42,
            resetsAt: null,
            model: null,
            cost: null,
          },
        ],
      },
    };
  });
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: {
        list: async () => [
          makeHostResponse({
            id: "host",
            name: "Machine",
            status: "connected",
          }),
        ],
      },
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", logoUrl: "/codex.svg" },
          {
            id: "claude-code",
            displayName: "Claude Code",
            logoUrl: "/claude.svg",
          },
        ],
      },
      plugins: {
        experimental_discoverRpc: async () =>
          enabled
            ? [
                {
                  pluginId: "pool",
                  displayName: "Account Pooler",
                  method: usageListMethod,
                },
                {
                  pluginId: "local",
                  displayName: "Codex",
                  method: usageListMethod,
                },
              ]
            : [],
        callRpc: rpc,
      },
    },
  });
  plugin(host.bb);
  const request = {
    force: false,
    machineIds: null,
    providerId: null,
    maxAgeMs: 60_000,
  };
  try {
    const listed = await host.harness.behavior.callRpc("getUsage", request);
    expect(listed).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          providers: [
            { providerId: "codex", usage: null },
            { providerId: "codex", usage: null },
            { providerId: "claude-code", usage: null },
          ],
        },
      ],
    });
    expect(
      rpc.mock.calls.every(([args]) => args.method === usageListMethod),
    ).toBe(true);
    const target = {
      ...request,
      machineIds: ["source:pool"],
      providerId: "codex",
    };
    await host.harness.behavior.callRpc("getUsage", target);
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .map(([args]) => [
          args.pluginId,
          args.input.resourceId,
          args.input.refresh,
        ]),
    ).toEqual([
      ["pool", "personal", false],
      ["pool", "work", false],
    ]);
    await host.harness.behavior.callRpc("getUsage", target);
    expect(
      rpc.mock.calls.filter(([args]) => args.method === usageFetchMethod),
    ).toHaveLength(2);
    failure = true;
    expect(
      await host.harness.behavior.callRpc("getUsage", {
        ...target,
        force: true,
      }),
    ).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          error: "Some usage could not be refreshed.",
          providers: [
            { usage: { status: "ok" } },
            { usage: { status: "ok" } },
            { usage: null },
          ],
        },
      ],
    });
    failure = false;
    hasWork = false;
    expect(
      await host.harness.behavior.callRpc("getUsage", {
        ...target,
        force: true,
      }),
    ).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          error: null,
          providers: [{ id: "pool:personal" }, { id: "pool:claude" }],
        },
      ],
    });
    await host.harness.behavior.callRpc("getUsage", {
      ...target,
      providerId: "claude-code",
    });
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .at(-1)?.[0].input.resourceId,
    ).toBe("claude");
    await host.harness.behavior.callRpc("getUsage", {
      ...target,
      machineIds: null,
    });
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .at(-1)?.[0].pluginId,
    ).toBe("local");
    enabled = false;
    expect(
      await host.harness.behavior.callRpc("getUsage", request),
    ).toMatchObject({ machines: [{ id: "host", providers: [] }] });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("keeps an unconfigured shared group without hosts or measurement requests", async () => {
  const rpc = vi.fn(async () => ({ label: "Account Pooler", resources: [] }));
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      plugins: {
        experimental_discoverRpc: async () => [
          { pluginId: "pool", displayName: "Pool", method: usageListMethod },
        ],
        callRpc: rpc,
      },
    },
  });
  plugin(host.bb);
  try {
    await expect(
      host.harness.behavior.callRpc("getUsage", {
        force: false,
        machineIds: null,
        providerId: null,
        maxAgeMs: 0,
      }),
    ).resolves.toEqual({
      machines: [
        {
          id: "source:pool",
          displayName: "Account Pooler",
          status: "connected",
          providers: [],
          error: null,
        },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("collapses known account observations per machine, preserves unknown identities, and normalizes display labels", async () => {
  const { bb, harness } = createFakePluginHost({
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host", status: "connected" }),
        ],
      },
      providers: { list: async () => [] },
      plugins: {
        experimental_discoverRpc: async () => [
          { pluginId: "adapter", displayName: "Adapter" },
          { pluginId: "custom", displayName: "Custom" },
        ],
        callRpc: async ({ pluginId, method }) =>
          method === usageListMethod
            ? {
                resources: [
                  {
                    id: "account",
                    providerId: "codex",
                    accountKey: null,
                    label: "same@example.com",
                    scope: { kind: "host", hostId: "host", hostName: "Host" },
                  },
                  {
                    id: "unknown",
                    providerId: "other",
                    accountKey: null,
                    label: "same@example.com",
                    scope: { kind: "host", hostId: "host", hostName: "Host" },
                  },
                ],
              }
            : {
                accountKey: "issuer:account:1",
                observedAt: 123,
                usage: {
                  status: "ok",
                  accountEmail: "same@example.com",
                  planLabel: "max",
                  plan: { id: "max", multiplier: 20 },
                  windows: [
                    {
                      id: "week",
                      kind: "weekly",
                      label: "168 hour window",
                      model: null,
                      resetsAt: null,
                      cost: null,
                      usedPercent: pluginId === "adapter" ? 42 : 81,
                    },
                  ],
                },
              },
      },
    },
  });
  try {
    plugin(bb);
    const snapshot = await harness.behavior.callRpc("getUsage", {
      force: false,
      machineIds: ["host"],
      providerId: "codex",
      maxAgeMs: 0,
    });
    expect(snapshot).toMatchObject({
      machines: [
        {
          providers: [
            {
              id: "adapter:account",
              usage: {
                planLabel: "Max (20x)",
                windows: [{ label: "Weekly limit", usedPercent: 42 }],
              },
            },
            { id: "adapter:unknown", usage: null },
            { id: "custom:unknown", usage: null },
          ],
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("81");
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("hides Cursor without fetching it and can reveal it through plugin settings", async () => {
  const rpc = vi.fn(async ({ method }) => {
    if (method === usageListMethod)
      return {
        resources: [
          {
            id: "cursor",
            providerId: "acp-cursor",
            label: "Cursor",
            scope: { kind: "host", hostId: "host", hostName: "Machine" },
          },
        ],
      };
    return { observedAt: 123, usage: { status: "unauthenticated" } };
  });
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host", status: "connected" }),
        ],
      },
      providers: { list: async () => [] },
      system: { config: async () => ({ primaryHostId: null }) },
      plugins: {
        experimental_discoverRpc: async () => [
          {
            pluginId: "cursor-source",
            displayName: "Cursor",
            method: usageListMethod,
          },
        ],
        callRpc: rpc,
      },
    },
  });
  plugin(host.bb);
  const request = {
    force: false,
    machineIds: ["host"],
    providerId: "acp-cursor",
    maxAgeMs: 60_000,
  };
  try {
    expect(
      await host.harness.behavior.callRpc("getUsage", request),
    ).toMatchObject({ machines: [{ providers: [] }] });
    expect(
      rpc.mock.calls.every(([args]) => args.method === usageListMethod),
    ).toBe(true);
    await host.harness.behavior.setSettings({ showCursor: true });
    expect(
      await host.harness.behavior.callRpc("getUsage", request),
    ).toMatchObject({
      machines: [{ providers: [{ providerId: "acp-cursor" }] }],
    });
    expect(
      rpc.mock.calls.some(([args]) => args.method === usageFetchMethod),
    ).toBe(true);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("deduplicates the same Claude identity across sources and machines while preserving distinct accounts", async () => {
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: {
        list: async () => [makeHostResponse({ id: "host", name: "Machine" })],
      },
      providers: {
        list: async () => [
          { id: "claude-code", displayName: "Claude Code", logoUrl: null },
        ],
      },
      plugins: {
        experimental_discoverRpc: async () => [
          { pluginId: "local", displayName: "Local" },
          { pluginId: "pool", displayName: "Pool" },
        ],
        callRpc: async ({ pluginId }) => ({
          resources: (pluginId === "local" ? ["same"] : ["same", "other"]).map(
            (id) => ({
              id,
              providerId: "claude-code",
              accountKey: `anthropic:account:${id}`,
              label: "same@example.com",
              scope:
                pluginId === "local"
                  ? { kind: "host", hostId: "host", hostName: "Machine" }
                  : { kind: "shared" },
            }),
          ),
        }),
      },
    },
  });
  try {
    plugin(host.bb);
    const snapshot = usageSnapshotSchema.parse(
      await host.harness.behavior.callRpc("getUsage", {
        force: false,
        machineIds: null,
        providerId: null,
        maxAgeMs: 60_000,
      }),
    );
    const accounts = snapshot.machines.flatMap((machine) => machine.providers);
    expect(accounts.map((account) => account.id)).toEqual([
      "pool:same",
      "pool:other",
    ]);
    expect(
      accounts.every((account) => account.providerId === "claude-code"),
    ).toBe(true);
    expect(accounts.every((account) => account.displayName === "Claude")).toBe(
      true,
    );
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
