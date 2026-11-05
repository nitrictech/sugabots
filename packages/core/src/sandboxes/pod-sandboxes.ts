export * as PodSandboxes from "./pod-sandboxes.ts";

import { type UserText, userText } from "@sugabots/errors";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Clock, Context, Data, DateTime, Duration, Effect, Layer, Semaphore } from "effect";
import { Database, query, serviceOperations } from "../database/database.ts";
import { sandboxLease, sandbox as sandboxTable } from "../database/schema.ts";
import { Ids } from "../ids/ids.ts";
import { Egress } from "../providers/network/egress.ts";
import type { UserFacing } from "../user-message.ts";
import { reachOf } from "./allowed-hosts.ts";
import { pinnedToDigest, withoutTag } from "./image-digest.ts";
import { SandboxCredentials } from "./sandbox-credentials.ts";
import { type DiskUsage, measureDisk } from "./sandbox-disk.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";
import type { SandboxLeaseHolderKind } from "./sql.ts";

/** How long a lease holds a sandbox awake unless it is renewed. */
export const LEASE = Duration.seconds(90);
/** How often a turn renews its lease, well inside {@link LEASE}. */
export const LEASE_RENEWAL = Duration.seconds(30);
/** How long a sandbox sits with no turn using it before it is paused. */
export const IDLE_BEFORE_PAUSE = Duration.minutes(5);
/** How long before its credentials expire a sandbox in use is given new ones. */
const CREDENTIAL_REFRESH_MARGIN = Duration.minutes(10);
/** How often the sweeps look for idle sandboxes to pause, and running ones to measure. */
const SWEEP_INTERVAL = Duration.minutes(1);
/** How long a running sandbox's disk goes before it is measured again. */
const DISK_MEASUREMENT_INTERVAL = Duration.minutes(2);
/** How many sandboxes' disks are measured at once. */
const DISK_MEASUREMENT_CONCURRENCY = 4;
/** How long what an image's tag names is relied on before its registry is asked again. */
const IMAGE_RECHECK = Duration.minutes(10);
/** How long a registry has to say what an image's tag names. */
const REGISTRY_TIMEOUT = Duration.seconds(5);
/** How long after a sandbox fails to upgrade on its own before it is tried again. */
const UPGRADE_RETRY = Duration.hours(1);

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
		holder: Holder,
	) => Effect.Effect<Opened, Sandboxes.Unavailable>;
	/**
	 * Extends `holder`'s leases, and signs their sandboxes in afresh when their
	 * credentials are about to expire. Nothing happens if it has none.
	 */
	readonly renew: (holder: Holder) => Effect.Effect<void>;
	/** Ends `holder`'s leases, starting the idle time of the sandboxes it held. */
	readonly release: (holder: Holder) => Effect.Effect<void>;
	/** Pauses every sandbox nobody has used for {@link IDLE_BEFORE_PAUSE}. */
	readonly pauseIdle: Effect.Effect<void>;
	/**
	 * Upgrades every sandbox nobody has used or watched for
	 * {@link IDLE_BEFORE_PAUSE} whose image is behind what the workspace's
	 * enabled provider makes sandboxes from now, as {@link upgrade} does, and
	 * leaves the new one paused. Only at a provider that takes images as they
	 * are; a template is left to be rebuilt and upgraded to by hand. Skips for
	 * {@link UPGRADE_RETRY} a sandbox that failed to upgrade.
	 */
	readonly upgradeIdle: Effect.Effect<void>;
	/**
	 * Measures the disk of every running sandbox not measured for
	 * {@link DISK_MEASUREMENT_INTERVAL}, without resuming any: a paused
	 * sandbox's disk doesn't change, so its last measurement still holds.
	 */
	readonly measureDisks: Effect.Effect<void>;
	/** The last measurement of the pod's sandbox's disk, if it has one. */
	readonly diskOf: (pod: Pod) => Effect.Effect<MeasuredDisk | undefined>;
	/** The last measurement of the disk of each of the workspace's pods' sandboxes that has one. */
	readonly disksIn: (workspaceId: string) => Effect.Effect<readonly PodDisk[]>;
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
	 * the hosts each may reach now, signed in as each pod is now. A paused one
	 * is brought up to date when it is next opened; one that can't be reached
	 * is logged and left for then too.
	 */
	readonly applyNetwork: (where: { workspaceId: string; podId?: string }) => Effect.Effect<void>;
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
	const signIns = yield* SandboxCredentials.Service;
	const egress = yield* Egress.Service;
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

	// When each pod's sandbox must be signed in again, from when it last was by
	// this process. Another process's sandboxes are signed in on first renewal.
	const signInDue = new Map<string, number>();

	// What each image's tag named when its registry was last asked, and until when that is relied on.
	const tagged = new Map<string, { pinned: string | undefined; until: number }>();
	/** `image` pinned to the digest its tag names now, if its registry says. */
	const pinnedNow = (image: string) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const known = tagged.get(image);
			if (known && known.until > now) return known.pinned;
			// Asked on the way to making a turn's sandbox, so a registry that
			// doesn't answer soon leaves the image as it is configured.
			const pinned = yield* Effect.tryPromise((signal) =>
				pinnedToDigest(image, egress.providers, signal),
			).pipe(
				Effect.timeout(REGISTRY_TIMEOUT),
				Effect.orElseSucceed(() => undefined),
			);
			tagged.set(image, { pinned, until: now + Duration.toMillis(IMAGE_RECHECK) });
			return pinned;
		});

	/**
	 * The connection with an image its provider takes as it is pinned to the
	 * digest its tag names now, so a new sandbox gets that image rather than
	 * whatever the provider's host last pulled for the tag.
	 */
	const pinnedConnection = (connection: Sandboxes.Connection) =>
		connection.provider === "opensandbox"
			? Effect.map(
					pinnedNow(connection.image),
					(pinned): Sandboxes.Connection => ({ ...connection, image: pinned ?? connection.image }),
				)
			: Effect.succeed(connection);

	/** Whether a sandbox made from `madeFrom` is behind what `connection` makes sandboxes from now. */
	const isBehind = (madeFrom: string | null, connection: Sandboxes.Connection) =>
		connection.provider === "opensandbox"
			? Effect.map(pinnedNow(connection.image), (pinned) =>
					imageIsBehind(madeFrom, connection.image, pinned),
				)
			: Effect.succeed(madeFrom !== imageOf(connection));

	// When a sandbox that failed to upgrade on its own may be tried again, by its record's id.
	const upgradeRetryAt = new Map<string, number>();

	/**
	 * Sets what the pod's sandbox may reach and what it is signed in with,
	 * as far as its provider can add credentials.
	 */
	const applyNetwork = (pod: Pod, sandbox: Sandboxes.Sandbox, at: Sandboxes.Provider) =>
		Effect.gen(function* () {
			const [reach, signedIn] = yield* Effect.all([reachOf(pod, at), signIns.forPod(pod)]);
			yield* sandbox.setNetwork({
				reach,
				credentials: fittedTo(at.capabilities.credentials, signedIn.credentials),
				environment: at.capabilities.credentials === "none" ? {} : signedIn.environment,
			});
			if (signedIn.expiresAt === undefined) {
				signInDue.delete(pod.podId);
				return;
			}
			const due = DateTime.subtractDuration(signedIn.expiresAt, CREDENTIAL_REFRESH_MARGIN);
			signInDue.set(pod.podId, DateTime.toEpochMillis(due));
		});

	/** Brings a running sandbox's network up to date, as {@link applyNetwork} does on open. */
	const applyNetworkWhileRunning = (row: SandboxRow) =>
		oneAtATime(row.podId)(
			Effect.gen(function* () {
				const configured = yield* providers.connection(row.workspaceId, row.sandboxProviderId);
				if (!configured) return;
				const at = sandboxes.forConnection(configured.connection);
				const { sandbox } = yield* at.open(row.providerSandboxId);
				yield* applyNetwork(row, sandbox, at);
			}),
		).pipe(
			Effect.catchTags({
				SandboxMissing: () => Effect.void,
				// Its replacement is made with the network allowed then.
				SandboxStopped: () => Effect.void,
				SandboxUnavailable: (failure) =>
					Effect.logWarning(
						"Could not bring a sandbox's network up to date; it is when next opened",
						failure,
					),
			}),
		);

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
	const specFor = (pod: Pod, recordId: string, at: Sandboxes.Provider) =>
		Effect.map(
			reachOf(pod, at),
			(reach): Sandboxes.Spec => ({
				labels: { "sugabots.workspace": pod.workspaceId, "sugabots.pod": pod.podId },
				reach,
				workName: recordId,
			}),
		);

	/**
	 * Makes a sandbox through `connection`, from its image pinned to its
	 * digest, and hands it to `record` with what it was made from, as one step
	 * that isn't stopped part-way when whoever asked goes away: a sandbox made
	 * but never recorded is one nothing would find to destroy. One whose
	 * recording fails is destroyed.
	 */
	const madeAndRecorded = <E, R>(
		connection: Sandboxes.Connection,
		spec: Sandboxes.Spec,
		record: (sandbox: Sandboxes.Sandbox, image: string) => Effect.Effect<unknown, E, R>,
	) =>
		Effect.flatMap(pinnedConnection(connection), (pinned) => {
			const at = sandboxes.forConnection(pinned);
			return Effect.uninterruptible(
				Effect.tap(at.create(spec), (sandbox) =>
					record(sandbox, imageOf(pinned)).pipe(
						Effect.onError(() => at.destroy(sandbox.id).pipe(Effect.ignore)),
					),
				),
			);
		});

	const made = (pod: Pod, provider: SandboxProviderRepository.Configured) =>
		Effect.gen(function* () {
			const id = yield* ids.next;
			const at = sandboxes.forConnection(provider.connection);
			return yield* madeAndRecorded(
				provider.connection,
				yield* specFor(pod, id, at),
				(sandbox, image) =>
					query((db) =>
						db.insert(sandboxTable).values({
							id,
							workspaceId: pod.workspaceId,
							podId: pod.podId,
							sandboxProviderId: provider.id,
							providerSandboxId: sandbox.id,
							image,
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
				Effect.catchTag("SandboxMissing", () =>
					Effect.map(restarted(pod, row, provider.connection), replaced),
				),
				Effect.catchTag("SandboxStopped", (stopped) =>
					Effect.map(
						restarted(pod, row, provider.connection),
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
	const restarted = (pod: Pod, row: SandboxRow, connection: Sandboxes.Connection) =>
		Effect.gen(function* () {
			const at = sandboxes.forConnection(connection);
			const fresh = yield* madeAndRecorded(
				connection,
				yield* specFor(pod, row.id, at),
				(sandbox, image) => moveRecord(row.id, row.sandboxProviderId, sandbox.id, image),
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

	/** Points the pod's record at its new sandbox, made from `image`, which is running and unused. */
	const moveRecord = (
		recordId: string,
		providerId: string,
		sandboxId: Sandboxes.SandboxId,
		image: string,
	) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db
					.update(sandboxTable)
					.set({
						sandboxProviderId: providerId,
						providerSandboxId: sandboxId,
						image,
						pausedAt: null,
						lastUsedAt: now,
						diskUsage: null,
						diskMeasuredAt: null,
					})
					.where(eq(sandboxTable.id, recordId)),
			);
		});

	/** Takes or extends `holder`'s lease on the pod's sandbox, and marks it running. */
	const lease = (pod: Pod, holder: Holder) =>
		Effect.gen(function* () {
			const row = yield* recorded(pod);
			if (!row) return;
			const now = yield* DateTime.now;
			const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, LEASE));
			yield* query((db) =>
				db
					.insert(sandboxLease)
					.values({ sandboxId: row.id, holderKind: holder.kind, holderId: holder.id, expiresAt })
					.onConflictDoUpdate({
						target: [sandboxLease.sandboxId, sandboxLease.holderKind, sandboxLease.holderId],
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

	/**
	 * Measures one sandbox's disk if it is running. It is opened under the
	 * pod's lock, which the pause sweep pauses under, so a sandbox paused
	 * meanwhile is never resumed to be measured. The measuring itself runs
	 * outside the lock, so as not to hold up turns; a sandbox paused while
	 * it runs fails it, and keeps its last measurement.
	 */
	const measureDiskIfRunning = (row: SandboxRow) =>
		Effect.gen(function* () {
			const configured = yield* providers.connection(row.workspaceId, row.sandboxProviderId);
			if (!configured) return;
			const at = sandboxes.forConnection(configured.connection);
			const running = yield* oneAtATime(row.podId)(
				Effect.gen(function* () {
					const [still] = yield* query((db) =>
						db
							.select({ id: sandboxTable.id })
							.from(sandboxTable)
							.where(and(sameSandbox(row), isNull(sandboxTable.pausedAt))),
					);
					if (!still) return undefined;
					const { state } = yield* at.info(row.providerSandboxId);
					if (state !== "running") return undefined;
					return (yield* at.open(row.providerSandboxId)).sandbox;
				}),
			);
			if (!running) return;
			const usage = yield* measureDisk(running);
			const now = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db
					.update(sandboxTable)
					.set({ diskUsage: usage, diskMeasuredAt: now })
					.where(sameSandbox(row)),
			);
		}).pipe(
			Effect.catchTags({
				SandboxMissing: () => Effect.void,
				SandboxStopped: () => Effect.void,
				SandboxUnavailable: (failure) =>
					Effect.logWarning("Could not measure a sandbox's disk; trying again later", failure),
				DiskUnmeasurable: (failure) =>
					Effect.logWarning("A sandbox's disk could not be measured", {
						exitCode: failure.exitCode,
						stderr: failure.stderr,
					}),
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

	/** Who holds a live lease on the sandbox: turns, and people watching a desktop. */
	const holders = (sandboxId: string) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const leases = yield* query((db) =>
				db
					.select({ holderKind: sandboxLease.holderKind })
					.from(sandboxLease)
					.where(and(eq(sandboxLease.sandboxId, sandboxId), gt(sandboxLease.expiresAt, now))),
			);
			const turns = leases.filter(({ holderKind }) => holderKind === "turn").length;
			return { turns, watching: leases.length - turns };
		});

	/** Fails while a turn is using the sandbox, which a reset or upgrade would pull out from under it. */
	const requireIdle = (sandboxId: string) =>
		Effect.flatMap(holders(sandboxId), ({ turns }) =>
			turns > 0 ? Effect.fail(new SandboxInUse({ turns })) : Effect.void,
		);

	/**
	 * Moves the work of the pod's sandbox, `row`, to a new one `provider`
	 * makes, as {@link Interface.upgrade} describes, and destroys the old one.
	 * The caller holds the pod's lock and has checked nobody is using it.
	 */
	const movedToNewSandbox = (row: SandboxRow, provider: SandboxProviderRepository.Configured) =>
		Effect.gen(function* () {
			const configured = yield* providers.connection(row.workspaceId, row.sandboxProviderId);
			if (!configured) {
				return yield* new UpgradeFailed({
					reason: userText`The sandbox's provider has lost its settings, so its work can't be copied. Reset it instead.`,
				});
			}
			const from = sandboxes.forConnection(configured.connection);
			const to = sandboxes.forConnection(provider.connection);
			const destroyOld = from
				.destroy(row.providerSandboxId)
				.pipe(
					Effect.catchTag("SandboxUnavailable", (failure) =>
						Effect.logWarning("Could not destroy a sandbox after upgrading its pod", failure),
					),
				);
			const { workKeptApart } = yield* from
				.info(row.providerSandboxId)
				.pipe(Effect.catchTag("SandboxMissing", () => Effect.fail(new NoSandbox())));
			if (workKeptApart && provider.id === row.sandboxProviderId) {
				const fresh = yield* madeAndRecorded(
					provider.connection,
					yield* specFor(row, row.id, to),
					(sandbox, image) => moveRecord(row.id, provider.id, sandbox.id, image),
				);
				yield* destroyOld;
				return fresh;
			}
			const old = yield* from.open(row.providerSandboxId).pipe(
				Effect.map(({ sandbox }) => sandbox),
				Effect.catchTags({
					SandboxMissing: () => Effect.fail(new NoSandbox()),
					SandboxStopped: () =>
						Effect.fail(
							new UpgradeFailed({
								reason: userText`The sandbox has stopped, so its work can't be copied to another provider. Have an agent use it once to start it again, then upgrade.`,
							}),
						),
				}),
			);
			const archivePath = `/tmp/sugabots-workspace-${yield* ids.random}.tgz`;
			const packed = yield* old.exec(
				`cd ${Sandboxes.WORKSPACE_DIRECTORY} && tar --exclude-vcs-ignores -czf ${archivePath} .`,
				COPY_STEP,
			);
			if (packed.exitCode !== 0) {
				return yield* new UpgradeFailed({
					reason: userText`The sandbox's work couldn't be packed up to copy.`,
				});
			}
			const archive = yield* old
				.downloadFile(archivePath)
				.pipe(
					Effect.catchTag("SandboxFileFailed", () =>
						Effect.fail(
							new UpgradeFailed({ reason: userText`The sandbox's work couldn't be read to copy.` }),
						),
					),
				);
			const fresh = yield* madeAndRecorded(
				provider.connection,
				yield* specFor(row, row.id, to),
				(sandbox, image) =>
					sandbox.uploadFile(archivePath, archive).pipe(
						Effect.andThen(
							sandbox.exec(
								`tar -xzf ${archivePath} -C ${Sandboxes.WORKSPACE_DIRECTORY} && rm ${archivePath}`,
								COPY_STEP,
							),
						),
						Effect.map((execution) => execution.exitCode === 0),
						Effect.catchTag("SandboxFileFailed", () => Effect.succeed(false)),
						Effect.flatMap((unpacked) =>
							unpacked
								? moveRecord(row.id, provider.id, sandbox.id, image)
								: Effect.fail(
										new UpgradeFailed({
											reason: userText`The work couldn't be unpacked in the new sandbox. The old one is untouched.`,
										}),
									),
						),
					),
			);
			yield* destroyOld;
			return fresh;
		});

	/**
	 * Upgrades the workspace's idle sandboxes, found as
	 * {@link Interface.upgradeIdle} describes, that are behind its enabled
	 * provider.
	 */
	const upgradeBehindIn = (
		workspaceId: string,
		idle: readonly SandboxRow[],
		idleSince: Date,
		now: Date,
	) =>
		Effect.gen(function* () {
			const provider = yield* providers.enabled(workspaceId);
			if (!provider) return;
			const at = sandboxes.forConnection(provider.connection);
			if (at.templates) return;
			for (const row of idle) {
				// One at a provider no longer enabled moves when next opened.
				if (row.sandboxProviderId !== provider.id) continue;
				if ((upgradeRetryAt.get(row.id) ?? 0) > now.getTime()) continue;
				if (!(yield* isBehind(row.image, provider.connection))) continue;
				yield* upgradeIfStillIdle(row, provider, at, idleSince, now).pipe(
					Effect.catchCause((cause) => Effect.logError("Upgrading an idle sandbox failed", cause)),
					Effect.annotateLogs({ sandboxId: row.id }),
				);
			}
		});

	/** Upgrades one idle sandbox, unless someone took it since it was found. */
	const upgradeIfStillIdle = (
		row: SandboxRow,
		provider: SandboxProviderRepository.Configured,
		at: Sandboxes.Provider,
		idleSince: Date,
		now: Date,
	) =>
		oneAtATime(row.podId)(
			Effect.uninterruptible(
				Effect.gen(function* () {
					const [still] = yield* query((db) =>
						db
							.select({ id: sandboxTable.id })
							.from(sandboxTable)
							.where(
								and(sameSandbox(row), lt(sandboxTable.lastUsedAt, idleSince), noLiveLease(now)),
							),
					);
					if (!still) return;
					const fresh = yield* movedToNewSandbox(row, provider);
					yield* pausedUnused(row, fresh.id, at);
				}),
			),
		).pipe(
			Effect.catchTags({
				// Gone at the provider: the next use makes a new one.
				NoSandbox: () => Effect.void,
				UpgradeFailed: (failure) => retryUpgradeLater(row.id, now, failure),
				SandboxUnavailable: (failure) => retryUpgradeLater(row.id, now, failure),
			}),
		);

	/**
	 * Gives the pod's record back the time `row` was last used, since nobody
	 * has used the sandbox it was upgraded to, then pauses that sandbox. One
	 * that can't be paused now is paused by the idle sweep, as idle as before.
	 */
	const pausedUnused = (row: SandboxRow, freshId: Sandboxes.SandboxId, at: Sandboxes.Provider) =>
		query((db) =>
			db
				.update(sandboxTable)
				.set({ lastUsedAt: row.lastUsedAt })
				.where(eq(sandboxTable.id, row.id)),
		).pipe(
			Effect.andThen(at.pause(freshId)),
			Effect.andThen(
				Effect.flatMap(DateTime.nowAsDate, (now) =>
					query((db) =>
						db.update(sandboxTable).set({ pausedAt: now }).where(eq(sandboxTable.id, row.id)),
					),
				),
			),
			Effect.catchTags({
				SandboxMissing: () => Effect.void,
				SandboxUnavailable: (failure) =>
					Effect.logWarning("Could not pause an upgraded sandbox; it is paused once idle", failure),
			}),
		);

	const retryUpgradeLater = (recordId: string, now: Date, failure: unknown) =>
		Effect.andThen(
			Effect.sync(() =>
				upgradeRetryAt.set(recordId, now.getTime() + Duration.toMillis(UPGRADE_RETRY)),
			),
			Effect.logWarning("Could not upgrade an idle sandbox; trying again later", failure),
		);

	return Service.of({
		open: (pod, provider, holder) =>
			operation(
				"open",
				oneAtATime(pod.podId)(
					opened(pod, provider).pipe(
						// What the workspace allows, and what the pod signs in to, may
						// have changed since the sandbox last ran.
						Effect.tap(({ sandbox }) =>
							applyNetwork(pod, sandbox, sandboxes.forConnection(provider.connection)),
						),
						Effect.tap(() => lease(pod, holder)),
					),
				),
			),

		renew: (holder) =>
			operation(
				"renew",
				Effect.gen(function* () {
					const now = yield* DateTime.now;
					const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, LEASE));
					const renewed = yield* query((db) =>
						db
							.update(sandboxLease)
							.set({ expiresAt })
							.where(heldBy(holder))
							.returning({ sandboxId: sandboxLease.sandboxId }),
					);
					if (renewed.length === 0) return;
					const rows = yield* query((db) =>
						db
							.select()
							.from(sandboxTable)
							.where(
								inArray(
									sandboxTable.id,
									renewed.map(({ sandboxId }) => sandboxId),
								),
							),
					);
					const nowMillis = DateTime.toEpochMillis(now);
					for (const row of rows) {
						const due = signInDue.get(row.podId);
						if (due !== undefined && due > nowMillis) continue;
						yield* applyNetworkWhileRunning(row);
					}
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
							.where(heldBy(holder))
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

		measureDisks: operation(
			"measureDisks",
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const measuredBefore = DateTime.toDateUtc(
					DateTime.subtractDuration(now, DISK_MEASUREMENT_INTERVAL),
				);
				// A sandbox nobody has used since its last measurement isn't measured
				// again. Its disk barely changes, and opening one can postpone the
				// provider's own pause, the backstop for when ours fails.
				const usedSinceMeasured = or(
					liveLease(DateTime.toDateUtc(now)),
					gt(sandboxTable.lastUsedAt, sandboxTable.diskMeasuredAt),
				);
				const due = yield* query((db) =>
					db
						.select()
						.from(sandboxTable)
						.where(
							and(
								isNull(sandboxTable.pausedAt),
								or(
									isNull(sandboxTable.diskMeasuredAt),
									and(lt(sandboxTable.diskMeasuredAt, measuredBefore), usedSinceMeasured),
								),
							),
						),
				);
				// One sandbox that can't be measured, such as one whose provider's
				// key no longer decrypts, mustn't stop the others being measured.
				const measureOnItsOwn = (row: SandboxRow) =>
					measureDiskIfRunning(row).pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Measuring a sandbox's disk failed", cause),
						),
						Effect.annotateLogs({ sandboxId: row.id }),
					);
				yield* Effect.forEach(due, measureOnItsOwn, {
					concurrency: DISK_MEASUREMENT_CONCURRENCY,
					discard: true,
				});
			}),
		),

		diskOf: (pod) =>
			operation(
				"diskOf",
				Effect.map(
					query((db) =>
						db
							.select(MEASUREMENT_COLUMNS)
							.from(sandboxTable)
							.where(
								and(
									eq(sandboxTable.workspaceId, pod.workspaceId),
									eq(sandboxTable.podId, pod.podId),
								),
							),
					),
					([row]) => (row ? measuredDiskOf(row) : undefined),
				),
			),

		disksIn: (workspaceId) =>
			operation(
				"disksIn",
				Effect.map(
					query((db) =>
						db
							.select({ podId: sandboxTable.podId, ...MEASUREMENT_COLUMNS })
							.from(sandboxTable)
							.where(eq(sandboxTable.workspaceId, workspaceId)),
					),
					(rows) =>
						rows.flatMap((row) => {
							const disk = measuredDiskOf(row);
							return disk ? [{ podId: row.podId, disk }] : [];
						}),
				),
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

		applyNetwork: ({ workspaceId, podId }) =>
			operation(
				"applyNetwork",
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
					for (const row of running) yield* applyNetworkWhileRunning(row);
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
					const using = yield* holders(row.id);
					const present = {
						kind: "present" as const,
						providerId: row.sandboxProviderId,
						createdAt: row.createdAt,
						lastUsedAt: row.lastUsedAt,
						turnsUsing: using.turns,
						peopleWatching: using.watching,
						disk: measuredDiskOf(row),
					};
					const configured = yield* providers.connection(row.workspaceId, row.sandboxProviderId);
					if (!configured) return { ...present, state: "unreachable", upgradeAvailable: false };
					return yield* sandboxes
						.forConnection(configured.connection)
						.info(row.providerSandboxId)
						.pipe(
							Effect.flatMap((info) => {
								// What Sugabots asked for, since a provider may name the image
								// by a tag it has for it: OpenSandbox answers a sandbox made
								// from `debian@sha256:…` with `debian:bookworm-slim`.
								const image = row.image ?? info.image;
								return Effect.map(
									current === undefined || current.id !== row.sandboxProviderId
										? Effect.succeed(current !== undefined)
										: isBehind(image, current.connection),
									(upgradeAvailable): Status => ({
										...present,
										state: info.state,
										image,
										upgradeAvailable,
									}),
								);
							}),
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
							yield* movedToNewSandbox(row, provider);
						}),
					),
				),
			),

		upgradeIdle: operation(
			"upgradeIdle",
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const idleSince = DateTime.toDateUtc(DateTime.subtractDuration(now, IDLE_BEFORE_PAUSE));
				const idle = yield* query((db) =>
					db
						.select()
						.from(sandboxTable)
						.where(
							and(lt(sandboxTable.lastUsedAt, idleSince), noLiveLease(DateTime.toDateUtc(now))),
						),
				);
				// A workspace whose provider can't be read, such as one whose key no
				// longer decrypts, is logged once, and the others still upgrade.
				for (const [workspaceId, rows] of Map.groupBy(idle, (row) => row.workspaceId)) {
					yield* upgradeBehindIn(workspaceId, rows, idleSince, DateTime.toDateUtc(now)).pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Upgrading a workspace's idle sandboxes failed", cause),
						),
						Effect.annotateLogs({ workspaceId }),
					);
				}
			}),
		),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Sandboxes.layer, SandboxProviderRepository.layer]),
);

/**
 * Runs `pauseIdle`, `measureDisks` and `upgradeIdle` every minute, each on its
 * own so a slow measurement or upgrade never holds up a pause, for as long as
 * the layer's scope is open.
 */
export const sweepLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const podSandboxes = yield* Service;
		const database = yield* Database;
		const repeatedly = (sweep: Effect.Effect<void, never, Database>, failureMessage: string) =>
			Effect.forkScoped(
				sweep.pipe(
					Effect.provideService(Database, database),
					Effect.catchCause((cause) => Effect.logError(failureMessage, cause)),
					Effect.delay(SWEEP_INTERVAL),
					Effect.forever,
					Effect.withTracerEnabled(false),
				),
			);
		yield* repeatedly(podSandboxes.pauseIdle, "Pausing idle sandboxes failed");
		yield* repeatedly(podSandboxes.measureDisks, "Measuring sandboxes' disks failed");
		yield* repeatedly(podSandboxes.upgradeIdle, "Upgrading idle sandboxes failed");
	}),
).pipe(Layer.provide(layer));

