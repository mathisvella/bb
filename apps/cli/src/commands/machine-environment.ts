import type { Command } from "commander";
import {
  machineEnvironmentBrokerPolicySchema,
  type MachineEnvironmentList,
} from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson } from "./helpers.js";

function printEnvironment(
  result: MachineEnvironmentList,
  options: { json?: boolean },
): void {
  if (outputJson(options, result)) return;
  console.log(
    `Built-in GitHub: ${result.builtInGit.status} — ${result.builtInGit.statusMessage}`,
  );
  for (const row of result.variables)
    console.log(
      `${row.name}=${row.secret ? "[secret]" : row.value}${row.brokerPolicy ? ` [broker: ${row.brokerPolicy}${row.brokerAllowWrite ? ", write enabled" : ", read only"}]` : " [direct]"}${row.note ? ` (${row.note})` : ""}`,
    );
}

async function readStdin(maxBytes: number, stripTrailingNewline: boolean) {
  if (process.stdin.isTTY)
    throw new Error(
      "Pipe the value to stdin; environment values are never accepted in command arguments.",
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes.`);
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  return stripTrailingNewline ? value.replace(/\r?\n$/u, "") : value;
}

async function readValue(): Promise<string> {
  try {
    return await readStdin(65536, true);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Input exceeds 65536 bytes."
    )
      throw new Error("Environment value exceeds 65536 bytes.");
    throw error;
  }
}

function collectHeader(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseHeaders(values: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf(":");
    if (separator <= 0) throw new Error(`Invalid header: ${value}`);
    headers[value.slice(0, separator).trim()] = value
      .slice(separator + 1)
      .trim();
  }
  return headers;
}

export function registerMachineEnvironmentCommands(
  machine: Command,
  getUrl: () => string,
): void {
  const env = machine
    .command("env")
    .description("Configure global or project machine environment variables");
  env
    .command("list")
    .option(
      "--project <id>",
      "Show this project's overrides and inherited global variables",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: { project?: string; json?: boolean }) => {
        const sdk = createCliBbSdk(getUrl());
        const result = options.project
          ? await sdk.projects.machineEnvironment({
              projectId: options.project,
            })
          : {
              ...(await sdk.system.machineEnvironment()),
              inheritedVariables: [],
            };
        printEnvironment(result, options);
        if (!options.json && options.project) {
          for (const row of result.inheritedVariables) {
            const overridden = result.variables.some(
              (variable) => variable.name === row.name,
            );
            console.log(
              `${row.name}=[secret] (Global${overridden ? "; overridden by project" : "; inherited"})`,
            );
          }
        }
      }),
    );
  env
    .command("set <NAME>")
    .description("Read a value from stdin; remove one trailing newline")
    .option("--project <id>", "Set an override for this project")
    .option("--note <text>", "Describe this variable")
    .option(
      "--broker <policy>",
      "Keep the value server-side and restrict it to an API policy",
    )
    .option(
      "--allow-write",
      "Allow POST, PUT, PATCH, and DELETE through the broker",
    )
    .option(
      "--broker-host <host>",
      "Exact project host for the supabase-project policy",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          name: string,
          options: {
            project?: string;
            note?: string;
            broker?: string;
            allowWrite?: boolean;
            brokerHost?: string;
            json?: boolean;
          },
        ) => {
          const sdk = createCliBbSdk(getUrl());
          const brokerPolicy = options.broker
            ? machineEnvironmentBrokerPolicySchema.parse(options.broker)
            : null;
          if (options.allowWrite && brokerPolicy === null)
            throw new Error("--allow-write requires --broker.");
          if (options.brokerHost && brokerPolicy !== "supabase-project")
            throw new Error(
              "--broker-host is only valid with --broker supabase-project.",
            );
          if (brokerPolicy === "supabase-project" && !options.brokerHost)
            throw new Error(
              "--broker supabase-project requires --broker-host.",
            );
          const input = {
            name,
            value: await readValue(),
            note: options.note ?? null,
            brokerPolicy,
            brokerAllowWrite: options.allowWrite ?? false,
            brokerHost: options.brokerHost?.toLowerCase() ?? null,
          };
          printEnvironment(
            options.project
              ? await sdk.projects.setMachineEnvironmentVariable({
                  ...input,
                  projectId: options.project,
                })
              : await sdk.system.setMachineEnvironmentVariable(input),
            options,
          );
        },
      ),
    );
  env
    .command("call <NAME> <URL>")
    .description("Call an allowlisted API without exposing a brokered secret")
    .option("--method <method>", "HTTP method", "GET")
    .option("-H, --header <header>", "Request header", collectHeader, [])
    .option("--body-stdin", "Read the request body from stdin")
    .option("--json", "Print status, headers, and body as JSON")
    .action(
      action(
        async (
          name: string,
          url: string,
          options: {
            method: string;
            header: string[];
            bodyStdin?: boolean;
            json?: boolean;
          },
        ) => {
          const projectId = process.env.BB_PROJECT_ID;
          const capabilityToken = process.env.BB_SECRET_BROKER_TOKEN;
          if (!projectId || !capabilityToken)
            throw new Error(
              "Broker calls are only available inside a BB agent thread with brokered secrets.",
            );
          const method = options.method.toUpperCase();
          if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
            throw new Error(`Unsupported HTTP method: ${options.method}`);
          const result = await createCliBbSdk(
            getUrl(),
          ).projects.callMachineEnvironmentBroker({
            projectId,
            capabilityToken,
            name,
            method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
            url,
            headers: parseHeaders(options.header),
            body: options.bodyStdin ? await readStdin(1_048_576, false) : null,
          });
          if (options.json) console.log(JSON.stringify(result));
          else if (result.bodyEncoding === "base64")
            process.stdout.write(Buffer.from(result.body, "base64"));
          else process.stdout.write(result.body);
          if (result.status >= 400)
            throw new Error(`Brokered API returned HTTP ${result.status}.`);
        },
      ),
    );
  env
    .command("unset <NAME>")
    .option(
      "--project <id>",
      "Remove this project's override and restore inheritance",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (name: string, options: { project?: string; json?: boolean }) => {
          const sdk = createCliBbSdk(getUrl());
          printEnvironment(
            options.project
              ? await sdk.projects.deleteMachineEnvironmentVariable({
                  projectId: options.project,
                  name,
                })
              : await sdk.system.deleteMachineEnvironmentVariable({ name }),
            options,
          );
        },
      ),
    );
}
