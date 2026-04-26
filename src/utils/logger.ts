import dayjs from "dayjs";
import { mkdirSync, appendFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = "logs";

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

function logFilePath(date: string): string {
  return join(LOG_DIR, `${date}.log`);
}

export function logError(context: string, error: unknown): void {
  ensureLogDir();
  const now = dayjs();
  const date = now.format("DDMMYYYY");
  const timestamp = now.format("YYYY-MM-DD HH:mm:ss");

  const message =
    error instanceof Error
      ? `${error.message} | ${error.stack ?? ""}`
      : String(error);

  const line = `[${timestamp}] [ERROR] [${context}] ${message}\n`;
  appendFileSync(logFilePath(date), line);
}

export function readLog(date: string): string | null {
  const path = logFilePath(date);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export interface LogEntry {
  timestamp: string;
  level: string;
  context: string;
  message: string;
}

export function parseLog(content: string): LogEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.match(
        /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.+)$/
      );
      if (!match) return null;
      return {
        timestamp: match[1]!,
        level: match[2]!,
        context: match[3]!,
        message: match[4]!,
      };
    })
    .filter((e): e is LogEntry => e !== null);
}

export function listLogDates(): string[] {
  ensureLogDir();
  try {
    return readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(".log"))
      .map((f) => f.replace(".log", ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
