import { randomBytes } from "node:crypto";
import { getThread, type DbConnection } from "@bb/db";
import type {
  MachineEnvironmentBrokerCall,
  MachineEnvironmentBrokerPolicy,
  MachineEnvironmentBrokerResponse,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import {
  decryptMachineEnvironment,
  readMachineEnvironment,
} from "./environment-storage.js";

const CAPABILITY_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface BrokerCapability {
  expiresAt: number;
  names: Set<string>;
  projectId: string;
  threadId: string;
}

interface BrokerDeps {
  config: { dataDir: string };
  db: DbConnection;
}

const capabilities = new Map<string, BrokerCapability>();

function effectiveRows(db: DbConnection, projectId: string) {
  const rows = new Map(
    readMachineEnvironment(db).map((row) => [row.name, row]),
  );
  for (const row of readMachineEnvironment(db, projectId)) {
    rows.set(row.name, row);
  }
  return rows;
}

function pruneCapabilities(now: number): void {
  for (const [token, capability] of capabilities) {
    if (capability.expiresAt <= now) capabilities.delete(token);
  }
}

export function listBrokeredMachineEnvironmentNames(
  db: DbConnection,
  projectId: string,
): string[] {
  return [...effectiveRows(db, projectId).values()]
    .filter((row) => row.brokerPolicy !== null)
    .map((row) => row.name)
    .sort();
}

export function issueSecretBrokerCapability(args: {
  names: readonly string[];
  projectId: string;
  threadId: string;
}): string {
  const now = Date.now();
  pruneCapabilities(now);
  const token = randomBytes(32).toString("base64url");
  capabilities.set(token, {
    expiresAt: now + CAPABILITY_TTL_MS,
    names: new Set(args.names),
    projectId: args.projectId,
    threadId: args.threadId,
  });
  return token;
}

function requireCapability(
  deps: BrokerDeps,
  projectId: string,
  token: string,
  name: string,
): BrokerCapability {
  const now = Date.now();
  pruneCapabilities(now);
  const capability = capabilities.get(token);
  if (
    !capability ||
    capability.projectId !== projectId ||
    !capability.names.has(name)
  ) {
    throw new ApiError(403, "forbidden", "Invalid secret broker capability");
  }
  const thread = getThread(deps.db, capability.threadId);
  if (
    !thread ||
    thread.deletedAt !== null ||
    thread.projectId !== capability.projectId
  ) {
    capabilities.delete(token);
    throw new ApiError(403, "forbidden", "Secret broker capability expired");
  }
  return capability;
}

function requireAllowedUrl(
  policy: MachineEnvironmentBrokerPolicy,
  brokerHost: string | null,
  rawUrl: string,
): URL {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "Broker destinations must use HTTPS on port 443 without URL credentials",
    );
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    (policy === "stripe" &&
      host === "api.stripe.com" &&
      url.pathname.startsWith("/v1/")) ||
    (policy === "cloudflare" &&
      host === "api.cloudflare.com" &&
      url.pathname.startsWith("/client/v4/")) ||
    (policy === "sentry" &&
      host === "sentry.io" &&
      url.pathname.startsWith("/api/0/")) ||
    (policy === "postmark" && host === "api.postmarkapp.com") ||
    (policy === "supabase-management" && host === "api.supabase.com") ||
    (policy === "supabase-project" &&
      brokerHost !== null &&
      brokerHost.endsWith(".supabase.co") &&
      host === brokerHost &&
      [
        "/auth/v1/",
        "/functions/v1/",
        "/graphql/v1",
        "/rest/v1/",
        "/storage/v1/",
      ].some((prefix) => url.pathname.startsWith(prefix)));
  if (!allowed) {
    throw new ApiError(
      403,
      "forbidden",
      `Destination is not allowed by the ${policy} broker policy`,
    );
  }
  return url;
}

const forbiddenRequestHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
  "x-postmark-server-token",
  "apikey",
]);

function buildHeaders(
  input: Readonly<Record<string, string>>,
  policy: MachineEnvironmentBrokerPolicy,
  secret: string,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (forbiddenRequestHeaders.has(name.toLowerCase())) {
      throw new ApiError(
        400,
        "invalid_request",
        `Header ${name} is controlled by the secret broker`,
      );
    }
    headers.set(name, value);
  }
  if (policy === "postmark") {
    headers.set("x-postmark-server-token", secret);
  } else {
    headers.set("authorization", `Bearer ${secret}`);
    if (policy === "supabase-project") headers.set("apikey", secret);
  }
  return headers;
}

function redact(value: string, secret: string): string {
  return secret.length === 0 ? value : value.split(secret).join("[REDACTED]");
}

function responseHeaders(headers: Headers, secret: string) {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "set-cookie" ||
      normalized === "www-authenticate" ||
      normalized === "proxy-authenticate"
    ) {
      continue;
    }
    result[name] = redact(value, secret);
  }
  return result;
}

function isUtf8Response(contentType: string | null): boolean {
  if (!contentType) return true;
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("x-www-form-urlencoded")
  );
}

export async function callSecretBroker(
  deps: BrokerDeps,
  projectId: string,
  input: MachineEnvironmentBrokerCall,
): Promise<MachineEnvironmentBrokerResponse> {
  requireCapability(deps, projectId, input.capabilityToken, input.name);
  const row = effectiveRows(deps.db, projectId).get(input.name);
  if (!row || row.brokerPolicy === null) {
    throw new ApiError(
      404,
      "not_found",
      "Brokered environment variable not found",
    );
  }
  const url = requireAllowedUrl(row.brokerPolicy, row.brokerHost, input.url);
  if (input.method !== "GET" && !row.brokerAllowWrite) {
    throw new ApiError(
      403,
      "forbidden",
      `${input.name} only allows read-only broker requests`,
    );
  }
  const secret = await decryptMachineEnvironment(deps.config.dataDir, row);
  if (secret.length === 0) {
    throw new ApiError(
      409,
      "invalid_request",
      "Brokered environment variables cannot be empty",
    );
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method,
      headers: buildHeaders(input.headers, row.brokerPolicy, secret),
      body:
        input.method === "GET" || input.body === null ? undefined : input.body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(
      502,
      "provider_rpc_error",
      "Brokered API request failed",
      true,
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new ApiError(
      502,
      "provider_rpc_error",
      "Brokered API response exceeds 2 MiB",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new ApiError(
      502,
      "provider_rpc_error",
      "Brokered API response exceeds 2 MiB",
    );
  }
  const utf8 = isUtf8Response(response.headers.get("content-type"));
  return {
    status: response.status,
    headers: responseHeaders(response.headers, secret),
    body: utf8
      ? redact(new TextDecoder().decode(bytes), secret)
      : Buffer.from(bytes).toString("base64"),
    bodyEncoding: utf8 ? "utf8" : "base64",
  };
}
