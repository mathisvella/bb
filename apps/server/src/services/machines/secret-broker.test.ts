import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnection,
  createThread,
  migrate,
  noopNotifier,
  projects,
} from "@bb/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setMachineEnvironmentVariable } from "./environment-storage.js";
import {
  callSecretBroker,
  issueSecretBrokerCapability,
  listBrokeredMachineEnvironmentNames,
} from "./secret-broker.js";

let db: ReturnType<typeof createConnection>;
let dataDir: string;
let threadId: string;

beforeEach(async () => {
  db = createConnection(":memory:");
  migrate(db);
  dataDir = await mkdtemp(join(tmpdir(), "bb-secret-broker-"));
  db.insert(projects)
    .values({ id: "project-a", name: "Project A", createdAt: 1, updatedAt: 1 })
    .run();
  threadId = createThread(db, noopNotifier, {
    projectId: "project-a",
    providerId: "codex",
  }).id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db.$client.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function addSecret(allowWrite = false) {
  await setMachineEnvironmentVariable(
    db,
    dataDir,
    {
      name: "STRIPE_SECRET_KEY",
      value: "sk_private_value",
      note: null,
      brokerPolicy: "stripe",
      brokerAllowWrite: allowWrite,
      brokerHost: null,
    },
    "project-a",
  );
  const names = listBrokeredMachineEnvironmentNames(db, "project-a");
  return issueSecretBrokerCapability({
    names,
    projectId: "project-a",
    threadId,
  });
}

it("injects a brokered secret only into its allowlisted upstream and redacts it from the response", async () => {
  const capabilityToken = await addSecret();
  let upstream: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      upstream = new Request(input, init);
      return new Response(`{"echo":"sk_private_value"}`, {
        headers: {
          "content-type": "application/json",
          "x-echo": "sk_private_value",
        },
      });
    }),
  );
  const result = await callSecretBroker(
    { db, config: { dataDir } },
    "project-a",
    {
      capabilityToken,
      name: "STRIPE_SECRET_KEY",
      method: "GET",
      url: "https://api.stripe.com/v1/customers",
      headers: {},
      body: null,
    },
  );
  expect(upstream?.headers.get("authorization")).toBe(
    "Bearer sk_private_value",
  );
  expect(JSON.stringify(result)).not.toContain("sk_private_value");
  expect(result.body).toContain("[REDACTED]");
});

it("rejects unapproved destinations and write requests unless explicitly enabled", async () => {
  const capabilityToken = await addSecret();
  const input = {
    capabilityToken,
    name: "STRIPE_SECRET_KEY",
    method: "GET" as const,
    url: "https://example.com/v1/customers",
    headers: {},
    body: null,
  };
  await expect(
    callSecretBroker({ db, config: { dataDir } }, "project-a", input),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    callSecretBroker({ db, config: { dataDir } }, "project-a", {
      ...input,
      method: "DELETE",
      url: "https://api.stripe.com/v1/customers/cus_123",
    }),
  ).rejects.toMatchObject({ status: 403 });
});
