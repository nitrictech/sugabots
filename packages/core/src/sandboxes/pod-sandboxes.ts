export * as PodSandboxes from "./pod-sandboxes.ts";

import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { Context, Data, DateTime, Duration, Effect, Layer, Semaphore } from "effect";
import { Database, query, serviceOperations } from "../database/database.ts";
import { sandboxLease, sandbox as sandboxTable } from "../database/schema.ts";
import { Ids } from "../ids/ids.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import { allowedHostsOf } from "./allowed-hosts.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

/** How long a lease holds a sandbox awake unless it is renewed. */
export const LEASE = Duration.seconds(90);
/** How often a turn renews its lease, well inside {@link LEASE}. */
export const LEASE_RENEWAL = Duration.seconds(30);
/** How long a sandbox sits with no turn using it before it is paused. */
export const IDLE_BEFORE_PAUSE = Duration.minutes(5);
/** How often the sweep looks for idle sandboxes to pause. */
const PAUSE_SWEEP_INTERVAL = Duration.minutes(1);

/**
 * The only writer of `sandbox` and `sandbox_lease`: each pod's one sandbox,
 * made the first time an agent there needs it, then opened, and resumed, on
 * every later use. A turn using it holds a lease, and a sandbox no turn has
 * held for {@link IDLE_BEFORE_PAUSE} is paused, so it stops costing compute.
 * A turn waiting for a person's approval has ended its run and holds no
 * lease, so nobody pays for a sandbox while a person is away.
 */
