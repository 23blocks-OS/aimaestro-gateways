/** Redacts SDK diagnostics so message content and receive identifiers never enter logs. */
import type { Logger } from "@larksuiteoapi/node-sdk";

function write(level: "debug" | "info" | "warn" | "error" | "trace"): void {
  if (level === "error") console.error(`[LARK SDK] ${level} event (details redacted)`);
  else if (level === "warn") console.warn(`[LARK SDK] ${level} event (details redacted)`);
}

export const larkLogger: Logger = {
  debug: () => write("debug"),
  info: () => write("info"),
  warn: () => write("warn"),
  error: () => write("error"),
  trace: () => write("trace"),
};
