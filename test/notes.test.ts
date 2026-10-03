import { test } from "node:test"
import assert from "node:assert/strict"

import { installNotes } from "../index.ts"
import { fakeContext } from "./fake-context.ts"

test("note tool when called then steers a synthetic system note into the current turn", async () => {
  const { ctx, tools, synthetics } = fakeContext()
  await installNotes(ctx)
  const result = await tools.get("note")!.execute({ text: "Be terse." }, { sessionID: "s1" })
  assert.deepEqual(result, { content: "Noted." })
  assert.deepEqual(synthetics, [
    { sessionID: "s1", text: "<system-note>\nBe terse.\n</system-note>", description: "System note", delivery: "steer" },
  ])
})
