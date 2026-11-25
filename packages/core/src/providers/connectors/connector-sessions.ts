import type { ServerSession } from "./mcp.ts";

const IDLE_TIMEOUT_MS = 3 * 60_000;

export interface ConnectorSessions {
	readonly closed: boolean;
	readonly use: <A>(
		key: string,
		connect: () => Promise<ServerSession>,
		work: (session: ServerSession) => Promise<A>,
	) => Promise<A>;
	readonly close: () => Promise<void>;
}

export function connectorSessions(): ConnectorSessions {
	const sessions = new Map<string, Promise<ServerSession>>();
	let closed = false;
	let active = 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const drain = async () => {
		clearTimeout(idleTimer);
		const opened = [...sessions.values()];
		sessions.clear();
		await Promise.allSettled(
			opened.map((session) => session.then((connected) => connected.close())),
		);
	};

	return {
		get closed() {
			return closed;
		},
		use: async (key, connect, work) => {
			if (closed) throw new Error("The turn's connector sessions are closed");
			clearTimeout(idleTimer);
			active++;
			try {
				let opening = sessions.get(key);
				if (!opening) {
					opening = connect();
					sessions.set(key, opening);
				}
				const session = await opening.catch((cause) => {
					if (sessions.get(key) === opening) sessions.delete(key);
					throw cause;
				});
				if (closed) throw new Error("The turn's connector sessions are closed");
				return await work(session);
			} finally {
				active--;
				if (!closed && active === 0 && sessions.size > 0)
					idleTimer = setTimeout(() => void drain(), IDLE_TIMEOUT_MS).unref();
			}
		},
		close: () => {
			closed = true;
			return drain();
		},
	};
}
