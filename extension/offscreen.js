// Hidden page used by the background worker to read and write the system clipboard.
const buffer = document.getElementById("buffer");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "write") {
    buffer.value = msg.text;
    buffer.select();
    const ok = document.execCommand("copy");
    buffer.value = "";
    sendResponse({ ok });
  } else if (msg.type === "read") {
    buffer.value = "";
    buffer.focus();
    document.execCommand("paste");
    const text = buffer.value;
    buffer.value = "";
    sendResponse({ ok: true, text });
  }
});
