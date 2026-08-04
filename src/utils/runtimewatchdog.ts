// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

export const RUNTIME_PHASES = [
  "idle",
  "ai-fsm",
  "pathfinding-sync",
  "path-stream-window",
  "path-npc-remove",
  "path-npc-create",
  "path-npc-read",
  "path-npc-ground",
  "path-npc-collision",
  "path-npc-collision-reset",
  "path-npc-replicate",
  "path-character-create",
  "path-character-teleport",
  "path-vehicle-create",
  "path-vehicle-teleport",
  "nav-nearest-poly",
  "nav-agent-add",
  "nav-agent-remove",
  "nav-agent-teleport",
  "nav-cache-add-layer",
  "nav-cache-build-column",
  "nav-mesh-remove-tile",
  "nav-obstacle-update",
  "nav-streamed-obstacles",
  "nav-crowd-update",
  "world-routine",
  "world-tick",
  "client-ticks",
  "soe-send",
  "soe-receive",
  "npc-spawn"
] as const;

export type RuntimePhase = (typeof RUNTIME_PHASES)[number];

const HEARTBEAT_MS = 250;
const DEFAULT_STALL_MS = 2_000;
const HEARTBEAT_AT = 0;
const ACTIVE_PHASE = 1;
const ACTIVE_SINCE = 2;
const PHASE_SEQUENCE = 3;
const LAST_COMPLETED_PHASE = 4;
const LAST_COMPLETED_DURATION = 5;
const HEARTBEAT_SEQUENCE = 6;
const PHASE_DETAIL_A = 7;
const PHASE_DETAIL_B = 8;
const SLOT_COUNT = 9;

type PhaseToken = {
  previousPhase: bigint;
  previousStartedAt: bigint;
  previousDetailA: bigint;
  previousDetailB: bigint;
};

type WatchdogOptions = {
  enabled: boolean;
  stallMs?: number;
  logPath?: string;
};

class RuntimeWatchdog {
  private readonly state: BigInt64Array;
  private readonly worker: Worker;
  private readonly heartbeatTimer: NodeJS.Timeout;
  readonly logPath: string;

