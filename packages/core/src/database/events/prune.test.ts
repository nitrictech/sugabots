import { Duration, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { EventPruning } from "./prune.ts";
import { EventStore } from "./store.ts";
import { inMemoryEventStore } from "./testing.ts";

const A_DAY = Duration.days(1);

/**
 * A store that records each sweep's cutoff and answers it with `prune`, and a
 * pruning layer over it running on a test clock that outlives the layer's
 * scope, so a case can move time on after the scope has closed.
 */
async function sweeping(prune: (sweepNumber: number) => Promise<number> = async () => 0) {
	const cutoffs: Date[] = [];
	const waiting: Array<{ count: number; resolve: () => void }> = [];
	const store: EventStore.Interface = {
		...inMemoryEventStore(),
		prune: (before) => {
			cutoffs.push(before);
			for (const { count, resolve } of waiting) if (cutoffs.length === count) resolve();
			return prune(cutoffs.length);
		},
	};
	const runtime = ManagedRuntime.make(TestClock.layer());
	const scope = await runtime.runPromise(Scope.make());
	await runtime.runPromise(
		Layer.buildWithScope(
			EventPruning.layer.pipe(Layer.provide(Layer.succeed(EventStore.Service, store))),
			scope,
		),
	);
	return {
		cutoffs,
		/** Resolves once `count` sweeps have started. */
		started: (count: number) =>
			new Promise<void>((resolve) => {
				if (cutoffs.length >= count) resolve();
				else waiting.push({ count, resolve });
			}),
		/** Moves the clock on, then lets what that woke run as far as it can without more time. */
		passes: async (duration: Duration.Input) => {
			await runtime.runPromise(TestClock.adjust(duration));
			await new Promise((resolve) => setImmediate(resolve));
		},
		/** Lets what is running reach its next wait, which a case that moves the clock next needs. */
		settled: () => new Promise((resolve) => setImmediate(resolve)),
		closeScope: () => runtime.runPromise(Scope.close(scope, Exit.void)),
		dispose: () => runtime.dispose(),
	};
}

describe("pruning", () => {
	it("sweeps what is over a week old once on start and again each day, until the scope closes", async () => {
		const pruning = await sweeping();
		try {
			await pruning.started(1);
			await pruning.settled();
			await pruning.passes(Duration.hours(23));
			const beforeADay = pruning.cutoffs.length;
			await pruning.passes(Duration.hours(1));
			await pruning.started(2);
			await pruning.settled();
			await pruning.passes(A_DAY);
			await pruning.started(3);
			await pruning.settled();

			await pruning.closeScope();
			await pruning.passes(A_DAY);

			// The clock starts at the epoch, so each cutoff is a week before its sweep.
			expect(pruning.cutoffs.map((cutoff) => cutoff.getTime())).toEqual([
				-Duration.toMillis(Duration.days(7)),
				Duration.toMillis(Duration.days(1 - 7)),
				Duration.toMillis(Duration.days(2 - 7)),
			]);
			expect(beforeADay).toBe(1);
		} finally {
			await pruning.dispose();
		}
	});

	it("disposes during a blocked sweep without starting another sweep", async () => {
		const blocked = Promise.withResolvers<number>();
		const pruning = await sweeping(() => blocked.promise);
		try {
			await pruning.started(1);

			await pruning.closeScope();
			blocked.resolve(0);
			await pruning.settled();
			await pruning.passes(A_DAY);

			expect(pruning.cutoffs).toHaveLength(1);
		} finally {
			blocked.resolve(0);
			await pruning.dispose();
		}
	});

	it("sweeps again the next day after a store that throws, so a failed sweep cannot take the API down", async () => {
		const pruning = await sweeping(async (sweepNumber) => {
			if (sweepNumber === 1) throw new Error("connection lost");
			return 0;
		});
		try {
			await pruning.started(1);
			await pruning.settled();

			await pruning.passes(A_DAY);
			await pruning.started(2);

			expect(pruning.cutoffs).toHaveLength(2);
		} finally {
			await pruning.dispose();
		}
	});
});
