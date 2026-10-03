import type { installDeferral } from "../index.ts"

export type Ctx = Parameters<typeof installDeferral>[0]
type Callback = (event: any) => Promise<void>
type FakeTool = { name: string; execute: (input: unknown, context: unknown) => Promise<any> }
type FakeCommand = { name: string; execute: (input: any) => Promise<void> }

export interface FakeOptions {
  tools?: { id: string; description: string }[]
  getDelayMs?: number
  switchModel?: (input: unknown) => Promise<void>
}

export function fakeContext(options: FakeOptions = {}) {
  const store = new Map<string, unknown>()
  const sessionHooks = new Map<string, Callback>()
  const toolHooks = new Map<string, Callback>()
  const tools = new Map<string, FakeTool>()
  const commands = new Map<string, FakeCommand>()
  const providers: unknown[] = []
  const switches: any[] = []
  const synthetics: unknown[] = []
  const delay = () => new Promise((resolve) => setTimeout(resolve, options.getDelayMs ?? 0))

  const ctx = {
    options: {},
    provider: { transform: async (cb: any) => cb({ add: (p: unknown) => providers.push(p) }) },
    session: {
      hook: async (name: string, cb: Callback) => void sessionHooks.set(name, cb),
      switchModel: async (input: unknown) => {
        await options.switchModel?.(input)
        switches.push(input)
      },
      synthetic: async (input: unknown) => void synthetics.push(input),
    },
    tool: {
      transform: async (cb: any) => cb({ add: (t: FakeTool) => tools.set(t.name, t) }),
      hook: async (name: string, cb: Callback) => void toolHooks.set(name, cb),
      list: async () => options.tools ?? [],
    },
    command: { transform: async (cb: any) => cb({ add: (c: FakeCommand) => commands.set(c.name, c) }) },
    storage: {
      // Snapshot before the delay, like a slow store that answers with the state at request time.
      get: async (key: string) => {
        const value = store.get(key)
        await delay()
        return value
      },
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
  }

  return { ctx: ctx as unknown as Ctx, store, sessionHooks, toolHooks, tools, commands, providers, switches, synthetics }
}

/** Runs the captured context hook over a fresh tool map; returns surviving names and system lines. */
export async function runContext(hooks: Map<string, Callback>, sessionID: string, toolNames: string[]) {
  const event = {
    sessionID,
    tools: Object.fromEntries(toolNames.map((name) => [name, {}])),
    system: [] as { type: string; text: string }[],
  }
  await hooks.get("context")!(event)
  return { kept: Object.keys(event.tools).sort(), system: event.system.map((part) => part.text) }
}
