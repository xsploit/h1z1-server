import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type ThrowableTraceDetails = Record<
  string,
  string | number | boolean | null | undefined
>;

const tracePath =
  process.env.H1EMU_THROWABLE_TRACE_PATH ??
  join(
    process.env.APPDATA || homedir(),
    "h1emu",
    "logs",
    "throwable-trace.jsonl"
  );

let initialized = false;

export function traceThrowable(
  event: string,
  details: ThrowableTraceDetails = {}
): void {
  if (process.env.H1EMU_THROWABLE_TRACE === "0") return;
  try {
    if (!initialized) {
      mkdirSync(dirname(tracePath), { recursive: true });
      initialized = true;
    }
    appendFileSync(
      tracePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        event,
        ...details
      })}\n`
    );
  } catch {
    // Diagnostics must never interfere with the simulation or packet path.
  }
}

export function getThrowableTracePath(): string {
  return tracePath;
}
