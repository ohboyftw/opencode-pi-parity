# pi-parity

Pi 1.0 features as an OpenCode v2 plugin. One file: `index.ts`.

> **Experimental.** Deferral, `load_tools`, `note`, `/sysmsg` and Code Mode access have been run inside OpenCode v2.0.18 with GitHub Copilot (Claude Sonnet 5). The plan/implement switch has been run live too. The router and `decide` have only unit tests. See Status.

## Install

Copy this folder to `.opencode/plugins/pi-parity/` and run `npm install` in it. OpenCode discovers it automatically, but a discovered plugin gets **no options**, so it runs on the defaults (deferral, `note`, `/sysmsg`; no router, no switch, no `decide`).

To pass options, add an entry to `.opencode/opencode.jsonc`. Paths are relative to the config file, so from a root `opencode.jsonc` use `./.opencode/plugins/pi-parity`.

```jsonc
// .opencode/opencode.jsonc
{
  "plugins": [
    {
      "package": "./plugins/pi-parity",
      "options": {
        // 1a. virtual model served by your own router (OpenAI-compatible)
        "routerBaseURL": "https://bridllm.fly.dev/v1",
        "routerModelID": "auto",

        // 1b. OR in-process switching (leave routerBaseURL out)
        // "planModel":      { "providerID": "anthropic", "id": "<plan model id>" },
        // "implementModel": { "providerID": "openai",    "id": "<implement model id>" },
        // "implementTools": ["edit", "write"],

        // 2. decision tool
        "jevURL": "https://<your-decision-endpoint>",
        "jevKeyEnv": "JEV_API_KEY",
        "jevTimeoutMs": 30000,

        // 3. deferred tools
        "defer": true,
        "pinned": ["read", "edit", "write", "shell", "glob", "grep"]  // load_tools, note, decide, execute are always kept
      }
    }
  ]
}
```

## What each part does

| Pi 1.0 feature | Here | Mechanism |
|---|---|---|
| Virtual model `router/auto` | provider `router`, model `auto` | `ctx.provider.transform` → openai-compatible `baseURL` |
| Plan/implement switch | optional, in-process | `prompt` hook → plan model; first `edit`/`write` → `switchModel` to implement model |
| Jev in Codemode | `decide` tool, `codemode: true` | POSTs `{question, options, context}`, expects `{choice}`; errors (status, JSON, off-list choice, `jevTimeoutMs`) throw |
| Deferred tool loading | `load_tools` + `context` hook | unpinned, unloaded tools are deleted from each request; `load_tools` searches `ctx.tool.list()`; loaded set is kept in memory and written through to storage |
| Mid-conversation system messages | `/sysmsg`, `note` tool | `ctx.session.synthetic` appends to the transcript; `note` uses `steer`, so it joins the current turn instead of starting a new one |

## Status

- Typechecks against `@opencode/plugin` 2.0.22 (`npm run typecheck`).
- Unit tests: `npm test` (Node 22.6+ built-in runner, fake plugin context, no OpenCode needed).
- Live checks (OpenCode v2.0.18, GitHub Copilot): deferral hides unpinned tools; `load_tools` by name or query makes a hidden tool callable on the next step; `execute`/`search()` still reaches MCP tools; `note` and `/sysmsg` persist across turns and stack; a `note` adds no extra model turn and the prompt cache still hits; plan/implement with `github-copilot` `claude-opus-5.5` → `gpt-5.3-codex` switched after the first `write` and back on the next prompt. Open points:
  1. **Pinned names**: on the first request, pinned names that match no registered tool are logged as a warning (`[pi-parity] pinned tools not found: ...`). The plugin's own tools are always pinned, so a custom list cannot hide `load_tools`.
  2. **`decide` wire format**: the request/response shape is a placeholder. Adapt the `fetch` in section 2 to the real Jev (or jevlite) API.
  3. **Code Mode + deferral**: OpenCode already defers Code Mode tools (MCP tools, `decide`) natively: they sit behind the `execute` tool with a token budget and a `search()` helper. This plugin therefore never hides `execute`, and its own deferral only affects direct tools.
  4. **Cache**: loading a tool changes the tool list. In one Gemini run the next request still read most of the prompt from cache; other providers are unchecked.
  5. **Switch timing**: `switchModel` applies to subsequent requests; the step that made the first edit still ran on the plan model (confirmed live). The first step on each model starts with a cold prompt cache, and the plan model is forced on every prompt, so it overrides a model picked in the TUI.
  6. **`load_tools` catalog**: comes from `ctx.tool.list()`, which is global, not per agent, so it may offer a tool the current agent cannot call.

Standing instructions are soft: `note` and `/sysmsg` held for ordinary replies but were ignored after a turn with a large tool output. Treat them as guidance, not guarantees.

Headless runs: `opencode run` reads stdin until EOF when stdin is not a terminal, so scripts must pass `</dev/null` or the run hangs. With GitHub Copilot, `--standalone` runs returned HTTP 401 while the same models worked through the background service.

## License

MIT
