import { EVENT_VERSION, type EventType, type StreamEvent } from "@sugabots/contracts";
import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";
import { EventPruning } from "./prune.ts";
import { EventStore } from "./store.ts";

function rawEvent(type: EventType, data: Record<string, unknown> = {}): StreamEvent {
	return { ...data, v: EVENT_VERSION, type };
}

/**
 * Running the layer starts the sweep on a test clock, which `passes` moves on;
 * disposing the runtime stops it.
 */
function pruning(store: EventStore.Interface) {
	const runtime = ManagedRuntime.make(
		EventPruning.layer.pipe(
			Layer.provide(Layer.succeed(EventStore.Service, store)),
			Layer.provideMerge(TestClock.layer()),
		),
	);
	return {
		runtime,
		passes: (duration: Duration.Input) => runtime.runPromise(TestClock.adjust(duration)),
	};
}

describe("pruning", () => {
	it("disposes during a blocked sweep without starting another sweep", async () => {
		const store = EventStore.inMemory();
		const started = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<number>();
		const prune = vi.spyOn(store, "prune").mockImplementation(() => {
			started.resolve();
			return pending.promise;
		});
		const { runtime } = pruning(store);
		try {
			await runtime.runPromise(Effect.void);
			await started.promise;
			await runtime.dispose();
			pending.resolve(0);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(prune).toHaveBeenCalledTimes(1);
		} finally {
			pending.resolve(0);
			await runtime.dispose();
		}
	});

	it("sweeps what is over a week old once on start, and again a day later", async () => {
		const store = EventStore.inMemory();
		const prune = vi.spyOn(store, "prune");

		const { runtime, passes } = pruning(store);
		await runtime.runPromise(Effect.void);
		await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));
		const [cutoff] = prune.mock.calls[0] ?? [];
		expect(cutoff?.getTime()).toBe(-Duration.toMillis(Duration.days(7)));

		await passes(Duration.hours(23));
		expect(prune).toHaveBeenCalledTimes(1);
		await passes(Duration.hours(1));
		await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(2));
		await runtime.dispose();
	});

	it("keeps sweeping, and stops when the scope closes", async () => {
		const store = EventStore.inMemory();
		const prune = vi.spyOn(store, "prune");

		const { runtime, passes } = pruning(store);
		await runtime.runPromise(Effect.void);
		await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));
		await passes(Duration.days(1));
		await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(2));
		await passes(Duration.days(1));
		await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(3));

		await runtime.dispose();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(prune).toHaveBeenCalledTimes(3);
	});

	it("survives a store that throws, so a failed sweep cannot take the API down", async () => {
		const store = EventStore.inMemory();
		await store.append("thread:c1", rawEvent("message.created"));
		const prune = vi.spyOn(store, "prune").mockRejectedValue(new Error("connection lost"));

		const { runtime, passes } = pruning(store);
		await runtime.runPromise(Effect.void);
		await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));
		await passes(Duration.days(1));
		await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(2));
		await runtime.dispose();

		expect(await store.has("thread:c1", 1)).toBe(true);
	});
});
