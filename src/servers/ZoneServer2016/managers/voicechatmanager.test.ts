import assert from "node:assert";
import test from "node:test";
import { VoiceChatManager } from "./voicechatmanager";

test("disabled voice chat does not initialize the client sidecar", () => {
  const manager = new VoiceChatManager();
  manager.useVoiceChatV2 = false;
  manager.serverAddress = "127.0.0.1";

  assert.equal(manager.getVoiceInitArgs(1), undefined);
});

test("voice chat without a server address does not initialize the sidecar", () => {
  const manager = new VoiceChatManager();
  manager.useVoiceChatV2 = true;
  manager.serverAddress = "   ";

  assert.equal(manager.getVoiceInitArgs(1), undefined);
});

test("enabled voice chat initializes with a complete argument pair", () => {
  const manager = new VoiceChatManager();
  manager.useVoiceChatV2 = true;
  manager.serverAddress = "127.0.0.1";

  assert.equal(manager.getVoiceInitArgs(7), "127.0.0.1 7");
});
