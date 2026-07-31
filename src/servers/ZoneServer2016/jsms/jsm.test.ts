import assert from "node:assert";
import { test } from "node:test";
import { JSM } from "./jsm";

test("JSM reports whether an event is registered", () => {
  const fsm = new JSM<string>(
    { idle: () => {} },
    [
      {
        eventId: "wake",
        from: null,
        to: "idle",
        EnterTransition: undefined
      }
    ],
    "idle"
  );

  assert.equal(fsm.hasEvent("wake"), true);
  assert.equal(fsm.hasEvent("coverEars"), false);
});
