import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { noDatabase } from "../../database/testing.ts";
import { workerLayer } from "./worker.ts";

interface Claimed {
	id: string;
}

/** The job queue the worker claims from, faked so no case reaches a database. */
function jobQueue() {
	return {
		requeueInterrupted: vi.fn((): Effect.Effect<void> => Effect.void),
		claimNext: vi.fn((): Effect.Effect<Claimed | undefined> => Effect.undefined),
	};
}

/**
 * Running the layer starts the worker; disposing the runtime interrupts it,
 * which is the whole of what shutting one down means.
 */
function running(
	queue: ReturnType<typeof jobQueue>,
	run: (claimed: Claimed) => Effect.Effect<void>,
	pollIntervalMs: number,
) {
	return ManagedRuntime.make(
		workerLayer({ name: "Test worker", ...queue, run, concurrency: 1, pollIntervalMs }).pipe(
			Layer.provide(noDatabase),
		),
	);
}

describe("a job worker", () => {
	it("retries interrupted-job recovery before claiming work", async () => {
		vi.useFakeTimers();
		const queue = jobQueue();
		queue.requeueInterrupted
			.mockReturnValueOnce(Effect.die(new Error("database unavailable")))
			.mockReturnValueOnce(Effect.void);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const worker = running(queue, () => Effect.void, 10);
		try {
			await worker.runPromise(Effect.void);
			await vi.advanceTimersByTimeAsync(50);
			expect(queue.requeueInterrupted).toHaveBeenCalledTimes(2);
			expect(queue.claimNext).toHaveBeenCalled();
		} finally {
			await worker.dispose();
			error.mockRestore();
			vi.useRealTimers();
		}
	});

	it("waits for a job to record its outcome before shutdown continues", async () => {
		const queue = jobQueue();
		let wroteAt: number | undefined;
		queue.claimNext.mockReturnValueOnce(Effect.succeed({ id: "job" }));
		// A job's run records its outcome uninterruptibly once it is torn down.
		const run = () =>
			Effect.uninterruptibleMask((restore) =>
				Effect.exit(restore(Effect.never)).pipe(
					Effect.andThen(
						Effect.promise(async () => {
							await new Promise((resolve) => setTimeout(resolve, 60));
							wroteAt = Date.now();
						}),
					),
				),
			);
		const worker = running(queue, run, 10);

		await worker.runPromise(Effect.void);
		await new Promise((resolve) => setTimeout(resolve, 40));

		await worker.dispose();
		const disposedAt = Date.now();

		// Without this the pool closes while the job is still writing, and the
		// rejection goes nowhere: the job stays running and its work is lost.
		expect(wroteAt).toBeDefined();
		expect(disposedAt).toBeGreaterThanOrEqual(wroteAt ?? Number.POSITIVE_INFINITY);
	});

	it("stops while recovery is waiting to retry", async () => {
		vi.useFakeTimers();
		const queue = jobQueue();
		queue.requeueInterrupted.mockReturnValue(Effect.die(new Error("database unavailable")));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const worker = running(queue, () => Effect.void, 10_000);
		try {
			await worker.runPromise(Effect.void);
			await vi.advanceTimersByTimeAsync(0);
			await worker.dispose();
			expect(queue.claimNext).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
			vi.useRealTimers();
		}
	});
});
