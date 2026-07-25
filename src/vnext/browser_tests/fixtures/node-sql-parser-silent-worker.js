globalThis.postMessage({
  kind: "ready",
  protocolVersion: 2,
});
globalThis.addEventListener("message", () => {});
