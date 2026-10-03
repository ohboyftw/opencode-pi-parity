import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"

import { requestDecision, resolveOptions } from "../index.ts"

const opt = resolveOptions({ jevTimeoutMs: 50 })
const body = { question: "Which?", options: ["a", "b"] }
const call = () => requestDecision(opt, "http://jev.test", body, new AbortController().signal)

function respond(t: TestContext, status: number, text: string) {
  t.mock.method(globalThis, "fetch", async () => new Response(text, { status }))
}

test("requestDecision when the response picks an option then returns it", async (t) => {
  respond(t, 200, JSON.stringify({ choice: "b" }))
  assert.equal(await call(), "b")
})

test("requestDecision when status is not OK then throws", async (t) => {
  respond(t, 500, "boom")
  await assert.rejects(call(), /Decision request failed: 500 boom/)
})

test("requestDecision when body is not JSON then throws", async (t) => {
  respond(t, 200, "not json")
  await assert.rejects(call(), /not JSON/)
})

test("requestDecision when choice is not an option then throws", async (t) => {
  respond(t, 200, JSON.stringify({ choice: "c" }))
  await assert.rejects(call(), /not one of the options/)
})

test("requestDecision when the endpoint outlasts the timeout then aborts", async (t) => {
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) =>
    new Promise((resolve, reject) => {
      // A ref'd timer keeps the loop alive; the AbortSignal.timeout timer is unref'd.
      const timer = setTimeout(() => resolve(new Response("{}")), 5000)
      init.signal!.addEventListener("abort", () => {
        clearTimeout(timer)
        reject(init.signal!.reason)
      })
    }),
  )
  await assert.rejects(call(), { name: "TimeoutError" })
})
