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

interface Options {
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
  /** Deferred loading. */
  defer: boolean
  pinned: string[]
}

const DEFAULTS: Options = {
  routerModelID: "auto",
  implementTools: ["edit", "write", "patch"],
  jevKeyEnv: "JEV_API_KEY",
  defer: true,
  pinned: ["read", "edit", "write", "bash", "glob", "grep", "load_tools", "note", "decide"],
}

const loadedKey = (sessionID: string) => `loaded/${sessionID}`
const phaseKey = (sessionID: string) => `phase/${sessionID}`

export default Plugin.define({
  id: "pi-parity",
  async setup(ctx) {
    const opt: Options = { ...DEFAULTS, ...(ctx.options as Partial<Options>) }
    const pinned = new Set(opt.pinned)

    // ---------------------------------------------------------------- 1. virtual model
    if (opt.routerBaseURL) {
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
    // switch back when the next user prompt is admitted.
    if (opt.planModel && opt.implementModel) {
      const plan = opt.planModel
      const implement = opt.implementModel
      const switchers = new Set(opt.implementTools)

      await ctx.session.hook("prompt", async (event) => {
        if ((await ctx.storage.get(phaseKey(event.sessionID))) === "plan") return
        await ctx.storage.set(phaseKey(event.sessionID), "plan")
        await ctx.session.switchModel({ sessionID: event.sessionID, model: plan })
      })

      await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed" || !switchers.has(event.tool)) return
        if ((await ctx.storage.get(phaseKey(event.sessionID))) === "implement") return
        await ctx.storage.set(phaseKey(event.sessionID), "implement")
        await ctx.session.switchModel({ sessionID: event.sessionID, model: implement })
      })
    }

    // ---------------------------------------------------------------- 3. deferred tools
    // Catalog of everything the model could have had, per session, from the last request.
    const catalog = new Map<string, Map<string, string>>()

    const loaded = async (sessionID: string) => {
      const value = await ctx.storage.get(loadedKey(sessionID))
      return new Set(Array.isArray(value) ? (value as string[]) : [])
    }

    if (opt.defer) {
      await ctx.session.hook("context", async (event) => {
        const all = new Map(Object.entries(event.tools).map(([name, tool]) => [name, tool.description]))
        catalog.set(event.sessionID, all)

        const keep = await loaded(event.sessionID)
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
          text:
            "Deferred tools (not callable until loaded with load_tools): " +
            hidden.sort().join(", "),
        })
      })
    }

    await ctx.tool.transform((editor) => {
      if (opt.defer) {
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
            const all = catalog.get(context.sessionID) ?? new Map<string, string>()
            const needle = query?.toLowerCase()
            const matches = [...all.entries()].filter(
              ([name, description]) =>
                names.includes(name) ||
                (needle !== undefined &&
                  (name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle))),
            )
            if (matches.length === 0) return { content: "No matching tools." }

            const keep = await loaded(context.sessionID)
            matches.forEach(([name]) => keep.add(name))
            await ctx.storage.set(loadedKey(context.sessionID), [...keep].sort())
            return {
              content: matches.map(([name, description]) => `${name}: ${description}`).join("\n"),
            }
          },
        })
      }

      // -------------------------------------------------------------- 4. system messages
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
            text: `<system-note>\n${text}\n</system-note>`,
            description: "System note",
            delivery: "queue",
          })
          return { content: "Noted." }
        },
      })

      // -------------------------------------------------------------- 2. Jev decision tool
      if (opt.jevURL) {
        const url = opt.jevURL
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
          options: { codemode: true },
          execute: async (input, context) => {
            const body = input as { question: string; options: string[]; context?: string }
            const key = process.env[opt.jevKeyEnv]
            const response = await fetch(url, {
              method: "POST",
              signal: context.signal,
              headers: {
                "content-type": "application/json",
                ...(key ? { authorization: `Bearer ${key}` } : {}),
              },
              body: JSON.stringify(body),
            })
            if (!response.ok) {
              return { content: `Decision request failed: ${response.status} ${await response.text()}` }
            }
            const result = (await response.json()) as { choice?: string }
            if (!result.choice || !body.options.includes(result.choice)) {
              return { content: `Decision response was not one of the options: ${JSON.stringify(result)}` }
            }
            return { content: result.choice, metadata: { choice: result.choice } }
          },
        })
      }
    })

    // /sysmsg <text> — the same thing, typed by a human.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "sysmsg",
        description: "Add a standing instruction mid-conversation without rewriting the system prompt",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.synthetic({
            sessionID,
            text: `<system-note>\n${prompt.text}\n</system-note>`,
            description: "System note",
            delivery,
          })
        },
      })
    })
  },
})
