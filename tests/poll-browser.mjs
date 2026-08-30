const endpoint = process.argv[2] ?? "http://127.0.0.1:9222";
const deadline = Date.now() + 180_000;

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let target;
while (!target && Date.now() < deadline) {
    try {
        const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
        target = targets.find((candidate) => candidate.type === "page" && candidate.url.includes("/tests/"));
    } catch {
        // Chrome may still be starting.
    }
    if (!target) await delay(250);
}

if (!target) throw new Error("Could not find the browser test page through the DevTools endpoint.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
});

function command(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
}

let status;
while (!status && Date.now() < deadline) {
    status = await evaluate("document.body.dataset.testStatus || ''");
    if (!status) await delay(500);
}

const summary = await evaluate("document.querySelector('#results').innerText");
if (status !== "passed") {
    socket.close();
    throw new Error(`Browser tests ${status || "timed out"}:\n${summary}`);
}

const epubBase64 = await evaluate("document.querySelector('#exported-epub')?.textContent || ''");
socket.close();
console.log("BROWSER TESTS PASSED");
console.log(summary);
if (epubBase64) console.log(`EPUB_BASE64=${epubBase64}`);