export interface Interface {
	/**
	 * The pod's sandbox at `provider`, the workspace's enabled one, ready to
	 * run commands, with a lease for `holder` that keeps it awake until
	 * released or expired.
	 */
	readonly open: (
		pod: Pod,
		provider: SandboxProviderRepository.Configured,
		holder: string,
	) => Effect.Effect<Opened, Sandboxes.Unavailable>;
	/** Extends `holder`'s leases. Nothing happens if it has none. */
	readonly renew: (holder: string) => Effect.Effect<void>;
	/** Ends `holder`'s leases, starting the idle time of the sandboxes it held. */
	readonly release: (holder: string) => Effect.Effect<void>;
	/** Pauses every sandbox nobody has used for {@link IDLE_BEFORE_PAUSE}. */
	readonly pauseIdle: Effect.Effect<void>;
	/**
	 * Destroys every sandbox `provider` made and forgets them, so the provider
	 * can be removed without leaving machines running at it.
	 */
	readonly destroyAllMadeBy: (
		workspaceId: string,
		provider: SandboxProviderRepository.Configured,
	) => Effect.Effect<void, Sandboxes.Unavailable>;
	/**
	 * Keeps the running sandboxes of the workspace's pods, or of one pod, to
	 * the hosts each may reach now. A paused one is kept to them when it is
	 * next opened; one that can't be reached is logged and left for then too.
	 */
	readonly applyAllowedHosts: (where: {
		workspaceId: string;
		podId?: string;
	}) => Effect.Effect<void>;
	/** Whether `providerId` has made any sandbox that still exists. */
	readonly anyMadeBy: (workspaceId: string, providerId: string) => Effect.Effect<boolean>;
	/**
	 * How the pod's sandbox stands, asking its provider without resuming it.
	 * `current` is the workspace's enabled provider, which says whether the
	 * sandbox's image is out of date.
	 */
	readonly status: (
		pod: Pod,
		current: SandboxProviderRepository.Configured | undefined,
	) => Effect.Effect<Status>;
	/** Destroys the pod's sandbox and forgets it; its next use makes a new one. */
	readonly reset: (pod: Pod) => Effect.Effect<void, SandboxInUse | Sandboxes.Unavailable>;
	/**
	 * Moves the pod's work to a new sandbox made by `provider`, the
	 * workspace's enabled one, from its image, then destroys the old sandbox.
	 * Work the provider keeps apart from the sandbox carries over whole;
	 * otherwise `/workspace` is copied across, less what `.gitignore` files
	 * leave out. Once started it finishes, even if the caller goes away, as
	 * does {@link reset}.
	 */
	readonly upgrade: (
		pod: Pod,
		provider: SandboxProviderRepository.Configured,
	) => Effect.Effect<void, SandboxInUse | NoSandbox | UpgradeFailed | Sandboxes.Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/PodSandboxes") {}

export const make = Effect.gen(function* () {
	const sandboxes = yield* Sandboxes.Service;
	const ids = yield* Ids.Service;
	const providers = yield* SandboxProviderRepository.Service;
	const operation = yield* serviceOperations<Interface>("PodSandboxes");
	// One change to a pod's sandbox at a time: two turns' first commands make
	// one sandbox, and the sweep never pauses one a turn is opening.
	const changes = new Map<string, Semaphore.Semaphore>();
	const oneAtATime = (podId: string) => {
		let semaphore = changes.get(podId);
		if (!semaphore) {
			semaphore = Semaphore.makeUnsafe(1);
			changes.set(podId, semaphore);
		}
		return semaphore.withPermits(1);
	};

	const recorded = (pod: Pod) =>
		query((db) =>
			db
				.select()
				.from(sandboxTable)
				.where(
					and(eq(sandboxTable.podId, pod.podId), eq(sandboxTable.workspaceId, pod.workspaceId)),
				)
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	const forget = (podId: string) =>
		query((db) => db.delete(sandboxTable).where(eq(sandboxTable.podId, podId)));

	/**
	 * What the pod's sandbox is made from. Its work is named by the sandbox's
	 * record, which a replacement or an upgrade keeps and a reset doesn't, so
	 * a reset starts from empty.
	 */
	const specFor = (pod: Pod, recordId: string) =>
		Effect.map(
			allowedHostsOf(pod),
			(allowedHosts): Sandboxes.Spec => ({
				labels: { "sugabots.workspace": pod.workspaceId, "sugabots.pod": pod.podId },
				allowedHosts,
				workName: recordId,
			}),
		);

	/**
	 * Makes a sandbox at `at` and hands it to `record`, as one step that isn't
	 * stopped part-way when whoever asked goes away: a sandbox made but never
	 * recorded is one nothing would find to destroy. One whose recording
	 * fails is destroyed.
	 */
	const madeAndRecorded = <E, R>(
		at: Sandboxes.Provider,
		spec: Sandboxes.Spec,
		record: (sandbox: Sandboxes.Sandbox) => Effect.Effect<unknown, E, R>,
	) =>
		Effect.uninterruptible(
			Effect.tap(at.create(spec), (sandbox) =>
				record(sandbox).pipe(Effect.onError(() => at.destroy(sandbox.id).pipe(Effect.ignore))),
			),
		);

	const made = (pod: Pod, provider: SandboxProviderRepository.Configured) =>
		Effect.gen(function* () {
			const id = yield* ids.next;
			return yield* madeAndRecorded(
				sandboxes.forConnection(provider.connection),
				yield* specFor(pod, id),
				(sandbox) =>
					query((db) =>
						db.insert(sandboxTable).values({
							id,
							workspaceId: pod.workspaceId,
							podId: pod.podId,
							sandboxProviderId: provider.id,
							providerSandboxId: sandbox.id,
						}),
					),
			);
		});

	/**
	 * Destroys the pod's sandbox at a provider the workspace no longer uses.
	 * A provider that can't be reached leaves it running there, which is
	 * logged rather than blocking the pod's work at its new provider.
	 */
	const leaveOldProvider = (workspaceId: string, providerId: string, id: Sandboxes.SandboxId) =>
		Effect.gen(function* () {
			const old = yield* providers.connection(workspaceId, providerId);
			if (!old) return;
			yield* sandboxes
				.forConnection(old.connection)
				.destroy(id)
				.pipe(
					Effect.catchTag("SandboxUnavailable", (failure) =>
						Effect.logWarning(
							"Could not destroy a sandbox at a provider no longer in use",
							failure,
						),
					),
				);
		});

	const opened = (pod: Pod, provider: SandboxProviderRepository.Configured) =>
		Effect.gen(function* () {
			const row = yield* recorded(pod);
			const replaced = (sandbox: Sandboxes.Sandbox): Opened => ({ sandbox, arrival: "replaced" });
			if (!row) return { sandbox: yield* made(pod, provider), arrival: "made" } satisfies Opened;
			if (row.sandboxProviderId !== provider.id) {
				yield* leaveOldProvider(pod.workspaceId, row.sandboxProviderId, row.providerSandboxId);
				yield* forget(pod.podId);
				return replaced(yield* made(pod, provider));
			}
			const at = sandboxes.forConnection(provider.connection);
			return yield* at.open(row.providerSandboxId).pipe(
				// What the workspace allows may have changed since the sandbox last ran.
				Effect.tap(({ sandbox }) => Effect.flatMap(allowedHostsOf(pod), sandbox.setAllowedHosts)),
				Effect.map(
					({ sandbox, resumed }): Opened => ({
						sandbox,
						arrival: !resumed
							? "running"
							: at.capabilities.pauseKeeps === "disk"
								? "rebooted"
								: "resumed",
					}),
				),
				Effect.catchTag("SandboxMissing", () => Effect.map(restarted(pod, row, at), replaced)),
				Effect.catchTag("SandboxStopped", (stopped) =>
					Effect.map(
						restarted(pod, row, at),
						(sandbox): Opened => ({
							sandbox,
							arrival: stopped.workKept ? "rebooted" : "replaced",
						}),
					),
				),
			);
		});

	/**
	 * A new sandbox in place of one that is gone or stopped for good, made
	 * with its work name, so it carries on with any work kept apart from it.
	 */
	const restarted = (pod: Pod, row: SandboxRow, at: Sandboxes.Provider) =>
		Effect.gen(function* () {
			const fresh = yield* madeAndRecorded(at, yield* specFor(pod, row.id), (sandbox) =>
				moveRecord(row.id, row.sandboxProviderId, sandbox.id),
			);
			yield* at
				.destroy(row.providerSandboxId)
				.pipe(
					Effect.catchTag("SandboxUnavailable", (failure) =>
						Effect.logWarning("Could not destroy a sandbox that stopped", failure),
					),
				);
			return fresh;
		}).pipe(Effect.uninterruptible);

	/** Points the pod's record at its new sandbox, which is running and unused. */
	const moveRecord = (recordId: string, providerId: string, sandboxId: Sandboxes.SandboxId) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db
					.update(sandboxTable)
					.set({
						sandboxProviderId: providerId,
						providerSandboxId: sandboxId,
						pausedAt: null,
						lastUsedAt: now,
					})
					.where(eq(sandboxTable.id, recordId)),
			);
		});

