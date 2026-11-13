const fixture = await (await fetch("/fixture.json")).json();
const frame = document.createElement("iframe");
window.transport = [];
// Remix emits compilationFinished once per compile. A reloaded plugin subscribes again, but no new
// compile has happened, so the host does not replay the event. A replay ran every scenario a
// second time, and that run's submissions raced the resume checks in run.mjs.
let compilationDelivered = false;
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  const message = event.data;
  window.transport.push({ action: message.action, name: message.name, key: message.key });
  if (message.key === "handshake" && message.action === "request") {
    frame.contentWindow.postMessage(
      {
        action: "request",
        name: "manager",
        key: "handshake",
        id: 1,
        payload: ["explorerVerifyValidation"],
      },
      location.origin,
    );
  }
  if (
    message.action === "on" &&
    message.name === "solidity" &&
    message.key === "compilationFinished" &&
    !compilationDelivered
  ) {
    compilationDelivered = true;
    window.transport.push({
      action: "notification",
      name: "solidity",
      key: "compilationFinished",
    });
    frame.contentWindow.postMessage(
      {
        action: "notification",
        name: "solidity",
        key: "compilationFinished",
        payload: [
          "contracts/Counter.sol",
          fixture.buildInfo.input.sources,
          fixture.buildInfo.solcLongVersion,
          fixture.buildInfo.output,
        ],
      },
      location.origin,
    );
  }
});
frame.src = "/plugin.html";
document.body.append(frame);
