import { Data, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	AccountingDispatchAlreadyClaimedError,
	AccountingDispatchBlockedError,
	AccountingIntegrityError,
	type AccountingPersistenceFailure,
	type AttemptObservationWriter,
	collectAttempt,
	InvalidAccountingObservationError,
} from "./collection.ts";
import { completeUsageEvidence, successfulAttempt } from "./examples.ts";
import type { AccountingStore } from "./lifecycle.ts";
import type { AttemptObservation } from "./types.ts";

class ToolFailed extends Data.TaggedError("ToolFailed")<{ readonly message: string }> {}

describe("attempt collection", () => {
	it("blocks provider dispatch when intent persistence fails under block policy", async () => {
		const operation = vi.fn(() => Effect.succeed("result"));
		const failures: AccountingPersistenceFailure[] = [];

		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ intentError: new Error("database unavailable") }),
					intent: successfulAttempt,
					dispatchPolicy: "block",
					onPersistenceFailure: (failure) =>
						Effect.sync(() => {
							failures.push(failure);
						}),
					operation,
				}),
			),
		).rejects.toBeInstanceOf(AccountingDispatchBlockedError);
		expect(operation).not.toHaveBeenCalled();
		expect(failures).toHaveLength(1);
	});

	it("continues explicitly and reports the accounting gap", async () => {
		const operation = vi.fn(() => Effect.succeed("result"));
		const failures: AccountingPersistenceFailure[] = [];

		const result = await Effect.runPromise(
			collectAttempt({
				store: store({ intentError: new Error("database unavailable") }),
				intent: successfulAttempt,
				dispatchPolicy: "continue",
				onPersistenceFailure: (failure) =>
					Effect.sync(() => {
						failures.push(failure);
					}),
				operation,
			}),
		);

		expect(result).toBe("result");
		expect(operation).toHaveBeenCalledOnce();
		expect(failures).toEqual([expect.objectContaining({ phase: "intent" })]);
	});

	it("records usage before a later operation failure and never retries the provider", async () => {
		const observations: AttemptObservation[] = [];
		const operation = vi.fn((writer: AttemptObservationWriter) =>
			Effect.gen(function* () {
				yield* writer.recordUsage({
					usageKey: "provider-response-1",
					observedAt: "2026-09-18T10:00:01.000Z",
					evidence: completeUsageEvidence,
				});
				return yield* new ToolFailed({ message: "tool failed" });
			}),
		);

		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ observations }),
					intent: successfulAttempt,
					dispatchPolicy: "block",
					onPersistenceFailure: () => Effect.void,
					operation,
				}),
			),
		).rejects.toThrow("tool failed");

		expect(operation).toHaveBeenCalledOnce();
		expect(observations.map((observation) => observation.payload.type)).toEqual([
			"dispatched",
			"usage",
			"terminal",
		]);
		expect(observations.at(-1)?.payload).toEqual(
			expect.objectContaining({ type: "terminal", outcome: "failed" }),
		);
	});

	it("reports an observation conflict without replaying the operation", async () => {
		const operation = vi.fn(() => Effect.succeed("result"));
		const failures: AccountingPersistenceFailure[] = [];

		await Effect.runPromise(
			collectAttempt({
				store: store({ observationResult: "conflict" }),
				intent: successfulAttempt,
				dispatchPolicy: "block",
				onPersistenceFailure: (failure) =>
					Effect.sync(() => {
						failures.push(failure);
					}),
				operation,
			}),
		);

		expect(operation).toHaveBeenCalledOnce();
		expect(failures).toHaveLength(1);
	});

	it("never dispatches an attempt whose dispatch was already claimed", async () => {
		const operation = vi.fn(() => Effect.succeed("result"));

		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ claimResult: "already-dispatched" }),
					intent: successfulAttempt,
					dispatchPolicy: "continue",
					onPersistenceFailure: () => Effect.void,
					operation,
				}),
			),
		).rejects.toBeInstanceOf(AccountingDispatchAlreadyClaimedError);
		expect(operation).not.toHaveBeenCalled();
	});

	it.each([{ intentResult: "conflict" as const }, { claimResult: "conflict" as const }])(
		"never continues through a known identity conflict",
		async (storeOptions) => {
			const operation = vi.fn(() => Effect.succeed("result"));
			await expect(
				Effect.runPromise(
					collectAttempt({
						store: store(storeOptions),
						intent: successfulAttempt,
						dispatchPolicy: "continue",
						onPersistenceFailure: () => Effect.void,
						operation,
					}),
				),
			).rejects.toBeInstanceOf(AccountingIntegrityError);
			expect(operation).not.toHaveBeenCalled();
		},
	);

	it("contains a synchronous failure reporter defect", async () => {
		const operation = vi.fn(() => Effect.succeed("result"));
		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ intentError: new Error("offline") }),
					intent: successfulAttempt,
					dispatchPolicy: "continue",
					onPersistenceFailure: () => {
						throw new Error("reporter failed");
					},
					operation,
				}),
			),
		).resolves.toBe("result");
		expect(operation).toHaveBeenCalledOnce();
	});

	it("records cancellation while preserving interruption", async () => {
		const observations: AttemptObservation[] = [];
		const operation = vi.fn(() => Effect.never);
		const fiber = Effect.runFork(
			collectAttempt({
				store: store({ observations }),
				intent: successfulAttempt,
				dispatchPolicy: "block",
				onPersistenceFailure: () => Effect.void,
				operation,
			}),
		);
		await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());

		await Effect.runPromise(Fiber.interrupt(fiber));

		expect(observations.at(-1)?.payload).toEqual(
			expect.objectContaining({ type: "terminal", outcome: "cancelled" }),
		);
	});

	it("bounds a stalled persistence write", async () => {
		const blockedStore = store();
		blockedStore.putIntent = () => Effect.never;

		await expect(
			Effect.runPromise(
				collectAttempt({
					store: blockedStore,
					intent: successfulAttempt,
					dispatchPolicy: "block",
					onPersistenceFailure: () => Effect.void,
					operation: () => Effect.succeed("result"),
					persistenceTimeoutMs: 1,
				}),
			),
		).rejects.toBeInstanceOf(AccountingDispatchBlockedError);
	});

	it("blocks dispatch when the atomic claim fails under continue policy", async () => {
		const operation = vi.fn(() => Effect.succeed("result"));

		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ claimError: new Error("claim unavailable") }),
					intent: successfulAttempt,
					dispatchPolicy: "continue",
					onPersistenceFailure: () => Effect.void,
					operation,
				}),
			),
		).rejects.toBeInstanceOf(AccountingDispatchBlockedError);
		expect(operation).not.toHaveBeenCalled();
	});

	it("records terminal failure when the operation throws before returning an Effect", async () => {
		const observations: AttemptObservation[] = [];

		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ observations }),
					intent: successfulAttempt,
					dispatchPolicy: "block",
					onPersistenceFailure: () => Effect.void,
					operation: () => {
						throw new Error("construction failed");
					},
				}),
			),
		).rejects.toThrow("construction failed");
		expect(observations.at(-1)?.payload).toEqual(
			expect.objectContaining({ type: "terminal", outcome: "failed" }),
		);
	});

	it("preserves the operation failure when classification or terminal persistence defects", async () => {
		const failures: AccountingPersistenceFailure[] = [];
		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ terminalDefect: new Error("terminal store defect") }),
					intent: successfulAttempt,
					dispatchPolicy: "block",
					onPersistenceFailure: (failure) =>
						Effect.sync(() => {
							failures.push(failure);
						}),
					classifyFailure: () => {
						throw new Error("classifier defect");
					},
					operation: () => new ToolFailed({ message: "provider failed" }),
				}),
			),
		).rejects.toBeInstanceOf(ToolFailed);
		expect(failures).toHaveLength(1);
	});

	it("preserves the operation failure when terminal persistence interrupts", async () => {
		const failures: AccountingPersistenceFailure[] = [];
		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ terminalInterrupt: true }),
					intent: successfulAttempt,
					dispatchPolicy: "block",
					onPersistenceFailure: (failure) =>
						Effect.sync(() => {
							failures.push(failure);
						}),
					operation: () => new ToolFailed({ message: "provider failed" }),
				}),
			),
		).rejects.toBeInstanceOf(ToolFailed);
		expect(failures).toHaveLength(1);
	});

	it("preserves the operation failure when terminal failure reporting interrupts", async () => {
		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ terminalDefect: new Error("terminal store defect") }),
					intent: successfulAttempt,
					dispatchPolicy: "block",
					onPersistenceFailure: () => Effect.interrupt,
					operation: () => new ToolFailed({ message: "provider failed" }),
				}),
			),
		).rejects.toBeInstanceOf(ToolFailed);
	});

	it("returns invalid writer input through the typed channel", async () => {
		const observations: AttemptObservation[] = [];
		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store({ observations }),
					intent: successfulAttempt,
					dispatchPolicy: "block",
					onPersistenceFailure: () => Effect.void,
					operation: (writer) =>
						writer.recordUsage({
							usageKey: "not valid",
							observedAt: "2026-09-18T10:00:01.000Z",
							evidence: completeUsageEvidence,
						}),
				}),
			),
		).rejects.toBeInstanceOf(InvalidAccountingObservationError);
		expect(observations.at(-1)?.payload).toEqual(
			expect.objectContaining({ type: "terminal", outcome: "failed" }),
		);
	});

	it("rejects an intent whose dispatch timestamp precedes its start", async () => {
		const operation = vi.fn(() => Effect.succeed("result"));
		await expect(
			Effect.runPromise(
				collectAttempt({
					store: store(),
					intent: { ...successfulAttempt, startedAt: "2999-01-01T00:00:00.000Z" },
					dispatchPolicy: "block",
					onPersistenceFailure: () => Effect.void,
					operation,
				}),
			),
		).rejects.toBeInstanceOf(InvalidAccountingObservationError);
		expect(operation).not.toHaveBeenCalled();
	});
});

function store(options?: {
	intentError?: Error;
	intentResult?: "created" | "duplicate" | "conflict";
	observationResult?: "created" | "duplicate" | "conflict";
	claimResult?: "claimed" | "already-dispatched" | "terminal" | "conflict";
	claimError?: Error;
	terminalDefect?: Error;
	terminalInterrupt?: boolean;
	observations?: AttemptObservation[];
}): AccountingStore<Error> {
	return {
		putIntent: () =>
			options?.intentError
				? Effect.fail(options.intentError)
				: Effect.succeed(options?.intentResult ?? "created"),
		claimDispatch: (observation) =>
			options?.claimError
				? Effect.fail(options.claimError)
				: Effect.sync(() => {
						options?.observations?.push(observation);
						return options?.claimResult ?? "claimed";
					}),
		putObservation: (observation) =>
			observation.payload.type === "terminal" && options?.terminalInterrupt
				? Effect.interrupt
				: observation.payload.type === "terminal" && options?.terminalDefect
					? Effect.die(options.terminalDefect)
					: Effect.sync(() => {
							options?.observations?.push(observation);
							return options?.observationResult ?? "created";
						}),
	};
}