	/** Takes or extends `holder`'s lease on the pod's sandbox, and marks it running. */
	const lease = (pod: Pod, holder: string) =>
		Effect.gen(function* () {
			const row = yield* recorded(pod);
			if (!row) return;
			const now = yield* DateTime.now;
			const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, LEASE));
			yield* query((db) =>
				db
					.insert(sandboxLease)
					.values({ sandboxId: row.id, holder, expiresAt })
					.onConflictDoUpdate({
						target: [sandboxLease.sandboxId, sandboxLease.holder],
						set: { expiresAt },
					}),
			);
			yield* query((db) =>
				db.update(sandboxTable).set({ pausedAt: null }).where(eq(sandboxTable.id, row.id)),
			);
		});

	/** Pauses one idle sandbox, unless a turn took it since it was found idle. */
	const pauseIfStillIdle = (row: SandboxRow, idleSince: Date, now: Date) =>
		oneAtATime(row.podId)(
			Effect.gen(function* () {
				const [still] = yield* query((db) =>
					db
						.select({ id: sandboxTable.id })
						.from(sandboxTable)
						.where(
							and(
								eq(sandboxTable.id, row.id),
								isNull(sandboxTable.pausedAt),
								lt(sandboxTable.lastUsedAt, idleSince),
								noLiveLease(now),
							),
						),
				);
				if (!still) return;
				const configured = yield* providers.connection(row.workspaceId, row.sandboxProviderId);
				if (!configured) return;
				yield* sandboxes
					.forConnection(configured.connection)
					.pause(row.providerSandboxId)
					.pipe(
						Effect.andThen(
							query((db) =>
								db.update(sandboxTable).set({ pausedAt: now }).where(eq(sandboxTable.id, row.id)),
							),
						),
						Effect.catchTags({
							// Gone at the provider: the next use makes a new one.
							SandboxMissing: () => forget(row.podId),
							SandboxUnavailable: (failure) =>
								Effect.logWarning("Could not pause an idle sandbox; trying again later", failure),
						}),
					);
			}),
		);

	const madeBy = (workspaceId: string, providerId: string) =>
		query((db) =>
			db
				.select()
				.from(sandboxTable)
				.where(
					and(
						eq(sandboxTable.workspaceId, workspaceId),
						eq(sandboxTable.sandboxProviderId, providerId),
					),
				),
		);

	/** How many turns hold a live lease on the sandbox. */
	const turnsUsing = (sandboxId: string) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const leases = yield* query((db) =>
				db
					.select({ holder: sandboxLease.holder })
					.from(sandboxLease)
					.where(and(eq(sandboxLease.sandboxId, sandboxId), gt(sandboxLease.expiresAt, now))),
			);
			return leases.length;
		});

	/** Fails while a turn is using the sandbox, which a reset or upgrade would pull out from under it. */
	const requireIdle = (sandboxId: string) =>
		Effect.flatMap(turnsUsing(sandboxId), (turns) =>
			turns > 0 ? Effect.fail(new SandboxInUse({ turns })) : Effect.void,
		);

	return Service.of({
		open: (pod, provider, holder) =>
			operation(
				"open",
				oneAtATime(pod.podId)(Effect.tap(opened(pod, provider), () => lease(pod, holder))),
			),

		renew: (holder) =>
			operation(
				"renew",
				Effect.gen(function* () {
					const now = yield* DateTime.now;
					const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, LEASE));
					yield* query((db) =>
						db.update(sandboxLease).set({ expiresAt }).where(eq(sandboxLease.holder, holder)),
					);
				}),
			),

		release: (holder) =>
			operation(
				"release",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					const released = yield* query((db) =>
						db
							.delete(sandboxLease)
							.where(eq(sandboxLease.holder, holder))
							.returning({ sandboxId: sandboxLease.sandboxId }),
					);
					for (const { sandboxId } of released) {
						yield* query((db) =>
							db
								.update(sandboxTable)
								.set({ lastUsedAt: now })
								.where(eq(sandboxTable.id, sandboxId)),
						);
					}
				}),
			),

		pauseIdle: operation(
			"pauseIdle",
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const idleSince = DateTime.toDateUtc(DateTime.subtractDuration(now, IDLE_BEFORE_PAUSE));
				const idle = yield* query((db) =>
					db
						.select()
						.from(sandboxTable)
						.where(
							and(
								isNull(sandboxTable.pausedAt),
								lt(sandboxTable.lastUsedAt, idleSince),
								noLiveLease(DateTime.toDateUtc(now)),
							),
						),
				);
				for (const row of idle) {
					yield* pauseIfStillIdle(row, idleSince, DateTime.toDateUtc(now));
				}
			}),
		),

		destroyAllMadeBy: (workspaceId, provider) =>
			operation(
				"destroyAllMadeBy",
				Effect.gen(function* () {
					const at = sandboxes.forConnection(provider.connection);
					for (const row of yield* madeBy(workspaceId, provider.id)) {
						yield* oneAtATime(row.podId)(
							at.destroy(row.providerSandboxId).pipe(Effect.andThen(forget(row.podId))),
						);
					}
				}),
			),

		applyAllowedHosts: ({ workspaceId, podId }) =>
			operation(
				"applyAllowedHosts",
				Effect.gen(function* () {
					const running = yield* query((db) =>
						db
							.select()
							.from(sandboxTable)
							.where(
								and(
									eq(sandboxTable.workspaceId, workspaceId),
									podId === undefined ? undefined : eq(sandboxTable.podId, podId),
									isNull(sandboxTable.pausedAt),
								),
							),
					);
					for (const row of running) {
						yield* oneAtATime(row.podId)(
							Effect.gen(function* () {
								const configured = yield* providers.connection(workspaceId, row.sandboxProviderId);
								if (!configured) return;
								const { sandbox } = yield* sandboxes
									.forConnection(configured.connection)
									.open(row.providerSandboxId);
								yield* sandbox.setAllowedHosts(yield* allowedHostsOf(row));
							}),
						).pipe(
							Effect.catchTags({
								SandboxMissing: () => Effect.void,
								// Its replacement is made with the hosts allowed then.
								SandboxStopped: () => Effect.void,
								SandboxUnavailable: (failure) =>
									Effect.logWarning(
										"Could not apply the workspace's allowed hosts to a sandbox; it gets them when next opened",
										failure,
									),
							}),
						);
					}
				}),
			),

		anyMadeBy: (workspaceId, providerId) =>
			operation(
				"anyMadeBy",
				Effect.map(madeBy(workspaceId, providerId), (rows) => rows.length > 0),
			),

		status: (pod, current) =>
			operation(
				"status",
				Effect.gen(function* (): Effect.fn.Return<Status, never, Database> {
					const row = yield* recorded(pod);
					if (!row) return { kind: "none" };
					const present = {
						kind: "present" as const,
						providerId: row.sandboxProviderId,
						createdAt: row.createdAt,
						lastUsedAt: row.lastUsedAt,
						turnsUsing: yield* turnsUsing(row.id),
					};
					const configured = yield* providers.connection(row.workspaceId, row.sandboxProviderId);
					if (!configured) return { ...present, state: "unreachable", upgradeAvailable: false };
					return yield* sandboxes
						.forConnection(configured.connection)
						.info(row.providerSandboxId)
						.pipe(
							Effect.map(
								(info): Status => ({
									...present,
									state: info.state,
									image: info.image,
									upgradeAvailable:
										current !== undefined &&
										(current.id !== row.sandboxProviderId ||
											imageOf(current.connection) !== info.image),
								}),
							),
							Effect.catchTags({
								SandboxMissing: () =>
									Effect.succeed<Status>({ ...present, state: "lost", upgradeAvailable: false }),
								SandboxUnavailable: () =>
									Effect.succeed<Status>({
										...present,
										state: "unreachable",
										upgradeAvailable: false,
									}),
							}),
						);
				}),
			),

		reset: (pod) =>
			operation(
				"reset",
				oneAtATime(pod.podId)(
					// Stopped between destroying and forgetting, the next use would
					// bring back the work the reset was asked to throw away.
					Effect.uninterruptible(
						Effect.gen(function* () {
							const row = yield* recorded(pod);
							if (!row) return;
							yield* requireIdle(row.id);
							const configured = yield* providers.connection(
								row.workspaceId,
								row.sandboxProviderId,
							);
							if (configured) {
								yield* sandboxes
									.forConnection(configured.connection)
									.destroy(row.providerSandboxId);
							}
							yield* forget(pod.podId);
						}),
					),
				),
			),

		upgrade: (pod, provider) =>
			operation(
				"upgrade",
				oneAtATime(pod.podId)(
					Effect.uninterruptible(
						Effect.gen(function* () {
							const row = yield* recorded(pod);
							if (!row) return yield* new NoSandbox();
							yield* requireIdle(row.id);
							const configured = yield* providers.connection(
								row.workspaceId,
								row.sandboxProviderId,
							);
							if (!configured) {
								return yield* new UpgradeFailed({
									reason: UserMessage.of`The sandbox's provider has lost its settings, so its work can't be copied. Reset it instead.`,
								});
							}
							const from = sandboxes.forConnection(configured.connection);
							const to = sandboxes.forConnection(provider.connection);
							const destroyOld = from
								.destroy(row.providerSandboxId)
								.pipe(
									Effect.catchTag("SandboxUnavailable", (failure) =>
										Effect.logWarning(
											"Could not destroy a sandbox after upgrading its pod",
											failure,
										),
									),
								);
							const { workKeptApart } = yield* from
								.info(row.providerSandboxId)
								.pipe(Effect.catchTag("SandboxMissing", () => Effect.fail(new NoSandbox())));
							if (workKeptApart && provider.id === row.sandboxProviderId) {
								yield* madeAndRecorded(to, yield* specFor(pod, row.id), (fresh) =>
									moveRecord(row.id, provider.id, fresh.id),
								);
								return yield* destroyOld;
							}
							const old = yield* from.open(row.providerSandboxId).pipe(
								Effect.map(({ sandbox }) => sandbox),
								Effect.catchTags({
									SandboxMissing: () => Effect.fail(new NoSandbox()),
									SandboxStopped: () =>
										Effect.fail(
											new UpgradeFailed({
												reason: UserMessage.of`The sandbox has stopped, so its work can't be copied to another provider. Have an agent use it once to start it again, then upgrade.`,
											}),
										),
								}),
							);
							const packed = yield* old.exec(
								`cd ${Sandboxes.WORKSPACE_DIRECTORY} && tar --exclude-vcs-ignores -czf ${ARCHIVE} .`,
								COPY_STEP,
							);
							if (packed.exitCode !== 0) {
								return yield* new UpgradeFailed({
									reason: UserMessage.of`The sandbox's work couldn't be packed up to copy.`,
								});
							}
							const archive = yield* old.readFile(ARCHIVE).pipe(
								Effect.catchTag("SandboxFileFailed", () =>
									Effect.fail(
										new UpgradeFailed({
											reason: UserMessage.of`The sandbox's work couldn't be read to copy.`,
										}),
									),
								),
							);
							yield* madeAndRecorded(to, yield* specFor(pod, row.id), (fresh) =>
								fresh.writeFile(ARCHIVE, archive).pipe(
									Effect.andThen(
										fresh.exec(
											`tar -xzf ${ARCHIVE} -C ${Sandboxes.WORKSPACE_DIRECTORY} && rm ${ARCHIVE}`,
											COPY_STEP,
										),
									),
									Effect.map((execution) => execution.exitCode === 0),
									Effect.catchTag("SandboxFileFailed", () => Effect.succeed(false)),
									Effect.flatMap((unpacked) =>
										unpacked
											? moveRecord(row.id, provider.id, fresh.id)
											: Effect.fail(
													new UpgradeFailed({
														reason: UserMessage.of`The work couldn't be unpacked in the new sandbox. The old one is untouched.`,
													}),
												),
									),
								),
							);
							yield* destroyOld;
						}),
					),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Sandboxes.layer, SandboxProviderRepository.layer]),
);