  constructor(options: WatchdogOptions) {
    const appData = process.env.APPDATA || homedir();
    this.logPath =
      options.logPath ??
      join(appData, "h1emu", "logs", "server-watchdog.jsonl");
    mkdirSync(dirname(this.logPath), { recursive: true });

    const sharedState = new SharedArrayBuffer(
      BigInt64Array.BYTES_PER_ELEMENT * SLOT_COUNT
    );
    this.state = new BigInt64Array(sharedState);
    this.beat();

    appendFileSync(
      this.logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "watchdog-start",
        pid: process.pid,
        stallMs: options.stallMs ?? DEFAULT_STALL_MS
      })}\n`
    );

    this.worker = new Worker(
      `
        const { appendFileSync } = require("node:fs");
        const { workerData } = require("node:worker_threads");
        const state = new BigInt64Array(workerData.sharedState);
        let stalled = false;
        let lastStallKey = "";

        function snapshot(now) {
          const heartbeatAt = Number(Atomics.load(state, ${HEARTBEAT_AT}));
          const phaseId = Number(Atomics.load(state, ${ACTIVE_PHASE}));
          const activeSince = Number(Atomics.load(state, ${ACTIVE_SINCE}));
          const phaseSequence = Number(Atomics.load(state, ${PHASE_SEQUENCE}));
          const lastCompletedId = Number(
            Atomics.load(state, ${LAST_COMPLETED_PHASE})
          );
          const phaseDetailA = Number(Atomics.load(state, ${PHASE_DETAIL_A}));
          const phaseDetailB = Number(Atomics.load(state, ${PHASE_DETAIL_B}));
          return {
            heartbeatAt,
            phaseId,
            activeSince,
            phaseSequence,
            lastCompletedId,
            lastCompletedDurationMs: Number(
              Atomics.load(state, ${LAST_COMPLETED_DURATION})
            ),
            phaseDetailA,
            phaseDetailB,
            heartbeatSequence: Number(
              Atomics.load(state, ${HEARTBEAT_SEQUENCE})
            ),
            staleForMs: now - heartbeatAt
          };
        }

        function write(event) {
          try {
            appendFileSync(
              workerData.logPath,
              JSON.stringify({
                timestamp: new Date().toISOString(),
                pid: workerData.pid,
                ...event
              }) + "\\n"
            );
          } catch {}
        }

        const timer = setInterval(() => {
          const now = Date.now();
          const current = snapshot(now);
          if (current.staleForMs >= workerData.stallMs) {
            const key =
              current.phaseSequence + ":" +
              current.heartbeatAt + ":" +
              current.phaseId;
            if (key !== lastStallKey) {
              lastStallKey = key;
              stalled = true;
              write({
                event: "main-loop-stall",
                staleForMs: current.staleForMs,
                activePhase:
                  workerData.phaseNames[current.phaseId] ?? "unknown",
                activeForMs:
                  current.activeSince > 0 ? now - current.activeSince : 0,
                phaseDetailA: current.phaseDetailA,
                phaseDetailB: current.phaseDetailB,
                phaseSequence: current.phaseSequence,
                lastCompletedPhase:
                  workerData.phaseNames[current.lastCompletedId] ?? "unknown",
                lastCompletedDurationMs: current.lastCompletedDurationMs,
                heartbeatSequence: current.heartbeatSequence
              });
            }
          } else if (stalled) {
            stalled = false;
            write({
              event: "main-loop-recovered",
              activePhase:
                workerData.phaseNames[current.phaseId] ?? "unknown",
              heartbeatSequence: current.heartbeatSequence
            });
          }
        }, ${HEARTBEAT_MS});
      `,
      {
        eval: true,
        workerData: {
          sharedState,
          logPath: this.logPath,
          pid: process.pid,
          stallMs: options.stallMs ?? DEFAULT_STALL_MS,
          phaseNames: RUNTIME_PHASES
        }
      }
    );
    this.worker.unref();
    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  beat(): void {
    Atomics.store(this.state, HEARTBEAT_AT, BigInt(Date.now()));
    Atomics.add(this.state, HEARTBEAT_SEQUENCE, 1n);
  }

  enter(phase: RuntimePhase, detailA = 0, detailB = 0): PhaseToken {
    const phaseId = BigInt(RUNTIME_PHASES.indexOf(phase));
    const previousPhase = Atomics.load(this.state, ACTIVE_PHASE);
    const previousStartedAt = Atomics.load(this.state, ACTIVE_SINCE);
    const previousDetailA = Atomics.load(this.state, PHASE_DETAIL_A);
    const previousDetailB = Atomics.load(this.state, PHASE_DETAIL_B);
    Atomics.add(this.state, PHASE_SEQUENCE, 1n);
    const now = BigInt(Date.now());
    Atomics.store(this.state, ACTIVE_PHASE, phaseId);
    Atomics.store(this.state, ACTIVE_SINCE, now);
    Atomics.store(this.state, PHASE_DETAIL_A, BigInt(detailA));
    Atomics.store(this.state, PHASE_DETAIL_B, BigInt(detailB));
    Atomics.store(this.state, HEARTBEAT_AT, now);
    return {
      previousPhase,
      previousStartedAt,
      previousDetailA,
      previousDetailB
    };
  }

  exit(phase: RuntimePhase, token: PhaseToken): void {
    const completedAt = BigInt(Date.now());
    const startedAt = Atomics.load(this.state, ACTIVE_SINCE);
    Atomics.store(
      this.state,
      LAST_COMPLETED_PHASE,
      BigInt(RUNTIME_PHASES.indexOf(phase))
    );
    Atomics.store(
      this.state,
      LAST_COMPLETED_DURATION,
      startedAt > 0n ? completedAt - startedAt : 0n
    );
    Atomics.add(this.state, PHASE_SEQUENCE, 1n);
    Atomics.store(this.state, ACTIVE_PHASE, token.previousPhase);
    Atomics.store(this.state, ACTIVE_SINCE, token.previousStartedAt);
    Atomics.store(this.state, PHASE_DETAIL_A, token.previousDetailA);
    Atomics.store(this.state, PHASE_DETAIL_B, token.previousDetailB);
    Atomics.store(this.state, HEARTBEAT_AT, completedAt);
    Atomics.add(this.state, HEARTBEAT_SEQUENCE, 1n);
  }

  stop(): void {
    clearInterval(this.heartbeatTimer);
    void this.worker.terminate();
  }
}

let watchdog: RuntimeWatchdog | undefined;

export function startRuntimeWatchdog(options: WatchdogOptions): string | null {
  if (!options.enabled) return null;
  watchdog ??= new RuntimeWatchdog(options);
  return watchdog.logPath;
}

export function stopRuntimeWatchdog(): void {
  watchdog?.stop();
  watchdog = undefined;
}

export function beatRuntimeWatchdog(): void {
  watchdog?.beat();
}

export function runRuntimePhase<T>(
  phase: RuntimePhase,
  callback: () => T,
  detailA = 0,
  detailB = 0
): T {
  if (!watchdog) return callback();
  const token = watchdog.enter(phase, detailA, detailB);
  try {
    return callback();
  } finally {
    watchdog.exit(phase, token);
  }
}
