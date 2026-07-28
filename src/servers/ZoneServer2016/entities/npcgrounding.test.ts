import assert from "node:assert";
import test from "node:test";
import { getInitialNpcNavPosition } from "./npc";

test("NPC initial position uses the nav-agent surface position", () => {
  const agent = {
    position: () => ({ x: 12.5, y: 47.25, z: -8.75 })
  };

  assert.deepEqual(
    Array.from(getInitialNpcNavPosition(agent as never)),
    [12.5, 47.25, -8.75, 0]
  );
});
