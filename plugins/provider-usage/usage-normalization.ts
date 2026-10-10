import type { UsageMeasurement } from "./usage-source-contract.js";

export function normalizeUsageMeasurement(
  measurement: UsageMeasurement,
): UsageMeasurement {
  if (measurement.usage.status !== "ok") return measurement;
  const usage = measurement.usage;
  const labels: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    max: "Max",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    education: "Education",
    edu: "Education",
  };
  const plan = usage.plan;
  const planName = plan ? labels[plan.id] : undefined;
  const windowLabels = {
    "five-hour": "Five-hour limit",
    daily: "Daily limit",
    weekly: "Weekly limit",
    custom: "",
  };
  return {
    ...measurement,
    usage: {
      ...usage,
      planLabel: planName
        ? `${planName}${plan?.multiplier == null ? "" : ` (${plan.multiplier}x)`}`
        : usage.planLabel,
      windows: usage.windows.map((window) => ({
        ...window,
        label:
          window.kind && window.kind !== "custom"
            ? window.model
              ? `${window.kind === "weekly" ? "Weekly" : windowLabels[window.kind]} · ${window.model.charAt(0).toUpperCase() + window.model.slice(1)}`
              : windowLabels[window.kind]
            : window.label,
      })),
    },
  };
}

type Identity = {
  providerId: string;
  accountKey?: string | null;
  usageStatus?: string;
  scope: { kind: "shared" | "host" };
};

export function selectUsageResources<T>(
  resources: readonly T[],
  identify: (resource: T) => Identity,
): T[] {
  const result: T[] = [];
  const known = new Map<string, number>();
  for (const resource of resources) {
    const identity = identify(resource);
    if (!identity.accountKey) {
      result.push(resource);
      continue;
    }
    const issuer = /^(anthropic:account:|openai:chatgpt:)/u.test(
      identity.accountKey,
    )
      ? "provider-issued"
      : identity.providerId;
    const key = JSON.stringify([issuer, identity.accountKey]);
    const index = known.get(key);
    if (index === undefined) {
      known.set(key, result.length);
      result.push(resource);
    } else if (
      identity.scope.kind === "shared" &&
      identify(result[index]!).scope.kind !== "shared"
    )
      result[index] = resource;
  }
  const connectedProviders = new Set(
    result
      .filter((resource) => identify(resource).usageStatus === "ok")
      .map((resource) => identify(resource).providerId),
  );
  return result.filter((resource) => {
    const identity = identify(resource);
    return (
      identity.accountKey ||
      !["unauthenticated", "not_installed"].includes(
        identity.usageStatus ?? "",
      ) ||
      !connectedProviders.has(identity.providerId)
    );
  });
}

export function usageProviderGroupId(
  providerId: string,
  family?: string,
): string {
  return providerId === "claude" ||
    providerId === "claude-code" ||
    family === "claude" ||
    family === "claude-code"
    ? "claude-code"
    : providerId;
}
