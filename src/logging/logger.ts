import fs from "node:fs";
import path from "node:path";
import { redactObject } from "../guardrails/redact.js";

export interface LogEvent {
  ts: string;
  runId: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Structured JSONL run logger. Every event is redacted before it touches
 * disk — see guardrails/redact.ts — so a run log is safe to keep around and
 * safe to hand to a human operator during escalation without also handing
 * them raw regulated data that happened to be on screen.
 */
export class RunLogger {
  readonly runId: string;
  readonly runDir: string;
  private stream: fs.WriteStream;
  private sensitiveKeys: string[];

  constructor(runId: string, runDir: string, sensitiveKeys: string[] = []) {
    this.runId = runId;
    this.runDir = runDir;
    this.sensitiveKeys = sensitiveKeys;
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
    this.stream = fs.createWriteStream(path.join(runDir, "log.jsonl"), { flags: "a" });
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    const redacted = redactObject(data, this.sensitiveKeys);
    const evt: LogEvent = { ts: new Date().toISOString(), runId: this.runId, type, ...redacted };
    this.stream.write(JSON.stringify(evt) + "\n");
    // eslint-disable-next-line no-console
    console.log(`[${type}]`, JSON.stringify(redacted).slice(0, 300));
  }

  screenshotPath(label: string): string {
    const file = `${Date.now()}_${label.replace(/[^a-z0-9_-]/gi, "_")}.png`;
    return path.join(this.runDir, "screenshots", file);
  }

  writeJson(filename: string, data: unknown): string {
    const p = path.join(this.runDir, filename);
    fs.writeFileSync(p, JSON.stringify(redactObject(data, this.sensitiveKeys), null, 2));
    return p;
  }

  close(): void {
    this.stream.end();
  }
}

export function newRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}
