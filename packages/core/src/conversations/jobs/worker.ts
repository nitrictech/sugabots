import { Duration, Effect, Layer, Ref, Schedule } from "effect";
import type { Database } from "../../database/database.ts";
import { renewJobLeases } from "./queue.ts";

/**
 * A background worker: fibres that claim jobs of one kind and run them for as
 * long as the layer's scope is open.
 *
 * Stopping the worker is interrupting its fibres, which the runtime does when
 * it is disposed. A job's `run` is therefore interrupted mid-way on shutdown,
 * and must record its own outcome inside `Effect.uninterruptibleMask` so the
 * database sees a finished job rather than one left `running`. Both runners
 * do that; see `turns/worker.ts` and `summaries/worker.ts`.
 */
export interface WorkerOptions<Claimed extends { id: string }> {
	/** For log lines, and the name of the span each claimed job runs in. Startup recovery is `${name} recovery`. */
	name: string;
	/**
	 * Puts back jobs whose lease has lapsed. Runs before the first claim,
	 * retried until it succeeds, and then every `RECOVERY_INTERVAL`, since any
	 * process may be the one to notice another has stopped.
	 */
	requeueInterrupted: () => Effect.Effect<void, never, Database>;
	claimNext: () => Effect.Effect<Claimed | undefined, never, Database>;
	/** Runs one claimed job to its recorded outcome. Must not fail; a defect is logged. */
	run: (claimed: Claimed) => Effect.Effect<void, never, Database>;
	/** How many jobs may run at once. */
	concurrency: number;
	/** How long to wait after finding the queue empty. */
	pollIntervalMs: number;
}

/** Well within `JOB_LEASE`, so one missed renewal does not lose a job. */
const LEASE_RENEWAL_INTERVAL = Duration.seconds(15);
const RECOVERY_INTERVAL = Duration.seconds(30);

export function workerLayer<Claimed extends { id: string }>({
	name,
	requeueInterrupted,
	claimNext,
	run,
	concurrency,
	pollIntervalMs,
}: WorkerOptions<Claimed>): Layer.Layer<never, never, Database> {
	const logged = (what: string) => (cause: unknown) =>
		Effect.sync(() => console.error(`${name}: ${what}`, cause));

	const recover = Effect.suspend(requeueInterrupted).pipe(
		Effect.tapCause(logged("recovery failed")),
		Effect.catchCause(() => Effect.fail("retry" as const)),
		Effect.retry(Schedule.spaced(Duration.millis(pollIntervalMs))),
		Effect.withSpan(`${name} recovery`),
	);

	return Layer.effectDiscard(
		Effect.gen(function* () {
			const held = yield* Ref.make<ReadonlySet<string>>(new Set());

			const claimAndRun = Effect.gen(function* () {
				const claimed = yield* claimNext();
				if (!claimed) {
					return false;
				}
				yield* Ref.update(held, (ids) => new Set(ids).add(claimed.id));
				yield* run(claimed).pipe(
					Effect.withSpan(name),
					Effect.withTracerEnabled(true),
					Effect.ensuring(
						Ref.update(held, (ids) => {
							const remaining = new Set(ids);
							remaining.delete(claimed.id);
							return remaining;
						}),
					),
				);
				return true;
			}).pipe(
				Effect.tapDefect(logged("iteration failed")),
				Effect.catchCause(() => Effect.succeed(false)),
			);

			// Straight on to the next job when there was one; a short wait when the
			// queue was empty. Untraced, because an empty queue is asked several
			// times a second and each ask would be a trace of its own; a claimed job
			// turns tracing back on.
			const poll = Effect.flatMap(claimAndRun, (busy) =>
				busy ? Effect.void : Effect.sleep(Duration.millis(pollIntervalMs)),
			).pipe(Effect.forever, Effect.withTracerEnabled(false));

			const renewLeases = Ref.get(held).pipe(
				Effect.flatMap((ids) => (ids.size === 0 ? Effect.void : renewJobLeases([...ids]))),
				Effect.tapCause(logged("lease renewal failed")),
				Effect.catchCause(() => Effect.void),
				Effect.repeat(Schedule.spaced(LEASE_RENEWAL_INTERVAL)),
				Effect.withTracerEnabled(false),
			);

			const recoverLapsed = Effect.suspend(requeueInterrupted).pipe(
				Effect.delay(RECOVERY_INTERVAL),
				Effect.tapCause(logged("recovery failed")),
				Effect.catchCause(() => Effect.void),
				Effect.forever,
				Effect.withTracerEnabled(false),
			);

			yield* Effect.forkScoped(
				Effect.andThen(
					recover,
					Effect.all(
						[...Array.from({ length: concurrency }, () => poll), renewLeases, recoverLapsed],
						{ concurrency: "unbounded", discard: true },
					),
				),
			);
		}),
	);
}

/** The sentence a job's outcome records for a cause it did not expect. */
export function describeFailure(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}
