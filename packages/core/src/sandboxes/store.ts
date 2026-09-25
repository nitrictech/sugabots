import type { PodSandboxStatus } from "@sugabots/contracts";
import { streamEvent, workspaceChannel } from "@sugabots/contracts";
import { and, eq, gt, lt, notExists, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, transaction } from "../database/database.ts";
import type { PublishEvents } from "../database/events/publish.ts";
import { agent, podSandbox, sandboxLease, turn } from "../database/schema.ts";
import type { SandboxProviderStore } from "../providers/sandbox-providers/store.ts";
import { Sandbox } from "./sandbox.ts";

/**
 * Pods' sandboxes, and the turns using them.
 *
 * Every agent in a pod shares one sandbox, made the first time any of them
 * needs it, by the workspace's sandbox provider. A turn holds a lease while it
 * uses the sandbox; the lease is what says the sandbox is busy, and it expires
 * on its own if the turn's process dies, so nothing can hold a sandbox forever.
 */
export interface PodSandboxStore {
	/** Whether the workspace has a sandbox provider its agents may use now. */
	offered(workspaceId: string): Effect.Effect<boolean, never, Database>;
	/** The pod's sandbox, made if it has none, leased to `turnId` until released or expired. */
	lease(
		scope: LeaseScope,
	): Effect.Effect<
		LeasedSandbox,
		SandboxLost | SandboxProviderUnavailable | Sandbox.Unavailable,
		Database
	>;
	/** Whether the pod has a sandbox, and which agents' turns are using it now. */
	status(podId: string): Effect.Effect<PodSandboxStatus, never, Database>;
	/**
	 * Pauses every running sandbox nobody has had a lease on for `idleSeconds`,
	 * answering how many it paused. The next lease on one resumes it.
	 */
	pauseIdle(idleSeconds: number): Effect.Effect<number, never, Database>;
	/**
	 * Gives the workspace's running sandboxes its current allowed hosts, for
	 * when an admin changes them. Answers how many took the change and how many
	 * couldn't: a sandbox made to reach anywhere, or a change to anywhere, only
	 * reaches sandboxes made after it. A paused sandbox gets it when it wakes.
	 */
	applyAllowedHosts(
		workspaceId: string,
	): Effect.Effect<{ applied: number; notApplied: number }, never, Database>;
	/**
	 * Throws the pod's sandbox away, and everything in it, so the next agent to
	 * need one gets a new one: the way out of a lost sandbox, and what happens
	 * to a pod's sandbox before the pod is deleted. A turn using it at the time
	 * finds it gone. Answers whether the pod had one.
	 */
	discard(podId: string): Effect.Effect<boolean, never, Database>;
	/** Keeps a lease from expiring for another `LEASE_DURATION_SECONDS`. */
	renew(leaseId: string): Effect.Effect<void, never, Database>;
	release(leaseId: string): Effect.Effect<void, never, Database>;
}

export interface LeaseScope {
	workspaceId: string;
	podId: string;
	turnId: string;
}

export interface LeasedSandbox {
	leaseId: string;
	sandbox: Sandbox.Handle;
	/** Set when this lease woke a paused sandbox, with what the pause kept. */
	resumedAfterPause?: Sandbox.PauseKeeps;
}

/** How long a lease lasts without being renewed. Three renewals' worth, so one late renewal is harmless. */
export const LEASE_DURATION_SECONDS = 90;
export const LEASE_RENEWAL_INTERVAL_SECONDS = 30;

/**
 * The pod's sandbox is gone from the provider, or was made by a provider the
 * workspace no longer uses. It is not replaced automatically: whatever was in
 * it is lost, and people should hear that rather than find an empty machine.
 */
export class SandboxLost extends Data.TaggedError("SandboxLost")<{
	podId: string;
	reason: string;
}> {}

/** The workspace's sandbox provider is switched off, removed, or no longer allowed here. */
export class SandboxProviderUnavailable extends Data.TaggedError("SandboxProviderUnavailable")<{
	workspaceId: string;
}> {}

export interface PodSandboxStoreOptions {
	/** `resolve` for turns; `connection` for pausing, which goes ahead even with sandboxes switched off. */
	providers: Pick<SandboxProviderStore, "resolve" | "connection">;
	/** Whether this installation lets sandboxes share the host's kernel. */
	allowsUnisolated: boolean;
	/** Tells the workspace when a pod's sandbox is made, lost, or starts or stops being used. */
	publishEvents: PublishEvents;
	/** How a workspace's configuration becomes a provider. Tests pass a double. */
	providerFor?: (connection: Sandbox.Connection) => Sandbox.Interface;
}

