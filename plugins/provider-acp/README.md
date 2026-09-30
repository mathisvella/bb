# ACP providers

First-party plugin for ACP (Agent Client Protocol) agent providers: Cursor,
opencode, omp, Grok Build and Hermes Agent.

The plugin has no bridge of its own. Every agent it registers runs on the
published ACP kit, `@get-bb/plugin-sdk/provider-bridge/acp`, which its
`bb.host` entry re-exports (`src/host.ts`). That is the whole
point of the kit: a third-party plugin adds an ACP agent exactly the way this
one does, with no bb-side code, and `public-sdk-only.test.ts` proves this
plugin takes no shortcut — no file here may import a private `@bb/*` package.

What lives here:

- `server.ts` — the plugin's runtime: it reconciles one registration per
  agent, from the shipped list (`src/known-agents.ts`) plus whatever the
  `customAgents` setting and the deprecated `customAcpAgents` config array
  declare.
- `src/agents.ts` — the agent definition and the setting's schema, built out
  of the kit's own launch-spec schema so what the setting accepts is exactly
  what the bridge parses. The setting itself is a multi-line JSON field
  (`experimental_multiline`) whose description stays at two sentences; the
  field reference — required and optional fields, the replacement rule for a
  shipped agent's id, the `acp-<id>` provider id — is the "Custom ACP Agents"
  chapter of `docs/configuration.md`.
- `src/configured-agents.ts` — merging the setting and the deprecated config
  array, with the setting winning on a shared id.
- `src/declaration.ts` — one agent definition becomes one
  `bb.providers.register` declaration: ids, display names, icons,
  capabilities, and the bridge options it launches with (`acpLaunchSpec`, and
  `acpDialect` for the agents whose vendor side channels the kit reads).
- `src/legacy-config.ts` — reading the deprecated config array. Dies with the
  deprecation window.
- `src/host.ts` — the `bb.host` artifact, two surfaces in one file: the kit's
  bridge, re-exported, and a host entry whose one RPC asks an agent what it
  supports on the machine it is installed on (`src/contract.ts`,
  `src/probe-capabilities.ts`).
- `icons/` — the provider logos, declared in `package.json` under
  `bb.branding.experimental_icons` so the packaged build ships them.

The kit itself, including the ACP wire schema, the delta translation, the
per-agent dialects and the bridge process, is `packages/provider-bridge-acp`.

Custom ACP agents expose usage automatically when their launch command is
`claude-agent-acp` with an explicit `CLAUDE_CONFIG_DIR`, or `opencode` with
`OPENCODE_CONFIG_CONTENT` restricting `enabled_providers` to `["openrouter"]`.
An explicit `providerUsage: false` opts out. Unrelated custom agents retain their
existing behavior. This applies to the usage UI, `bb settings usage --json`, and
`bb.sdk.system.usageLimits()` as well as the plugin usage-source RPCs.

Claude usage reads only the specified profile's `.credentials.json` and
`.claude.json`; it never falls back to the primary account. OpenRouter usage reads
OpenCode's `auth.json` under `XDG_DATA_HOME/opencode` or
`~/.local/share/opencode`, with `OPENROUTER_API_KEY` as a fallback, using the launch
environment over the host environment. It reports API-key spend and remaining
key budget, not all organization credits. With no key limit, spend remains visible
without a fabricated quota percentage. Tokens and upstream error bodies never
appear in usage output. Account Pooler is not required for these agents.
