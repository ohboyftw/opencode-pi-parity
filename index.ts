/**
 * pi-parity — Pi 1.0 features as an OpenCode v2 plugin.
 *
 *   1. Virtual model      router/auto, backed by an OpenAI-compatible router
 *                         (or in-process plan -> implement switching)
 *   2. Jev decision tool  typed decisions, callable from Code Mode
 *   3. Deferred tools     only pinned + loaded tools are sent to the model
 *   4. System messages    /sysmsg and a `note` tool for mid-conversation instructions
 *
 * Typechecked against @opencode/plugin 2.0.22.
 */
import { Model, Plugin, Provider } from "@opencode/plugin"

type Ref = { providerID: string; id: string }
type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export interface Options {
  /** OpenAI-compatible router that implements the plan/implement switch itself. */
  routerBaseURL?: string
  routerModelID: string
  /** In-process switching. Leave unset when the router does the switching. */
  planModel?: Ref
  implementModel?: Ref
  /** Tools whose first successful call means "now implementing". */
  implementTools: string[]
  /** Decision endpoint. Request/response shape is a placeholder: see README. */
  jevURL?: string
  jevKeyEnv: string
  jevTimeoutMs: number
  /** Deferred loading. */
  defer: boolean
  pinned: string[]
}

export const DEFAULTS: Options = {
  routerModelID: "auto",
  implementTools: ["edit", "write"],
  jevKeyEnv: "JEV_API_KEY",
  jevTimeoutMs: 30000,
  defer: true,
  pinned: ["read", "edit", "write", "shell", "glob", "grep", "load_tools", "note", "decide"],
}

/** The plugin's own tools are always pinned, so a custom list cannot lock deferral shut. */
const OWN_TOOLS = ["load_tools", "note", "decide"]
/** Code Mode tools (MCP, `decide`) are only reachable through `execute`, so hiding it hides all of them. */
const ALWAYS_KEPT = [...OWN_TOOLS, "execute"]

const loadedKey = (sessionID: string) => `loaded/${sessionID}`
const phaseKey = (sessionID: string) => `phase/${sessionID}`

export const resolveOptions = (raw: unknown): Options => ({ ...DEFAULTS, ...(raw as Partial<Options>) })

// ------------------------------------------------------------------ 1. virtual model
export async function installRouter(ctx: Context, opt: Options) {
  if (!opt.routerBaseURL) return
  const baseURL = opt.routerBaseURL
  const providerID = Provider.ID.make("router")
  await ctx.provider.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: "Router",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL },
      },
      models: [
        {
          ...Model.Info.default(providerID, Model.ID.make(opt.routerModelID)),
          name: `Router ${opt.routerModelID}`,
        },
      ],
    })
  })
}

// In-process variant: plan on one model, switch on the first implementation tool call,
// switch back when the next user prompt is admitted. The phase is stored only after the
// switch succeeds, so a failed switch is retried next time.
export async function installPhaseSwitch(ctx: Context, opt: Options) {
  if (!opt.planModel || !opt.implementModel) return
  const plan = opt.planModel
  const implement = opt.implementModel
  const switchers = new Set(opt.implementTools)

  await ctx.session.hook("prompt", async (event) => {
    if ((await ctx.storage.get(phaseKey(event.sessionID))) === "plan") return
    await ctx.session.switchModel({ sessionID: event.sessionID, model: plan })
    await ctx.storage.set(phaseKey(event.sessionID), "plan")
  })

  await ctx.tool.hook("execute.after", async (event) => {
    if (event.status !== "completed" || !switchers.has(event.tool)) return
    if ((await ctx.storage.get(phaseKey(event.sessionID))) === "implement") return
    await ctx.session.switchModel({ sessionID: event.sessionID, model: implement })
    await ctx.storage.set(phaseKey(event.sessionID), "implement")
  })
}

// ------------------------------------------------------------------ 3. deferred tools
// Loaded tools per session. Memory is the authority; storage is written through and read
// once per session. The promise is cached so parallel first calls share one Set.
export function loadedStore(ctx: Context) {
  const sessions = new Map<string, Promise<Set<string>>>()

  const get = (sessionID: string) => {
    let pending = sessions.get(sessionID)
    if (!pending) {
      pending = ctx.storage.get(loadedKey(sessionID)).then(
        (value) => new Set(Array.isArray(value) ? (value as string[]) : []),
        (error: unknown) => {
          sessions.delete(sessionID)
          throw error
        },
      )
      sessions.set(sessionID, pending)
    }
    return pending
  }

  const add = async (sessionID: string, names: string[]) => {
    const keep = await get(sessionID)
    names.forEach((name) => keep.add(name))
    await ctx.storage.set(loadedKey(sessionID), [...keep].sort())
  }

  return { get, add }
}

type LoadedStore = ReturnType<typeof loadedStore>

/** Warns once about pinned names that match no registered tool. */
export function pinnedChecker(ctx: Context, pinned: Set<string>) {
  let checked = false
  return async () => {
    if (checked) return
    checked = true
    const known = new Set((await ctx.tool.list()).map((tool) => tool.id))
    const unknown = [...pinned].filter((name) => !ALWAYS_KEPT.includes(name) && !known.has(name))
    if (unknown.length > 0) console.warn(`[pi-parity] pinned tools not found: ${unknown.join(", ")}`)
  }
}

