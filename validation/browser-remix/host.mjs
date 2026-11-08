const fixture = await (await fetch("/fixture.json")).json();
const frame = document.createElement("iframe");
window.transport = [];
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
    message.key === "compilationFinished"
  ) {
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
