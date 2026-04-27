import pino from "pino";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const LOG_DIR = "logs";

const isTest = process.env.NODE_ENV === "test";

const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
};

export const logger = isTest
  ? pino(options)
  : pino(
      options,
      pino.transport({
        targets: [
          {
            target: "pino-pretty",
            level: options.level,
          },
          {
            target: "pino-roll",
            level: options.level,
            options: {
              file: join(LOG_DIR, "log"),
              frequency: "daily",
              dateFormat: "ddMMyyyy",
              mkdir: true,
              extension: ".log",
            },
          },
        ],
      })
    );

export function logError(context: string, error: unknown): void {
  const message =
    error instanceof Error
      ? `${error.message} | ${error.stack ?? ""}`
      : String(error);
  logger.error({ context }, message);
}

export function readLog(date: string): string | null {
  const files = readdirSync(LOG_DIR).filter(
    (f) => f.startsWith(`log.${date}`) && f.endsWith(".log")
  );
  if (files.length === 0) return null;
  const path = join(LOG_DIR, files[files.length - 1]!);
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
      try {
        const obj = JSON.parse(line);
        return {
          timestamp: new Date(obj.time).toISOString().replace("T", " ").replace("Z", ""),
          level: Object.keys(pino.levels.labels).includes(String(obj.level))
            ? pino.levels.labels[obj.level as keyof typeof pino.levels.labels]!
            : String(obj.level),
          context: obj.context ?? "",
          message: obj.msg ?? "",
        };
      } catch {
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
      }
    })
    .filter((e): e is LogEntry => e !== null);
}

export function listLogDates(): string[] {
  if (!existsSync(LOG_DIR)) return [];
  try {
    const dates = new Set<string>();
    readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("log.") && f.endsWith(".log"))
      .forEach((f) => {
        const match = f.match(/^log\.(\d{8})\./);
        if (match) dates.add(match[1]!);
      });
    return [...dates].sort().reverse();
  } catch {
    return [];
  }
}