/** Runs `pauseIdle` every minute for as long as the layer's scope is open. */
export const pauseSweepLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const podSandboxes = yield* Service;
		const database = yield* Database;
		const pass = podSandboxes.pauseIdle.pipe(
			Effect.provideService(Database, database),
			Effect.catchCause((cause) => Effect.logError("Pausing idle sandboxes failed", cause)),
		);
		yield* Effect.forkScoped(
			pass.pipe(
				Effect.delay(PAUSE_SWEEP_INTERVAL),
				Effect.forever,
				Effect.withTracerEnabled(false),
			),
		);
	}),
).pipe(Layer.provide(layer));

/** No lease on the sandbox that is still in force at `now`. */
function noLiveLease(now: Date) {
	return sql`not exists (select 1 from ${sandboxLease} where ${sandboxLease.sandboxId} = ${sandboxTable.id} and ${sandboxLease.expiresAt} > ${now})`;
}

type SandboxRow = typeof sandboxTable.$inferSelect;

export interface Pod {
	readonly workspaceId: string;
	readonly podId: string;
}

export interface Opened {
	readonly sandbox: Sandboxes.Sandbox;
	/**
	 * How the sandbox came to be ready, which decides what the agent is told:
	 * - `made`: new, with nothing in it.
	 * - `running`: as the pod left it.
	 * - `resumed`: paused, and back with its programs still running.
	 * - `rebooted`: paused or stopped, and back with its files but no running
	 *   programs.
	 * - `replaced`: new, because the pod's earlier one is gone with its work:
	 *   its provider lost it, it stopped with its work on its own disk, or the
	 *   workspace changed provider.
	 */
	readonly arrival: "made" | "running" | "resumed" | "rebooted" | "replaced";
}

