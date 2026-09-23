import { type CollaborationPart, streamEvent } from "@sugabots/contracts";
import { type Duration, Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../../database/database.ts";
import { createEventBus } from "../../../database/events/bus.ts";
import { memoryEventStore } from "../../../database/events/store.ts";
import { noDatabase } from "../../../database/testing.ts";
import { CollaborationRefused, type CollaborationStore } from "./store.ts";
import { collaborateTool } from "./tool.ts";

/**
 * The tool over a fake store and a real in-memory bus: the store decides what
 * is written; this is about waiting for the answer and giving up gracefully.
 */

const run = effectRunner(ManagedRuntime.make(noDatabase));
const from = { threadId: "t-root", agentId: "a-host", turnId: "turn-1", messageId: "m-reply" };
const collaboration: CollaborationPart = {
	type: "collaboration",
	id: "d-1",
	agentId: "a-helper",
	agentName: "Helper",
	threadId: "t-child",
	brief: "Look",
	status: "waiting",
	answer: null,
	atOffset: 12,
};
const opened = { collaboration, collaborator: { id: "a-helper", name: "Helper" } };

function fakeStore(answer: () => string | undefined): CollaborationStore {
	return {
		open: vi.fn(() => Effect.succeed(opened)),
		stopWaiting: vi.fn(() => Effect.succeed(answer() === undefined)),
		readAnswer: vi.fn(() => Effect.succeed(answer())),
		deliverAnswer: vi.fn(() => Effect.succeed(true)),
	};
}

function toolWith(
	store: CollaborationStore,
	options: {
		bus?: ReturnType<typeof createEventBus>;
		wait?: Duration.Input;
		signal?: AbortSignal;
	} = {},
) {
	const noted: Array<Pick<CollaborationPart, "id" | "atOffset">> = [];
	const tool = collaborateTool({
		from,
		collaborations: store,
		bus: options.bus ?? createEventBus({ store: memoryEventStore() }),
		run,
		replyLength: () => 12,
		noteCollaboration: (made) => Effect.sync(() => void noted.push(made)),
		signal: options.signal ?? new AbortController().signal,
		wait: options.wait ?? "2 seconds",
	});
	return { tool, noted };
}

async function call(
	tool: ReturnType<typeof collaborateTool>,
	input: { to: string; brief: string },
) {
	const options = { toolCallId: "call", messages: [] } as unknown as Parameters<
		NonNullable<typeof tool.execute>
	>[1];
	return tool.execute?.(input, options);
}

describe("collaborate tool", () => {
	it("returns the answer when the collaborator's turn completes in time, and marks the reply", async () => {
		const bus = createEventBus({ store: memoryEventStore() });
		let answer: string | undefined;
		const store = fakeStore(() => answer);
		const { tool, noted } = toolWith(store, { bus });

		const pending = call(tool, { to: "Helper", brief: "Look" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		answer = "All good.";
		await bus.publish(
			"thread:t-child",
			streamEvent("turn.completed", { threadId: "t-child", turnId: "turn-2", status: "done" }),
		);

		expect(await pending).toEqual({ status: "answered", answer: "All good." });
		expect(store.open).toHaveBeenCalledWith({
			from: { ...from, atOffset: 12 },
			to: "Helper",
			brief: "Look",
		});
		expect(noted).toEqual([collaboration]);
	});

	it("gives up after the wait and says the answer is still coming", async () => {
		const store = fakeStore(() => undefined);
		const { tool } = toolWith(store, { wait: "20 millis" });

		const result = await call(tool, { to: "Helper", brief: "Look" });

		expect(result).toMatchObject({ status: "pending", threadId: "t-child" });
		expect(store.stopWaiting).toHaveBeenCalledWith("d-1");
	});

	it("hands a refusal back to the model rather than failing the turn", async () => {
		const store = fakeStore(() => undefined);
		vi.mocked(store.open).mockReturnValueOnce(
			Effect.fail(new CollaborationRefused({ reason: "An agent cannot collaborate with itself" })),
		);
		const { tool, noted } = toolWith(store);

		expect(await call(tool, { to: "Host", brief: "Look" })).toEqual({
			status: "refused",
			reason: "An agent cannot collaborate with itself",
		});
		expect(noted).toEqual([]);
	});

	it.each([true, false])(
		"stops waiting when aborted (already aborted: %s)",
		async (alreadyAborted) => {
			const controller = new AbortController();
			const bus = createEventBus({ store: memoryEventStore() });
			const subscribe = vi.spyOn(bus, "subscribe");
			const store = fakeStore(() => undefined);
			const { tool } = toolWith(store, { bus, signal: controller.signal, wait: "1 minute" });
			if (alreadyAborted) {
				controller.abort();
			}
			const pending = call(tool, { to: "Helper", brief: "Look" });
			if (!alreadyAborted) {
				await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
				controller.abort();
			}
			expect(await pending).toMatchObject({ status: "pending", threadId: "t-child" });
			expect(store.stopWaiting).toHaveBeenCalledWith("d-1");
			if (alreadyAborted) {
				expect(subscribe).not.toHaveBeenCalled();
			} else {
				expect(subscribe.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			}
		},
	);

	it("reads an answer that arrives between timeout and stopping the wait", async () => {
		const store = fakeStore(() => "Just finished.");
		const { tool } = toolWith(store, { wait: 1 });
		expect(await call(tool, { to: "Helper", brief: "Look" })).toEqual({
			status: "answered",
			answer: "Just finished.",
		});
		expect(store.stopWaiting).toHaveBeenCalledWith("d-1");
	});
});
