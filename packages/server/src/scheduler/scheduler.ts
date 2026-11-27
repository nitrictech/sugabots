import { SystemWorkAuthentication } from "@sugabots/core/authentication/system-work";
import type { Call } from "@sugabots/core/operations/operation";
import { Operations } from "@sugabots/core/operations/registry";
import { processLayer } from "@sugabots/core/tiers";
import { Cause, Clock, Duration, Effect, Layer } from "effect";

const ROUTINE_POLL_INTERVAL = Duration.seconds(15);
const APPROVAL_EXPIRY_INTERVAL = Duration.seconds(30);
const COMPUTER_SLEEP_INTERVAL = Duration.minutes(1);
const PAUSE_POLL_INTERVAL = Duration.seconds(15);
const DELETION_POLL_INTERVAL = Duration.minutes(1);
const DELETION_CONCURRENCY = 4;
const DELETION_TIMEOUT = Duration.seconds(45);
const FIRST_DELETION_RETRY_MS = Duration.toMillis(Duration.minutes(2));
const MAX_DELETION_RETRY_MS = Duration.toMillis(Duration.minutes(15));
const UNINSTALL_POLL_INTERVAL = Duration.seconds(1);
const SWEEP_ITEM_BACKOFF = Duration.minutes(5);

/** When a sweep's item that failed is tried again, and the wait that set it. */
interface SweepRetry {
	readonly nextAtMs: number;
	readonly delayMs: number;
}

/**
 * One item's turn in a sweep. An item whose retry is not yet due is left as
 * it is. Otherwise it is attempted: once it succeeds it has no retry; when it
 * fails, the failure is logged and its retry is due after `retryDelayMs` of
 * the wait before, or of none for a first failure.
 */
function attemptSweepItem<E>({
	previous,
	attempt,
	retryDelayMs,
	logFailure,
}: {
	readonly previous: SweepRetry | undefined;
	readonly attempt: Effect.Effect<void, E>;
	readonly retryDelayMs: (previousDelayMs: number | undefined) => number;
	readonly logFailure: (cause: Cause.Cause<E>, retryInMs: number) => Effect.Effect<void>;
}): Effect.Effect<SweepRetry | undefined, E> {
	return Effect.gen(function* () {
		if (previous && (yield* Clock.currentTimeMillis) < previous.nextAtMs) return previous;
		return yield* attempt.pipe(
			Effect.as(undefined),
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
					const delayMs = retryDelayMs(previous?.delayMs);
					yield* logFailure(cause, delayMs);
					return { nextAtMs: (yield* Clock.currentTimeMillis) + delayMs, delayMs };
				}),
			),
		);
	});
}

