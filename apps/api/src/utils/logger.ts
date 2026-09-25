type Level = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<Level, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const DEFAULT_LEVEL_VALUE = LEVEL_VALUE.info;

// Workers Logs truncates a single log line at 256 KB and caps the whole
// request at 256 KB of log data, after which the rest of the request's logs
// are dropped. So log ids, counts, reason enums and durations only. Never dump
// an HFM or LINE payload in here: one dump costs the entire incident's logs.

function thresholdValue(): number {
  // Read per call, not at module load, so tests can flip LOG_LEVEL between
  // cases. On Workers, process.env holds this tenant's vars.
  const configured = (process.env.LOG_LEVEL ?? "info").trim() as Level;
  return LEVEL_VALUE[configured] ?? DEFAULT_LEVEL_VALUE;
}

function emit(level: Level, obj: object, msg?: string): void {
  if (LEVEL_VALUE[level] < thresholdValue()) return;

  // One object argument, not a pre-stringified line: Workers Logs indexes
  // every field of an object passed to console.log with unlimited cardinality,
  // while a JSON string arrives as one unqueryable message blob.
  const line: Record<string, unknown> = {
    level,
    time: Date.now(),
    tenant: process.env.TENANT ?? "unknown",
    ...obj,
    ...(msg === undefined ? {} : { msg }),
  };

  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// A plain mutable object on purpose. tests/flex-message.builder.test.ts:438
// swaps `logger.warn` for a recorder and restores it at :443.
export const logger = {
  debug(o: object, m?: string): void {
    emit("debug", o, m);
  },
  info(o: object, m?: string): void {
    emit("info", o, m);
  },
  warn(o: object, m?: string): void {
    emit("warn", o, m);
  },
  error(o: object, m?: string): void {
    emit("error", o, m);
  },
};

export function logError(context: string, error: unknown): void {
  const message =
    error instanceof Error
      ? `${error.message} | ${error.stack ?? ""}`
      : String(error);
  logger.error({ context }, message);
}

// Structured info/warn for permanent production logging. `fields` carries the
// searchable values (ids, durations, reason enums); `message` stays a short
// stable phrase so log greps stay simple.
export function logInfo(
  context: string,
  fields: Record<string, unknown>,
  message: string,
): void {
  logger.info({ context, ...fields }, message);
}

export function logWarn(
  context: string,
  fields: Record<string, unknown>,
  message: string,
): void {
  logger.warn({ context, ...fields }, message);
}