/** The columns that record a sandbox's last disk measurement. */
const MEASUREMENT_COLUMNS = {
	diskUsage: sandboxTable.diskUsage,
	diskMeasuredAt: sandboxTable.diskMeasuredAt,
};

/** The row's last disk measurement; the columns are null together until there is one. */
function measuredDiskOf(
	row: Pick<SandboxRow, "diskUsage" | "diskMeasuredAt">,
): MeasuredDisk | undefined {
	if (!row.diskUsage || !row.diskMeasuredAt) return undefined;
	return { ...row.diskUsage, measuredAt: row.diskMeasuredAt };
}

/** The row, while it still records the same sandbox at the provider. */
function sameSandbox(row: SandboxRow) {
	return and(
		eq(sandboxTable.id, row.id),
		eq(sandboxTable.providerSandboxId, row.providerSandboxId),
	);
}

/** A lease on the sandbox that is still in force at `now`. */
function liveLease(now: Date) {
	return sql`exists (select 1 from ${sandboxLease} where ${sandboxLease.sandboxId} = ${sandboxTable.id} and ${sandboxLease.expiresAt} > ${now})`;
}

/** No lease on the sandbox that is still in force at `now`. */
function noLiveLease(now: Date) {
	return sql`not ${liveLease(now)}`;
}

