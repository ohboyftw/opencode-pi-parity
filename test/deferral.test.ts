import { test } from "node:test"
import assert from "node:assert/strict"

import { installDeferral, loadedStore, loadTools, resolveOptions } from "../index.ts"
import { fakeContext, runContext } from "./fake-context.ts"

const TOOLS = ["read", "edit", "shell", "webfetch", "load_tools"]
const catalog = [
  ["shell", "Run a shell command"],
  ["webfetch", "Fetch a URL"],
  ["websearch", "Search the web"],
] as const

async function setup(pinned: string[], getDelayMs = 0) {
  const fake = fakeContext({ getDelayMs, tools: TOOLS.map((id) => ({ id, description: id })) })
  const loaded = loadedStore(fake.ctx)
  await installDeferral(fake.ctx, resolveOptions({ pinned }), loaded)
  return { ...fake, loaded }
}

test("context hook when tools are unpinned and unloaded then hides them and lists them in system", async () => {
  const { sessionHooks } = await setup(["read", "edit"])
  const { kept, system } = await runContext(sessionHooks, "s1", TOOLS)
  assert.deepEqual(kept, ["edit", "load_tools", "read"])
  assert.deepEqual(system, ["Deferred tools (not callable until loaded with load_tools): shell, webfetch"])
})

test("context hook when shell was loaded then keeps shell", async () => {
  const { sessionHooks, loaded } = await setup(["read"])
  await loadTools(loaded, "s1", catalog, ["shell"], undefined)
  const { kept } = await runContext(sessionHooks, "s1", TOOLS)
  assert.deepEqual(kept, ["load_tools", "read", "shell"])
})

test("load_tools when two calls race on a slow storage.get then both persist", async () => {
  const { store, loaded } = await setup(["read"], 20)
  await Promise.all([
    loadTools(loaded, "s1", catalog, ["shell"], undefined),
    loadTools(loaded, "s1", catalog, ["webfetch"], undefined),
  ])
  assert.deepEqual(store.get("loaded/s1"), ["shell", "webfetch"])
})

test("context hook when custom pinned omits load_tools then still keeps load_tools", async () => {
  const { sessionHooks } = await setup(["read"])
  const { kept } = await runContext(sessionHooks, "s1", TOOLS)
  assert.ok(kept.includes("load_tools"))
})

test("context hook when execute is unpinned then still keeps execute", async () => {
  const { sessionHooks } = await setup(["read"])
  const { kept } = await runContext(sessionHooks, "s1", [...TOOLS, "execute"])
  assert.ok(kept.includes("execute"))
})

test("load_tools when query is whitespace then loads nothing", async () => {
  const { store, loaded } = await setup(["read"])
  const result = await loadTools(loaded, "s1", catalog, [], "   ")
  assert.equal(result, "No matching tools.")
  assert.equal(store.get("loaded/s1"), undefined)
})

test("load_tools when a name is unknown then reports it", async () => {
  const { store, loaded } = await setup(["read"])
  const result = await loadTools(loaded, "s1", catalog, ["shell", "nope"], undefined)
  assert.equal(result, "shell: Run a shell command\nUnknown tools: nope")
  assert.deepEqual(store.get("loaded/s1"), ["shell"])
})

test("context hook when a pinned name is unknown then warns exactly once", async (t) => {
  const warn = t.mock.method(console, "warn", () => {})
  const { sessionHooks } = await setup(["read", "ghost"])
  await runContext(sessionHooks, "s1", TOOLS)
  await runContext(sessionHooks, "s2", TOOLS)
  assert.equal(warn.mock.callCount(), 1)
  assert.equal(warn.mock.calls[0].arguments[0], "[pi-parity] pinned tools not found: ghost")
})
