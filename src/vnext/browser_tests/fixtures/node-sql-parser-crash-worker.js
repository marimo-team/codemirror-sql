globalThis.postMessage({
  kind: "ready",
  protocolVersion: 2,
});
globalThis.addEventListener("message", () => {
  throw new Error("Intentional parser executor crash fixture");
});