/**
 * Whether a sandbox made from `madeFrom` is behind `configured`, whose tag
 * names `pinned` now if its registry said. A sandbox made before images were
 * recorded, from whatever its provider's host had for the tag, counts as
 * behind, so each is upgraded once onto a digest that is known. When the
 * registry didn't say, only a sandbox made from another image altogether is
 * known to be behind: one pinned from `configured`, or made before images
 * were recorded, may still be what its tag names.
 */
function imageIsBehind(madeFrom: string | null, configured: string, pinned: string | undefined) {
	if (pinned !== undefined) return madeFrom !== pinned;
	if (madeFrom === null) return false;
	return madeFrom !== configured && !madeFrom.startsWith(`${withoutTag(configured)}@`);
}

type SandboxRow = typeof sandboxTable.$inferSelect;

/** What holds a lease: a turn using the sandbox, or a person viewing its desktop. */
export interface Holder {
	readonly kind: SandboxLeaseHolderKind;
	readonly id: string;
}

function heldBy(holder: Holder) {
	return and(eq(sandboxLease.holderKind, holder.kind), eq(sandboxLease.holderId, holder.id));
}

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
			/**
			 * What it was made from, as Sugabots asked for it, or, for one made
			 * before that was recorded, as its provider names it; only when the
			 * provider answered.
			 */
			readonly image?: string;
			readonly providerId: string;
			readonly createdAt: Date;
			readonly lastUsedAt: Date;
			readonly turnsUsing: number;
			readonly peopleWatching: number;
			/** Whether the enabled provider would make it from another image, or is another provider. */
			readonly upgradeAvailable: boolean;
			/** Its last measurement, if it has been measured. */
			readonly disk?: MeasuredDisk;
	  };

