import { WebSocket } from "ws";

/** A DevTools connection to the browser on `port`, with its pages reached through sessions. */
export async function connectToBrowser(port) {
	const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
		response.json(),
	);
	const socket = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	let nextId = 1;
	const pending = new Map();
	const listeners = new Map();
	socket.on("message", (raw) => {
		const message = JSON.parse(String(raw));
		if (message.id !== undefined) {
			const waiting = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) waiting?.reject(new Error(message.error.message));
			else waiting?.resolve(message.result);
			return;
		}
		listeners.get(message.method)?.(message.params, message.sessionId);
	});
	socket.on("close", () => {
		for (const waiting of pending.values()) waiting.reject(new Error("The browser closed"));
		pending.clear();
	});
	return {
		send: (method, params = {}, sessionId) =>
			new Promise((resolve, reject) => {
				if (socket.readyState !== WebSocket.OPEN) return reject(new Error("The browser closed"));
				const id = nextId++;
				pending.set(id, { resolve, reject });
				socket.send(JSON.stringify({ id, method, params, sessionId }));
			}),
		on: (method, listener) => listeners.set(method, listener),
		onClose: (listener) => socket.on("close", listener),
		close: () => socket.close(),
	};
}
