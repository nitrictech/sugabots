import { eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, transaction } from "../database/database.ts";
import { podSandbox, sandboxLease } from "../database/schema.ts";
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
	providers: Pick<SandboxProviderStore, "resolve">;
	/** Whether this installation lets sandboxes share the host's kernel. */
	allowsUnisolated: boolean;
	/** How a workspace's configuration becomes a provider. Tests pass a double. */
	providerFor?: (connection: Sandbox.Connection) => Sandbox.Interface;
}

type Reached =
	| { kind: "reached"; podSandboxId: string; sandbox: Sandbox.Handle }
	| { kind: "lost"; reason: string };

export function podSandboxStore({
	providers,
	allowsUnisolated,
	providerFor = Sandbox.forConnection,
}: PodSandboxStoreOptions): PodSandboxStore {
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
		return sandboxes.connect(row.providerSandboxId).pipe(
			Effect.map((sandbox): Reached => ({ kind: "reached", podSandboxId: row.id, sandbox })),
			Effect.catchTag("SandboxMissing", () =>
				query((db) =>
					db.update(podSandbox).set({ status: "missing" }).where(eq(podSandbox.id, row.id)),
				).pipe(
					Effect.as<Reached>({
						kind: "lost",
						reason: "The sandbox provider no longer has the pod's sandbox.",
					}),
				),
			),
		);
	};

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
			return { kind: "reached", podSandboxId: row.id, sandbox } satisfies Reached;
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
				return { kind: "leased" as const, leaseId: lease.id, sandbox: reached.sandbox };
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
				return { leaseId: result.leaseId, sandbox: result.sandbox };
			}),

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
					yield* query((db) =>
						db
							.update(podSandbox)
							.set({ lastLeaseEndedAt: sql`now()` })
							.where(eq(podSandbox.id, ended.podSandboxId)),
					);
				}),
			),
	};
}
