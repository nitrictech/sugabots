import { EVENT_VERSION, type EventType, type StreamEvent } from "@sugabots/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { eventPruningLayer } from "./prune.ts";
import { memoryEventStore } from "./store.ts";

function rawEvent(type: EventType, data: Record<string, unknown> = {}): StreamEvent {
	return { ...data, v: EVENT_VERSION, type };
}

/** Running the layer starts the sweep; disposing the runtime stops it. */
function pruning(...args: Parameters<typeof eventPruningLayer>) {
	return ManagedRuntime.make(Layer.merge(eventPruningLayer(...args), Layer.empty));
}

describe("pruning", () => {
	it("disposes during a blocked sweep without starting another sweep", async () => {
		const store = memoryEventStore();
		const started = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<number>();
		const prune = vi.spyOn(store, "prune").mockImplementation(() => {
			started.resolve();
			return pending.promise;
		});
		const runtime = pruning(store, { every: "1 millis" });
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

	it("sweeps once on start, before waiting a day for the next one", async () => {
		const store = memoryEventStore();
		const prune = vi.spyOn(store, "prune");

		const runtime = pruning(store, { retentionDays: 7 });
		await runtime.runPromise(Effect.void);
		await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1));
		await runtime.dispose();

		const [cutoff] = prune.mock.calls[0] ?? [];
		const days = (Date.now() - (cutoff?.getTime() ?? 0)) / (24 * 60 * 60_000);
		expect(days).toBeCloseTo(7, 1);
	});

	it("keeps sweeping, and stops when the scope closes", async () => {
		const store = memoryEventStore();
		const prune = vi.spyOn(store, "prune");

		const runtime = pruning(store, { every: "1 millis" });
		await runtime.runPromise(Effect.void);
		await vi.waitFor(() => expect(prune.mock.calls.length).toBeGreaterThan(2));

		await runtime.dispose();
		const settled = prune.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(prune).toHaveBeenCalledTimes(settled);
	});

	it("survives a store that throws, so a failed sweep cannot take the API down", async () => {
		const store = memoryEventStore();
		await store.append("thread:c1", rawEvent("message.created"));
		vi.spyOn(store, "prune").mockRejectedValue(new Error("connection lost"));
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		const runtime = pruning(store, { every: "1 millis" });
		await runtime.runPromise(Effect.void);
		await vi.waitFor(() => expect(logged).toHaveBeenCalled());
		await runtime.dispose();

		expect(await store.has("thread:c1", 1)).toBe(true);
		logged.mockRestore();
	});
});
