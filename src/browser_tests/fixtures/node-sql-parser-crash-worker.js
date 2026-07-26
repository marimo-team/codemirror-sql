globalThis.postMessage({
  kind: "ready",
  protocolVersion: 1,
});
globalThis.addEventListener("message", () => {
  throw new Error("Intentional parser executor crash fixture");
});
