globalThis.postMessage({
  kind: "ready",
  protocolVersion: 1,
});
globalThis.addEventListener("message", () => {});