/** How full a sandbox's disk was when it was measured. */
export interface MeasuredDisk extends DiskUsage {
	readonly measuredAt: Date;
}

/** The last measurement of a pod's sandbox's disk. */
export interface PodDisk {
	readonly podId: string;
	readonly disk: MeasuredDisk;
}

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
		return userText`An agent is using the sandbox right now. Try again when it has finished.`;
	}
}

/** The pod has no sandbox to upgrade, or its provider lost it. */
export class NoSandbox extends Data.TaggedError("NoSandbox") implements UserFacing {
	get userMessage() {
		return userText`This pod has no sandbox to upgrade. Its next one is made from the current image.`;
	}
}

/** An upgrade stopped before the pod moved; its old sandbox is untouched. */
export class UpgradeFailed
	extends Data.TaggedError("UpgradeFailed")<{ reason: UserText }>
	implements UserFacing
{
	get userMessage() {
		return this.reason;
	}
}

/**
 * What of `credentials` a provider that adds them by `scope` can add: by
 * host alone, the first for each host, which then covers its every path.
 */
function fittedTo(
	scope: Sandboxes.Capabilities["credentials"],
	credentials: readonly Sandboxes.Credential[],
): readonly Sandboxes.Credential[] {
	if (scope === "none") return [];
	const kept = new Map<string, Sandboxes.Credential>();
	for (const credential of credentials) {
		const fitted = scope === "host" ? { ...credential, pathPrefix: undefined } : credential;
		const key = `${fitted.host} ${fitted.pathPrefix ?? ""} ${fitted.header}`;
		if (!kept.has(key)) kept.set(key, fitted);
	}
	return [...kept.values()];
}
