import fs from "node:fs";
import path from "node:path";

export interface DiscoveryPointer {
  runId: string;
  runDir: string;
  cdpUrl: string;
  traceFile: string;
  pid: number;
}

export function pointerPath(runId: string, evidenceRoot = "evidence"): string {
  return path.join(evidenceRoot, runId, "pointer.json");
}

export function writePointer(p: DiscoveryPointer): void {
  fs.mkdirSync(path.dirname(pointerPath(p.runId)), { recursive: true });
  fs.writeFileSync(pointerPath(p.runId), JSON.stringify(p, null, 2));
}

export function readPointer(runId: string): DiscoveryPointer {
  return JSON.parse(fs.readFileSync(pointerPath(runId), "utf-8"));
}
