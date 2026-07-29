import test, { after } from "node:test";
import {
  customLodash,
  generateTransientId,
  isFloat,
  isValidCharacterName,
  writeJsonAtomic
} from "./utils";
import assert from "node:assert";
import { NAME_VALIDATION_STATUS } from "./enums";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("customLodash", async () => {
  const lodash = new customLodash();
  const array = [1, 2, 3];
  const result = lodash.sum(array);
  assert.equal(result, 6);
});

test("isFloat", async () => {
  const result = isFloat(1.1);
  assert.equal(result, true);
});

test("transientId generator", async () => {
  const generator = generateTransientId();
  assert.equal(generator.next().value, 1);
  assert.equal(generator.next().value, 2);
  assert.equal(generator.next().value, 3);
});

test("isValidCharacterName", async () => {
  const result = isValidCharacterName("test");
  assert.equal(result, NAME_VALIDATION_STATUS.AVAILABLE);
  let invalidResult = isValidCharacterName("test@");
  assert.equal(invalidResult, NAME_VALIDATION_STATUS.INVALID);
  invalidResult = isValidCharacterName("THE)");
  assert.equal(invalidResult, NAME_VALIDATION_STATUS.INVALID);
  invalidResult = isValidCharacterName("THE");
  assert.equal(invalidResult, NAME_VALIDATION_STATUS.AVAILABLE);
  invalidResult = isValidCharacterName("test*");
  assert.equal(invalidResult, NAME_VALIDATION_STATUS.INVALID);
  invalidResult = isValidCharacterName(".**");
  assert.equal(invalidResult, NAME_VALIDATION_STATUS.INVALID);
});

test("writeJsonAtomic replaces valid JSON and preserves a backup", async (t) => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "h1emu-json-")
  );
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "data.json");
  await fs.promises.writeFile(filePath, JSON.stringify({ version: 1 }));

  await writeJsonAtomic(filePath, { version: 2 });

  assert.deepEqual(JSON.parse(await fs.promises.readFile(filePath, "utf8")), {
    version: 2
  });
  assert.deepEqual(
    JSON.parse(await fs.promises.readFile(`${filePath}.bak`, "utf8")),
    { version: 1 }
  );
});

after(() => {
  setImmediate(() => {
    process.exit(0);
  });
});
