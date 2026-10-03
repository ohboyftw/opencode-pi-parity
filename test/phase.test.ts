import { test } from "node:test"
import assert from "node:assert/strict"

import { installPhaseSwitch, resolveOptions } from "../index.ts"
import { fakeContext } from "./fake-context.ts"

const plan = { providerID: "a", id: "plan" }
const implement = { providerID: "b", id: "impl" }

async function setup(switchModel?: (input: unknown) => Promise<void>) {
  const fake = fakeContext({ switchModel })
  await installPhaseSwitch(fake.ctx, resolveOptions({ planModel: plan, implementModel: implement }))
  const prompt = () => fake.sessionHooks.get("prompt")!({ sessionID: "s1" })
  const edit = () => fake.toolHooks.get("execute.after")!({ sessionID: "s1", tool: "edit", status: "completed" })
  const models = () => fake.switches.map((s) => s.model.id)
  return { ...fake, prompt, edit, models }
}

test("phase switch when a prompt arrives then switches to the plan model", async () => {
  const { prompt, models } = await setup()
  await prompt()
  assert.deepEqual(models(), ["plan"])
})

test("phase switch when an edit completes then switches to the implement model", async () => {
  const { prompt, edit, models } = await setup()
  await prompt()
  await edit()
  assert.deepEqual(models(), ["plan", "impl"])
})

test("phase switch when a second edit completes then does not switch again", async () => {
  const { prompt, edit, models } = await setup()
  await prompt()
  await edit()
  await edit()
  assert.deepEqual(models(), ["plan", "impl"])
})

test("phase switch when the next prompt follows an edit then switches back to plan", async () => {
  const { prompt, edit, models } = await setup()
  await prompt()
  await edit()
  await prompt()
  assert.deepEqual(models(), ["plan", "impl", "plan"])
})

test("phase switch when switchModel rejects then phase stays unstored and a retry switches", async () => {
  let fail = true
  const { prompt, store, models } = await setup(async () => {
    if (fail) throw new Error("switch failed")
  })
  await assert.rejects(prompt(), /switch failed/)
  assert.equal(store.get("phase/s1"), undefined)
  fail = false
  await prompt()
  assert.deepEqual(models(), ["plan"])
})
