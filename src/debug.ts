export function debug(message: string, ...args: unknown[]): void {
  if (import.meta.env?.DEV) console.log("[codemirror-sql]", message, ...args);
}
