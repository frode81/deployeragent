import { EventEmitter } from "events";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR ?? "/data/deployments";

const emitters = new Map<string, EventEmitter>();

export function getEmitter(deploymentId: string): EventEmitter {
  if (!emitters.has(deploymentId)) {
    emitters.set(deploymentId, new EventEmitter());
  }
  return emitters.get(deploymentId)!;
}

export function appendLog(deploymentId: string, line: string) {
  const dir = join(DATA_DIR, deploymentId);
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${line}\n`;
  appendFileSync(join(dir, "build.log"), entry);
  getEmitter(deploymentId).emit("log", line);
}

export function readLogs(deploymentId: string): string {
  const path = join(DATA_DIR, deploymentId, "build.log");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function cleanupEmitter(deploymentId: string) {
  emitters.delete(deploymentId);
}