export const make = Effect.gen(function* () {
	const authenticate = yield* SystemWorkAuthentication.Service;
	const operations = yield* Operations.Service;
	const request = Effect.succeed<Call>({ kind: "request" });

	const routineRetryAt = new Map<string, number>();
	const runNextRoutine = Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		for (const [triggerId, retryAt] of routineRetryAt) {
			if (retryAt <= now) routineRetryAt.delete(triggerId);
		}
		const triggerId = yield* authenticate.nextDueRoutineId([...routineRetryAt.keys()]);
		if (!triggerId) return undefined;
		const result = yield* authenticate.dueRoutine(triggerId).pipe(
			Effect.flatMap((principal) =>
				Effect.flatMap(request, (call) =>
					operations["automations.runDueRoutine"](principal, { triggerId }, call),
				),
			),
			Effect.catchTag("StoredWorkGone", () => Effect.succeed(undefined)),
			Effect.catchCause((cause) =>
				Cause.hasInterrupts(cause)
					? Effect.failCause(cause)
					: Effect.logError("Running a due routine failed", { triggerId, cause }).pipe(
							Effect.as("retry" as const),
						),
			),
		);
		if (result === undefined || result === "retry") {
			const triedAt = yield* Clock.currentTimeMillis;
			routineRetryAt.set(triggerId, triedAt + Duration.toMillis(ROUTINE_POLL_INTERVAL));
			return "retry" as const;
		}
		return result;
	});

	const sweep = <Item, E>(
		dueItems: Effect.Effect<readonly Item[]>,
		work: (item: Item, call: Call) => Effect.Effect<void, E>,
		message: string,
		options: {
			key: (item: Item) => string;
			idField: string;
			concurrency?: number;
			retryDelayMs?: (previousDelayMs: number | undefined) => number;
		},
	) => {
		const retries = new Map<string, SweepRetry>();
		const retryDelayMs = options.retryDelayMs ?? (() => Duration.toMillis(SWEEP_ITEM_BACKOFF));
		return Effect.gen(function* () {
			const due = new Map((yield* dueItems).map((item) => [options.key(item), item]));
			for (const id of retries.keys()) {
				if (!due.has(id)) retries.delete(id);
			}
			yield* Effect.forEach(
				due,
				([id, item]) =>
					attemptSweepItem({
						previous: retries.get(id),
						attempt: Effect.flatMap(request, (call) => work(item, call)),
						retryDelayMs,
						logFailure: (cause, retryInMs) =>
							Effect.logError(message, { [options.idField]: id, cause, retryInMs }),
					}).pipe(
						Effect.tap((retry) =>
							Effect.sync(() => (retry ? retries.set(id, retry) : retries.delete(id))),
						),
					),
				{ concurrency: options.concurrency ?? 1, discard: true },
			);
		});
	};

	const expireApprovals = sweep(
		authenticate.expiredApprovalIds,
		(approvalId, call) =>
			authenticate.approvalExpiry(approvalId).pipe(
				Effect.flatMap((principal) =>
					operations["approvals.expire"](principal, { approvalId }, call),
				),
				Effect.catchTag("StoredWorkGone", () => Effect.void),
			),
		"Withdrawing an expired approval failed",
		{ key: (id) => id, idField: "approvalId" },
	);

	const sleepIdleComputers = sweep(
		authenticate.idleComputerIds,
		(computerId, call) =>
			authenticate.computerSleep(computerId).pipe(
				Effect.flatMap((principal) =>
					operations["projectComputer.sleepIfIdle"](principal, { computerId }, call),
				),
				Effect.catchTag("StoredWorkGone", () => Effect.void),
			),
		"Putting an idle computer to sleep failed",
		{ key: (id) => id, idField: "computerId" },
	);

	const pauseFailingAutomations = sweep(
		authenticate.pendingPauseIds,
		(automationId, call) =>
			authenticate.pauseAfterFailures(automationId).pipe(
				Effect.flatMap((principal) =>
					operations["automations.pauseAfterFailures"](principal, { automationId }, call),
				),
				Effect.catchTag("StoredWorkGone", () => Effect.void),
			),
		"Pausing an automation after failures failed",
		{ key: (id) => id, idField: "automationId" },
	);

	const uninstallGitHubApps = Effect.gen(function* () {
		for (const uninstallId of yield* authenticate.dueGitHubUninstallIds) {
			const call = yield* request;
			yield* authenticate.gitHubUninstall(uninstallId).pipe(
				Effect.flatMap((principal) =>
					operations["gitHubConnectors.uninstall"](principal, { uninstallId }, call),
				),
				Effect.catchTag("StoredWorkGone", () => Effect.void),
				Effect.catchCause((cause) =>
					Effect.logError("GitHub uninstall failed", { uninstallId, cause }),
				),
			);
		}
	});

	const finishDeletions = sweep(
		authenticate.pendingDeletions,
		(target, call) =>
			authenticate.deletion(target).pipe(
				Effect.flatMap((principal) =>
					operations["deletions.finish"](principal, { id: target.id }, call),
				),
				Effect.timeout(DELETION_TIMEOUT),
				Effect.catchTag("StoredWorkGone", () => Effect.void),
			),
		"Finishing a deletion failed",
		{
			key: ({ kind, id }) => `${kind}:${id}`,
			idField: "target",
			concurrency: DELETION_CONCURRENCY,
			retryDelayMs: (previous) =>
				previous === undefined
					? FIRST_DELETION_RETRY_MS
					: Math.min(previous * 2, MAX_DELETION_RETRY_MS),
		},
	);

	return {
		runNextRoutine,
		expireApprovals,
		sleepIdleComputers,
		pauseFailingAutomations,
		uninstallGitHubApps,
		finishDeletions,
	};
});

export const layerNoDeps = Layer.effectDiscard(
	Effect.gen(function* () {
		const scheduler = yield* make;
		const repeat = (
			iteration: Effect.Effect<void, unknown>,
			message: string,
			recoveryDelay = Effect.void,
		) =>
			Effect.forkScoped(
				iteration.pipe(
					Effect.catchCause((cause) =>
						Effect.logError(message, cause).pipe(Effect.andThen(recoveryDelay)),
					),
					Effect.forever,
					Effect.withTracerEnabled(false),
				),
			);
		yield* repeat(
			scheduler.runNextRoutine.pipe(
				Effect.flatMap((handled) =>
					handled === undefined ? Effect.sleep(ROUTINE_POLL_INTERVAL) : Effect.void,
				),
			),
			"Routine scheduler iteration failed",
			Effect.sleep(ROUTINE_POLL_INTERVAL),
		);
		yield* repeat(
			scheduler.expireApprovals.pipe(Effect.delay(APPROVAL_EXPIRY_INTERVAL)),
			"Expiring approvals failed",
		);
		yield* repeat(
			scheduler.sleepIdleComputers.pipe(Effect.delay(COMPUTER_SLEEP_INTERVAL)),
			"Putting idle computers to sleep failed",
		);
		yield* repeat(
			scheduler.pauseFailingAutomations.pipe(Effect.delay(PAUSE_POLL_INTERVAL)),
			"Pausing automations after failures failed",
		);
		yield* repeat(
			scheduler.uninstallGitHubApps.pipe(Effect.delay(UNINSTALL_POLL_INTERVAL)),
			"Draining GitHub uninstalls failed",
		);
		yield* repeat(
			scheduler.finishDeletions.pipe(Effect.delay(DELETION_POLL_INTERVAL)),
			"Finishing pending deletions failed",
		);
	}),
).pipe(processLayer);

export const layer = layerNoDeps.pipe(Layer.provide(SystemWorkAuthentication.layer));
