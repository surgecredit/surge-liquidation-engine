import fs from "node:fs";

export type LogLevel = "info" | "success" | "warn" | "error" | "action" | "debug";

export interface LogEntry {
  ts: Date;
  level: LogLevel;
  msg: string;
}

type Sink = (e: LogEntry) => void;

/**
 * Fan-out logger. Every line goes to each registered sink (the terminal UI,
 * a plain console, an optional file). Keeps no formatting opinions itself.
 */
export class Logger {
  private sinks: Sink[] = [];
  private fileStream?: fs.WriteStream;

  constructor(logFile?: string) {
    if (logFile) {
      this.fileStream = fs.createWriteStream(logFile, { flags: "a" });
    }
  }

  addSink(sink: Sink): void {
    this.sinks.push(sink);
  }

  log(level: LogLevel, msg: string): void {
    const e: LogEntry = { ts: new Date(), level, msg };
    for (const sink of this.sinks) {
      try {
        sink(e);
      } catch {
        // never let a broken sink take down the engine
      }
    }
    this.fileStream?.write(`${e.ts.toISOString()} [${level.toUpperCase()}] ${msg}\n`);
  }

  info(m: string): void { this.log("info", m); }
  success(m: string): void { this.log("success", m); }
  warn(m: string): void { this.log("warn", m); }
  error(m: string): void { this.log("error", m); }
  action(m: string): void { this.log("action", m); }
  debug(m: string): void { this.log("debug", m); }

  close(): void {
    this.fileStream?.end();
  }
}

/** Best-effort extraction of a short message from an unknown thrown value. */
export function errMsg(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as { code?: string; shortMessage?: string; message?: string };
    if (anyE.code && anyE.shortMessage) return `${anyE.code}: ${anyE.shortMessage}`;
    if (anyE.code && anyE.message) return `${anyE.code}: ${anyE.message}`;
    if (anyE.shortMessage) return anyE.shortMessage;
    if (anyE.message) return anyE.message;
  }
  return String(e);
}