export type Status =
	| { readonly kind: "none" }
	| {
			readonly kind: "present";
			/**
			 * `lost`: the provider no longer has it. `unreachable`: its provider
			 * didn't answer, or has lost its settings.
			 */
			readonly state: "running" | "paused" | "lost" | "unreachable";
			/** As its provider names it, when the provider answered. */
			readonly image?: string;
			readonly providerId: string;
			readonly createdAt: Date;
			readonly lastUsedAt: Date;
			readonly turnsUsing: number;
			/** Whether the enabled provider would make it from another image, or is another provider. */
			readonly upgradeAvailable: boolean;
	  };

/** Where an upgrade packs the workspace in the old sandbox, and unpacks it in the new. */
const ARCHIVE = "/tmp/sugabots-workspace.tgz";
const COPY_STEP = { timeout: "5 minutes", maxOutputCharacters: 4_000 } as const;

/** The image or template a connection makes sandboxes from. */
function imageOf(connection: Sandboxes.Connection): string {
	return connection.provider === "e2b" ? connection.template : connection.image;
}

/** A turn is using the sandbox, and resetting or upgrading it would pull it out from under the agent. */
export class SandboxInUse
	extends Data.TaggedError("SandboxInUse")<{ turns: number }>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`An agent is using the sandbox right now. Try again when it has finished.`;
	}
}

/** The pod has no sandbox to upgrade, or its provider lost it. */
export class NoSandbox extends Data.TaggedError("NoSandbox") implements UserFacing {
	get userMessage() {
		return UserMessage.of`This pod has no sandbox to upgrade. Its next one is made from the current image.`;
	}
}

/** An upgrade stopped before the pod moved; its old sandbox is untouched. */
export class UpgradeFailed
	extends Data.TaggedError("UpgradeFailed")<{ reason: UserMessage }>
	implements UserFacing
{
	get userMessage() {
		return this.reason;
	}
}
