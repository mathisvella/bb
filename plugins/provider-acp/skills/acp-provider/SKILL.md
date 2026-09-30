---
name: acp-provider
description: "Configure or troubleshoot ACP agent discovery, custom models, skills, and compaction in BB."
---

# ACP providers

Known agents can be discovered automatically when their CLI is installed on the
host: `opencode`, `omp`, `grok`, and `hermes` appear as `acp-opencode`, `acp-omp`,
`acp-grok`, and `acp-hermes-agent`. Inspect the target host's catalog with
`bb provider list` and `bb provider models <provider-id>` using its environment
or machine selector.

Cursor project skills come from `.cursor/skills`, which can link to
`.agents/skills`. BB lists these linked skills as read-only under `cursor-project`.

ACP agents may reject unlisted model IDs. OpenCode requires models in its own
configuration; BB discovers them there. OpenCode agents are session modes, not
models selectable through BB's model field.

OpenCode ACP supports the core `bb thread compact` command; Cursor ACP does not
expose compatible compaction. Check the actual agent's capabilities before
attempting provider-specific recovery.

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
