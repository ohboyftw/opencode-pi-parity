# pi-parity

Pi 1.0 features as an OpenCode v2 plugin. One file: `index.ts`.

> **Experimental.** Typechecks, but has not been run inside OpenCode yet. See Status.

## Install

Copy this folder to `.opencode/plugins/pi-parity/` (auto-discovered), or reference it:

```jsonc
// opencode.jsonc
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
        // "implementTools": ["edit", "write", "patch"],

        // 2. decision tool
        "jevURL": "https://<your-decision-endpoint>",
        "jevKeyEnv": "JEV_API_KEY",

        // 3. deferred tools
        "defer": true,
        "pinned": ["read", "edit", "write", "bash", "glob", "grep", "load_tools", "note", "decide"]
      }
    }
  ]
}
```

## What each part does

| Pi 1.0 feature | Here | Mechanism |
|---|---|---|
| Virtual model `router/auto` | provider `router`, model `auto` | `ctx.provider.transform` → openai-compatible `baseURL` |
| Plan/implement switch | optional, in-process | `prompt` hook → plan model; first `edit`/`write`/`patch` → `switchModel` to implement model |
| Jev in Codemode | `decide` tool, `codemode: true` | POSTs `{question, options, context}`, expects `{choice}` |
| Deferred tool loading | `load_tools` + `context` hook | unpinned, unloaded tools are deleted from each request; loaded set is stored per session |
| Mid-conversation system messages | `/sysmsg`, `note` tool | `ctx.session.synthetic` appends to the transcript |

## Status

- Typechecks against `@opencode/plugin` 2.0.22 (`npm run typecheck`).
- Not run inside OpenCode yet. Check these on first run:
  1. **Pinned names**: `pinned` must match the built-in tool names in your install; run `opencode` and compare with the "Deferred tools" line. A wrong name hides a core tool.
  2. **`decide` wire format**: the request/response shape is a placeholder. Adapt the `fetch` in section 2 to the real Jev (or jevlite) API.
  3. **Code Mode + deferral**: tools with `codemode: true` may not appear in `event.tools` individually. If so they are unaffected by deferral.
  4. **Cache**: loading a tool changes the tool list, so the request after `load_tools` likely misses the prompt cache once.
  5. **Switch timing**: `switchModel` applies to subsequent requests; the step that made the first edit still ran on the plan model.
  6. **Catalog after restart**: the deferred-tool catalog is in memory, the loaded set is in storage. After a restart, `load_tools` finds nothing until the next request has passed through the `context` hook.

## License

MIT
