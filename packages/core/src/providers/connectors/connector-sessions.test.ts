import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorSessions } from "./connector-sessions.ts";

describe("MCP sessions", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const server = () => {
		const close = vi.fn(async () => {});
		const connect = vi.fn(async () => ({
			list: async () => ({ tools: [], definitions: { tools: [] }, instructions: undefined }),
			run: async () => ({ found: true }),
			close,
		}));
		const call = (sessions: ReturnType<typeof connectorSessions>) =>
			sessions.use("connector:1", connect, (session) =>
				session.run(
					{ tools: [], definitions: { tools: [] }, instructions: undefined },
					"lookup",
					{},
					{
						toolCallId: "lookup",
						messages: [],
						context: undefined,
					},
				),
			);
		return { close, connect, call };
	};

	it("closes during an idle wait and reconnects on the next call", async () => {
		const sessions = connectorSessions();
		const { close, connect, call } = server();
		await call(sessions);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		await call(sessions);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(close).not.toHaveBeenCalled();
		expect(connect).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(close).toHaveBeenCalledOnce();
		expect(await call(sessions)).toEqual({ found: true });
		expect(connect).toHaveBeenCalledTimes(2);
		await sessions.close();
		expect(close).toHaveBeenCalledTimes(2);
	});

	it("keeps an in-flight call open and prevents reopening after disposal", async () => {
		const sessions = connectorSessions();
		const { close, connect, call } = server();
		const pending = Promise.withResolvers<void>();
		const running = sessions.use("connector:1", connect, () => pending.promise);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(close).not.toHaveBeenCalled();

		pending.resolve();
		await running;
		await sessions.close();
		await expect(call(sessions)).rejects.toThrow("sessions are closed");
		expect(close).toHaveBeenCalledOnce();
		expect(connect).toHaveBeenCalledOnce();
	});
});
