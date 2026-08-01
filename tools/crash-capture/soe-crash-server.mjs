import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;

function parseArgs(args) {
  const options = {
    host: "127.0.0.1",
    port: 4750,
    output: join(process.env.APPDATA || homedir(), "h1emu", "crashes")
  };
  for (const arg of args) {
    const [name, ...valueParts] = arg.split("=");
    const value = valueParts.join("=");
    if (name === "--host" && value) options.host = value;
    if (name === "--port" && value) options.port = Number(value);
    if (name === "--output" && value) options.output = resolve(value);
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  return options;
}

function printableText(buffer) {
  return buffer.toString("utf8").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ".");
}

export async function createCrashCaptureServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4750;
  const output = resolve(
    options.output ?? join(process.env.APPDATA || homedir(), "h1emu", "crashes")
  );
  await mkdir(output, { recursive: true });

  const server = createServer((socket) => {
    const chunks = [];
    let length = 0;
    const connectedAt = new Date();
    socket.setTimeout(30_000);

    socket.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_REPORT_BYTES) {
        socket.destroy(new Error("Crash report exceeded 64 MiB"));
        return;
      }
      chunks.push(chunk);
    });

    socket.on("timeout", () => socket.end());
    socket.on("error", (error) => {
      console.error(`[CRASH CAPTURE] socket error: ${error.message}`);
    });
    socket.on("close", async () => {
      if (!length || length > MAX_REPORT_BYTES) return;
      const payload = Buffer.concat(chunks, length);
      const stamp = connectedAt.toISOString().replace(/[:.]/g, "-");
      const base = `h1z1-crash-${stamp}-${process.pid}`;
      const metadata = {
        timestamp: connectedAt.toISOString(),
        remoteAddress: socket.remoteAddress ?? null,
        remotePort: socket.remotePort ?? null,
        bytes: payload.length,
        binaryFile: `${base}.bin`,
        textFile: `${base}.txt`
      };
      await Promise.all([
        writeFile(join(output, metadata.binaryFile), payload),
        writeFile(
          join(output, metadata.textFile),
          printableText(payload),
          "utf8"
        ),
        writeFile(
          join(output, `${base}.json`),
          `${JSON.stringify(metadata, null, 2)}\n`,
          "utf8"
        )
      ]);
      console.log(
        `[CRASH CAPTURE] saved ${payload.length} bytes to ${join(output, base)}`
      );
    });
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  return { server, host, port: server.address().port, output };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const options = parseArgs(process.argv.slice(2));
  const running = await createCrashCaptureServer(options);
  console.log(
    `[CRASH CAPTURE] listening on ${running.host}:${running.port}; output=${running.output}`
  );
  const stop = () => running.server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