type Reached =
	| {
			kind: "reached";
			podSandboxId: string;
			sandbox: Sandbox.Handle;
			resumedAfterPause?: Sandbox.PauseKeeps;
	  }
	| { kind: "lost"; reason: string };

export function podSandboxStore({
	providers,
	allowsUnisolated,
	publishEvents,
	providerFor = Sandbox.forConnection,
}: PodSandboxStoreOptions): PodSandboxStore {
	const announce = (workspaceId: string, podId: string) =>
		publishEvents([
			{ channel: workspaceChannel(workspaceId), event: streamEvent("sandbox.updated", { podId }) },
		]);

	/** The workspace's provider, unless it is off or the installation doesn't allow its isolation. */
	const usableProvider = (workspaceId: string) =>
		Effect.map(providers.resolve(workspaceId), (connection) =>
			connection && (connection.isolation !== "container" || allowsUnisolated)
				? providerFor(connection)
				: undefined,
		);

	const reachExisting = (
		row: typeof podSandbox.$inferSelect,
		sandboxes: Sandbox.Interface,
	): Effect.Effect<Reached, Sandbox.Unavailable, Database> => {
		if (row.status === "missing") {
			return Effect.succeed({ kind: "lost", reason: "The pod's sandbox was lost earlier." });
		}
		if (row.provider !== sandboxes.provider) {
			return Effect.succeed({
				kind: "lost",
				reason: `The pod's sandbox was made by ${row.provider}, which this workspace no longer uses.`,
			});
		}
		const reached =
			row.status === "paused"
				? sandboxes.resume(row.providerSandboxId).pipe(
						// A change to the allowed hosts made while it slept reaches it now.
						Effect.tap((sandbox) => allowListOnto(sandbox)),
						Effect.tap(() =>
							query((db) =>
								db.update(podSandbox).set({ status: "running" }).where(eq(podSandbox.id, row.id)),
							),
						),
						Effect.map(
							(sandbox): Reached => ({
								kind: "reached",
								podSandboxId: row.id,
								sandbox,
								resumedAfterPause: sandboxes.pauseKeeps,
							}),
						),
					)
				: sandboxes
						.connect(row.providerSandboxId)
						.pipe(
							Effect.map(
								(sandbox): Reached => ({ kind: "reached", podSandboxId: row.id, sandbox }),
							),
						);
		return reached.pipe(Effect.catchTag("SandboxMissing", () => markMissing(row)));
	};

	/** Gives a sandbox the workspace's current list, if it has one; false when it couldn't. */
	const allowListOnto = (sandbox: Sandbox.Handle) =>
		Effect.gen(function* () {
			const [row] = yield* query((db) =>
				db
					.select({ workspaceId: podSandbox.workspaceId })
					.from(podSandbox)
					.where(eq(podSandbox.providerSandboxId, sandbox.id))
					.limit(1),
			);
			const connection = row ? yield* providers.connection(row.workspaceId) : undefined;
			if (connection?.allowedHosts.kind !== "only") return false;
			return yield* sandbox.setAllowedHosts(connection.allowedHosts.hosts).pipe(
				Effect.as(true),
				Effect.catchTag("SandboxUnavailable", (failure) =>
					Effect.logWarning("Updating a sandbox's allowed hosts failed", failure).pipe(
						Effect.as(false),
					),
				),
			);
		});

	const markMissing = (row: typeof podSandbox.$inferSelect) =>
		query((db) =>
			db.update(podSandbox).set({ status: "missing" }).where(eq(podSandbox.id, row.id)),
		).pipe(
			Effect.andThen(announce(row.workspaceId, row.podId)),
			Effect.as<Reached>({
				kind: "lost",
				reason: "The sandbox provider no longer has the pod's sandbox.",
			}),
		);

	/** No unexpired lease on the sandbox. */
	const unleased = notExists(
		sql`(select 1 from ${sandboxLease} where ${sandboxLease.podSandboxId} = ${podSandbox.id} and ${sandboxLease.expiresAt} > now())`,
	);
	const idleFor = (idleSeconds: number) =>
		and(
			eq(podSandbox.status, "running"),
			lt(podSandbox.lastLeaseEndedAt, sql`now() - make_interval(secs => ${idleSeconds})`),
			unleased,
		);

	/**
	 * Pauses one sandbox if it is still idle once its pod's lock is held. A pod
	 * whose lock is taken is skipped rather than waited for: whoever holds it is
	 * about to use the sandbox, and the next sweep can look again.
	 */
	const pauseOne = (candidate: { id: string; podId: string }, idleSeconds: number) =>
		transaction(
			Effect.gen(function* () {
				const locked = yield* query((db) =>
					Effect.gen(function* () {
						const rows = yield* db.execute<{ locked: boolean }>(
							sql`select pg_try_advisory_xact_lock(hashtextextended(${`pod-sandbox:${candidate.podId}`}, 0)) as locked`,
							"objects",
						);
						const [first] = rows;
						return first?.locked === true;
					}),
				);
				if (!locked) return false;
				const [row] = yield* query((db) =>
					db
						.select()
						.from(podSandbox)
						.where(and(eq(podSandbox.id, candidate.id), idleFor(idleSeconds)))
						.limit(1),
				);
				if (!row) return false;
				const connection = yield* providers.connection(row.workspaceId);
				if (!connection || connection.preset !== row.provider) return false;
				const outcome = yield* providerFor(connection)
					.pause(row.providerSandboxId)
					.pipe(
						Effect.as("paused" as const),
						Effect.catchTag("SandboxMissing", () =>
							markMissing(row).pipe(Effect.as("lost" as const)),
						),
						Effect.catchTag("SandboxUnavailable", (failure) =>
							Effect.logWarning("Pausing a pod's sandbox failed", failure).pipe(
								Effect.as("unreachable" as const),
							),
						),
					);
				if (outcome !== "paused") return false;
				yield* query((db) =>
					db.update(podSandbox).set({ status: "paused" }).where(eq(podSandbox.id, row.id)),
				);
				yield* announce(row.workspaceId, row.podId);
				return true;
			}),
		);

	const createFor = (scope: LeaseScope, sandboxes: Sandbox.Interface) =>
		Effect.gen(function* () {
			const sandbox = yield* sandboxes.create({
				labels: { "sugabots.workspace": scope.workspaceId, "sugabots.pod": scope.podId },
			});
			const [row] = yield* query((db) =>
				db
					.insert(podSandbox)
					.values({
						workspaceId: scope.workspaceId,
						podId: scope.podId,
						provider: sandboxes.provider,
						providerSandboxId: sandbox.id,
						status: "running",
						isolation: sandboxes.isolation,
					})
					.returning({ id: podSandbox.id }),
			);
			if (!row) return yield* Effect.die(new Error("Inserting a pod sandbox returned no row"));
			const reached: Reached = { kind: "reached", podSandboxId: row.id, sandbox };
			return reached;
		});

	const leaseSandbox = (scope: LeaseScope, sandboxes: Sandbox.Interface) =>
		transaction(
			Effect.gen(function* () {
				// One pod's turns may run in any process, and only one of them may make
				// the pod's sandbox. The lock is held while it is made, so the pod's
				// other turns wait for it rather than making a second.
				yield* query((db) =>
					db.execute(
						sql`select pg_advisory_xact_lock(hashtextextended(${`pod-sandbox:${scope.podId}`}, 0))`,
					),
				);
				const [existing] = yield* query((db) =>
					db.select().from(podSandbox).where(eq(podSandbox.podId, scope.podId)).limit(1),
				);
				const reached = existing
					? yield* reachExisting(existing, sandboxes)
					: yield* createFor(scope, sandboxes);
				// Returned rather than failed, so marking a sandbox missing is committed.
				if (reached.kind === "lost") return reached;

				const [lease] = yield* query((db) =>
					db
						.insert(sandboxLease)
						.values({
							podSandboxId: reached.podSandboxId,
							turnId: scope.turnId,
							expiresAt: sql`now() + make_interval(secs => ${LEASE_DURATION_SECONDS})`,
						})
						.returning({ id: sandboxLease.id }),
				);
				if (!lease)
					return yield* Effect.die(new Error("Inserting a sandbox lease returned no row"));
				yield* announce(scope.workspaceId, scope.podId);
				return {
					kind: "leased" as const,
					leaseId: lease.id,
					sandbox: reached.sandbox,
					resumedAfterPause: reached.resumedAfterPause,
				};
			}),
		);

	return {
		offered: (workspaceId) =>
			Effect.map(usableProvider(workspaceId), (provider) => provider !== undefined),

		lease: (scope) =>
			Effect.gen(function* () {
				const sandboxes = yield* usableProvider(scope.workspaceId);
				if (!sandboxes) {
					return yield* new SandboxProviderUnavailable({ workspaceId: scope.workspaceId });
				}
				const result = yield* leaseSandbox(scope, sandboxes);
				if (result.kind === "lost") {
					return yield* new SandboxLost({ podId: scope.podId, reason: result.reason });
				}
				return {
					leaseId: result.leaseId,
					sandbox: result.sandbox,
					...(result.resumedAfterPause ? { resumedAfterPause: result.resumedAfterPause } : {}),
				};
			}),

		status: (podId) =>
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db.select().from(podSandbox).where(eq(podSandbox.podId, podId)).limit(1),
				);
				if (!row) {
					return { state: "none", usedBy: [], isolation: null, lastUsedAt: null, createdAt: null };
				}
				const users = yield* query((db) =>
					db
						.selectDistinct({ agentId: agent.id, name: agent.name, handle: agent.handle })
						.from(sandboxLease)
						.innerJoin(turn, eq(turn.id, sandboxLease.turnId))
						.innerJoin(agent, eq(agent.id, turn.agentId))
						.where(
							and(eq(sandboxLease.podSandboxId, row.id), gt(sandboxLease.expiresAt, sql`now()`)),
						),
				);
				return {
					state:
						row.status === "missing"
							? "lost"
							: users.length > 0
								? "in_use"
								: row.status === "paused"
									? "paused"
									: "idle",
					usedBy: row.status === "missing" ? [] : users,
					isolation: row.isolation,
					lastUsedAt: row.lastLeaseEndedAt?.toISOString() ?? null,
					createdAt: row.createdAt.toISOString(),
				} satisfies PodSandboxStatus;
			}),

		pauseIdle: (idleSeconds) =>
			Effect.gen(function* () {
				const candidates = yield* query((db) =>
					db
						.select({ id: podSandbox.id, podId: podSandbox.podId })
						.from(podSandbox)
						.where(idleFor(idleSeconds)),
				);
				let paused = 0;
				for (const candidate of candidates) {
					if (yield* pauseOne(candidate, idleSeconds)) paused += 1;
				}
				return paused;
			}),

		applyAllowedHosts: (workspaceId) =>
			Effect.gen(function* () {
				const connection = yield* providers.connection(workspaceId);
				const rows = yield* query((db) =>
					db
						.select()
						.from(podSandbox)
						.where(and(eq(podSandbox.workspaceId, workspaceId), eq(podSandbox.status, "running"))),
				);
				if (connection?.allowedHosts.kind !== "only") {
					return { applied: 0, notApplied: rows.length };
				}
				const provider = providerFor(connection);
				let applied = 0;
				for (const row of rows) {
					const took =
						row.provider === connection.preset &&
						(yield* provider.connect(row.providerSandboxId).pipe(
							Effect.flatMap((sandbox) =>
								allowListOnto(sandbox).pipe(Effect.ensuring(sandbox.disconnect)),
							),
							Effect.catch(() => Effect.succeed(false)),
						));
					if (took) applied += 1;
				}
				return { applied, notApplied: rows.length - applied };
			}),

		discard: (podId) =>
			transaction(
				Effect.gen(function* () {
					yield* query((db) =>
						db.execute(
							sql`select pg_advisory_xact_lock(hashtextextended(${`pod-sandbox:${podId}`}, 0))`,
						),
					);
					const [row] = yield* query((db) =>
						db.select().from(podSandbox).where(eq(podSandbox.podId, podId)).limit(1),
					);
					if (!row) return false;
					const connection = yield* providers.connection(row.workspaceId);
					if (row.status !== "missing" && connection?.preset === row.provider) {
						// Gone already is as good as destroyed. Unreachable leaves it running
						// with nothing pointing at it, which the log is left to say.
						yield* providerFor(connection)
							.destroy(row.providerSandboxId)
							.pipe(
								Effect.catchTag("SandboxMissing", () => Effect.void),
								Effect.catchTag("SandboxUnavailable", (failure) =>
									Effect.logWarning(
										`Could not destroy sandbox ${row.providerSandboxId}; it may still be running`,
										failure,
									),
								),
							);
					}
					yield* query((db) => db.delete(podSandbox).where(eq(podSandbox.id, row.id)));
					yield* announce(row.workspaceId, row.podId);
					return true;
				}),
			),

		renew: (leaseId) =>
			query((db) =>
				db
					.update(sandboxLease)
					.set({ expiresAt: sql`now() + make_interval(secs => ${LEASE_DURATION_SECONDS})` })
					.where(eq(sandboxLease.id, leaseId)),
			).pipe(Effect.asVoid),

		release: (leaseId) =>
			transaction(
				Effect.gen(function* () {
					const [ended] = yield* query((db) =>
						db
							.delete(sandboxLease)
							.where(eq(sandboxLease.id, leaseId))
							.returning({ podSandboxId: sandboxLease.podSandboxId }),
					);
					if (!ended) return;
					const [updated] = yield* query((db) =>
						db
							.update(podSandbox)
							.set({ lastLeaseEndedAt: sql`now()` })
							.where(eq(podSandbox.id, ended.podSandboxId))
							.returning({ workspaceId: podSandbox.workspaceId, podId: podSandbox.podId }),
					);
					if (updated) yield* announce(updated.workspaceId, updated.podId);
				}),
			),
	};
}
