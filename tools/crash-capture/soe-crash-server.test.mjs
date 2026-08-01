import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCrashCaptureServer } from "./soe-crash-server.mjs";

test("captures one crash payload with binary, text, and metadata", async () => {
  const output = await mkdtemp(join(tmpdir(), "h1emu-crash-test-"));
  const running = await createCrashCaptureServer({
    host: "127.0.0.1",
    port: 0,
    output
  });
  const payload = Buffer.from("grenade-crash\0packet-tail");

  await new Promise((resolveSend, reject) => {
    const socket = connect(running.port, running.host, () =>
      socket.end(payload)
    );
    socket.once("close", resolveSend);
    socket.once("error", reject);
  });

  let files = [];
  for (let attempt = 0; attempt < 20 && files.length < 3; attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    files = await readdir(output);
  }
  await new Promise((resolveClose) => running.server.close(resolveClose));

  assert.equal(files.filter((file) => file.endsWith(".bin")).length, 1);
  assert.equal(files.filter((file) => file.endsWith(".txt")).length, 1);
  assert.equal(files.filter((file) => file.endsWith(".json")).length, 1);
  const binary = await readFile(
    join(
      output,
      files.find((file) => file.endsWith(".bin"))
    )
  );
  assert.deepEqual(binary, payload);
});
