export function debug(message: string, ...args: unknown[]) {
  // @ts-expect-error - import.meta.env is not typed
  if (import.meta.env.DEV) {
    console.log(`[codemirror-sql]`, message, ...args);
  }
}
