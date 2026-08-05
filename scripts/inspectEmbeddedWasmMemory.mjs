import { pathToFileURL } from "node:url";
import vm from "node:vm";

const modulePath = process.argv[2];
if (!modulePath) {
  throw new Error(
    "usage: node inspectEmbeddedWasmMemory.mjs <wasm-compat.mjs>"
  );
}

const imported = await import(pathToFileURL(modulePath).href);
const factorySource = imported.default.toString();
const marker = "function findWasmBinary(){return binaryDecode(";
const markerIndex = factorySource.indexOf(marker);
if (markerIndex < 0) throw new Error("embedded WASM literal was not found");

const quoteStart = markerIndex + marker.length;
const quote = factorySource[quoteStart];
if (quote !== "'" && quote !== '"') {
  throw new Error("embedded WASM literal did not start with a quote");
}
let escaped = false;
let quoteEnd = -1;
for (let index = quoteStart + 1; index < factorySource.length; index++) {
  const character = factorySource[index];
  if (escaped) {
    escaped = false;
    continue;
  }
  if (character === "\\") {
    escaped = true;
    continue;
  }
  if (character === quote) {
    quoteEnd = index;
    break;
  }
}
if (quoteEnd < 0) throw new Error("embedded WASM literal was unterminated");

const literal = factorySource.slice(quoteStart, quoteEnd + 1);
const encoded = vm.runInNewContext(literal, Object.create(null), {
  timeout: 1000
});
if (typeof encoded !== "string")
  throw new Error("decoded literal was not text");
const bytes = new Uint8Array(encoded.length);
for (let index = 0; index < encoded.length; index++) {
  const code = encoded.charCodeAt(index);
  bytes[index] = (~code >> 8) & code;
}

const expectedMagic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
if (expectedMagic.some((value, index) => bytes[index] !== value)) {
  throw new Error("decoded payload is not a WebAssembly 1.0 module");
}

let offset = 8;
function readUleb() {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (offset >= bytes.length) throw new Error("unexpected end of WASM data");
    const byte = bytes[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
    if (shift > 49) throw new Error("ULEB128 value is too large");
  }
}

let memory = null;
while (offset < bytes.length) {
  const sectionId = bytes[offset++];
  const sectionSize = readUleb();
  const sectionEnd = offset + sectionSize;
  if (sectionEnd > bytes.length) throw new Error("invalid WASM section size");
  if (sectionId === 5) {
    const count = readUleb();
    if (count !== 1) throw new Error(`expected one memory, found ${count}`);
    const flags = readUleb();
    const initialPages = readUleb();
    const maximumPages = flags & 0x01 ? readUleb() : null;
    memory = {
      flags,
      initialPages,
      maximumPages,
      shared: Boolean(flags & 0x02),
      memory64: Boolean(flags & 0x04),
      pageBytes: 65536,
      initialMiB: (initialPages * 65536) / 1048576,
      maximumMiB:
        maximumPages === null ? null : (maximumPages * 65536) / 1048576
    };
    break;
  }
  offset = sectionEnd;
}
if (!memory) throw new Error("WASM memory section was not found");
process.stdout.write(`${JSON.stringify(memory)}\n`);