export async function installDeferral(ctx: Context, opt: Options, store: LoadedStore) {
  const pinned = new Set([...opt.pinned, ...ALWAYS_KEPT])
  const checkPinned = pinnedChecker(ctx, pinned)
  await ctx.session.hook("context", async (event) => {
    // Advisory only: a failed check must not block deferral for this request.
    await checkPinned().catch((error: unknown) => console.warn("[pi-parity] pinned check failed:", error))
    const keep = await store.get(event.sessionID)
    const hidden: string[] = []
    for (const name of Object.keys(event.tools)) {
      if (pinned.has(name) || keep.has(name)) continue
      delete event.tools[name]
      hidden.push(name)
    }
    if (hidden.length === 0) return
    // Names only, sorted: the text stays byte-identical until the tool set itself changes.
    event.system.push({
      type: "text",
      text: "Deferred tools (not callable until loaded with load_tools): " + hidden.sort().join(", "),
    })
  })
}

export async function installLoadTools(ctx: Context, store: LoadedStore) {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "load_tools",
      description:
        "Load deferred tools so they can be called from the next step on. " +
        "Pass exact names, or a query to search names and descriptions.",
      input: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
          query: { type: "string" },
        },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        const { names = [], query } = input as { names?: string[]; query?: string }
        const catalog = (await ctx.tool.list()).map((tool) => [tool.id, tool.description] as const)
        return { content: await loadTools(store, context.sessionID, catalog, names, query) }
      },
    })
  })
}

/** Resolves names and query against the catalog, records matches, and describes the outcome. */
export async function loadTools(
  store: LoadedStore,
  sessionID: string,
  catalog: readonly (readonly [string, string])[],
  names: string[],
  query: string | undefined,
) {
  const needle = query?.trim().toLowerCase() || undefined
  const matches = catalog.filter(
    ([name, description]) =>
      names.includes(name) ||
      (needle !== undefined && (name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle))),
  )
  const known = new Set(catalog.map(([name]) => name))
  const unknown = names.filter((name) => !known.has(name))
  const lines = matches.map(([name, description]) => `${name}: ${description}`)
  if (unknown.length > 0) lines.push(`Unknown tools: ${unknown.join(", ")}`)
  if (matches.length === 0) return ["No matching tools.", ...lines].join("\n")

  await store.add(sessionID, matches.map(([name]) => name))
  return lines.join("\n")
}

// ------------------------------------------------------------------ 4. system messages
const systemNote = (text: string) => `<system-note>\n${text}\n</system-note>`

export async function installNotes(ctx: Context) {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "note",
      description:
        "Record a standing instruction for the rest of this session. " +
        "It is appended to the transcript, so earlier context stays cached.",
      input: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, context) => {
        const { text } = input as { text: string }
        await ctx.session.synthetic({
          sessionID: context.sessionID,
          text: systemNote(text),
          description: "System note",
          // The tool runs mid-turn, so steer joins that turn; "queue" would start an extra one.
          delivery: "steer",
        })
        return { content: "Noted." }
      },
    })
  })

  // /sysmsg <text> — the same thing, typed by a human.
  await ctx.command.transform((editor) => {
    editor.add({
      name: "sysmsg",
      description: "Add a standing instruction mid-conversation without rewriting the system prompt",
      execute: async ({ sessionID, prompt, delivery }) => {
        await ctx.session.synthetic({ sessionID, text: systemNote(prompt.text), description: "System note", delivery })
      },
    })
  })
}

// ------------------------------------------------------------------ 2. Jev decision tool
type Decision = { question: string; options: string[]; context?: string }

/** POSTs a decision request. Throws on transport errors, bad status, bad JSON or an off-list choice. */
export async function requestDecision(opt: Options, url: string, body: Decision, signal: AbortSignal) {
  const key = process.env[opt.jevKeyEnv]
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(opt.jevTimeoutMs)]),
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Decision request failed: ${response.status} ${text}`)
  let result: { choice?: unknown }
  try {
    result = JSON.parse(text) as { choice?: unknown }
  } catch {
    throw new Error(`Decision response was not JSON: ${text}`)
  }
  if (typeof result.choice !== "string" || !body.options.includes(result.choice)) {
    throw new Error(`Decision response was not one of the options: ${text}`)
  }
  return result.choice
}

export async function installDecide(ctx: Context, opt: Options) {
  if (!opt.jevURL) return
  const url = opt.jevURL
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "decide",
      description:
        "Ask the decision model to pick exactly one of the given options for a question. " +
        "Returns the chosen option. Use for routing and gating, not for prose.",
      input: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" }, minItems: 2 },
          context: { type: "string" },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { choice: { type: "string" } },
        required: ["choice"],
        additionalProperties: false,
      },
      options: { codemode: true },
      execute: async (input, context) => {
        const choice = await requestDecision(opt, url, input as Decision, context.signal)
        return { output: { choice }, content: choice, metadata: { choice } }
      },
    })
  })
}

export default Plugin.define({
  id: "pi-parity",
  async setup(ctx) {
    const opt = resolveOptions(ctx.options)
    await installRouter(ctx, opt)
    await installPhaseSwitch(ctx, opt)
    if (opt.defer) {
      const store = loadedStore(ctx)
      await installDeferral(ctx, opt, store)
      await installLoadTools(ctx, store)
    }
    await installNotes(ctx)
    await installDecide(ctx, opt)
  },
})
