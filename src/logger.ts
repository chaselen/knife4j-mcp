export type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const payload = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  process.stderr.write(`[${timestamp}] [${level}] ${message}${payload}\n`);
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    if (process.env.LOG_LEVEL === "debug") {
      write("debug", message, meta);
    }
  },
  info(message: string, meta?: unknown): void {
    write("info", message, meta);
  },
  warn(message: string, meta?: unknown): void {
    write("warn", message, meta);
  },
  error(message: string, meta?: unknown): void {
    write("error", message, meta);
  },
};
