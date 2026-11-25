import { SystemWorkAuthentication } from "@sugabots/core/authentication/system-work";
import { Ids } from "@sugabots/core/ids/ids";
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

export const make = Effect.gen(function* () {
	const authenticate = yield* SystemWorkAuthentication.Service;
	const operations = yield* Operations.Service;
	const ids = yield* Ids.Service;
	const request = ids.random.pipe(Effect.map((request): Call => ({ kind: "request", request })));

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
		const retries = new Map<string, { nextAtMs: number; delayMs: number }>();
		return Effect.gen(function* () {
			const due = new Map((yield* dueItems).map((item) => [options.key(item), item]));
			for (const id of retries.keys()) {
				if (!due.has(id)) retries.delete(id);
			}
			yield* Effect.forEach(
				due,
				([id, item]) =>
					Effect.gen(function* () {
						const retry = retries.get(id);
						if (retry && (yield* Clock.currentTimeMillis) < retry.nextAtMs) return;
						yield* work(item, yield* request).pipe(
							Effect.tap(() => Effect.sync(() => void retries.delete(id))),
							Effect.catchCause((cause) =>
								Effect.gen(function* () {
									if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
									const now = yield* Clock.currentTimeMillis;
									const delayMs =
										options.retryDelayMs?.(retry?.delayMs) ?? Duration.toMillis(SWEEP_ITEM_BACKOFF);
									retries.set(id, { nextAtMs: now + delayMs, delayMs });
									yield* Effect.logError(message, {
										[options.idField]: id,
										cause,
										retryInMs: delayMs,
									});
								}),
							),
						);
					}),
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
