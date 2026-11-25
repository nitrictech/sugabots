/** How changing a project's computer fails, as the computers operations do. */
export {
	ComputerInUse,
	ComputerMadeMeanwhile,
	NoComputer,
	UpgradeFailed,
} from "@sugabots/contracts/errors/computers";
export * as ProjectComputers from "./project-computers.ts";

import { posix } from "node:path";
import { COMPUTER_DISK_WARNING_SHARE, computerDiskShare } from "@sugabots/contracts";
import {
	ClaimLost,
	ComputerInUse,
	ComputerMadeMeanwhile,
	NoComputer,
	UpgradeFailed,
} from "@sugabots/contracts/errors/computers";
import { userText } from "@sugabots/errors";
import { and, eq, gt, inArray, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import {
	Clock,
	Context,
	DateTime,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	type Scope,
	Semaphore,
} from "effect";
import {
	Database,
	query,
	serviceOperations,
	type Transaction,
	transaction,
	writtenRow,
} from "../database/database.ts";
import { violatedUniqueConstraint } from "../database/errors.ts";
import {
	CREATION_LABEL,
	computerDestruction,
	computerLease,
	computerProvider as computerProviderTable,
	computer as computerTable,
	project as projectTable,
	workspace as workspaceTable,
} from "../database/schema.ts";
import { Ids } from "../ids/ids.ts";
import type { DeletionRecorded, ProjectDeletionRecorded } from "../proofs/deletion-started.ts";
import type { DoesStoredWork } from "../proofs/does-stored-work.ts";
import { Egress } from "../providers/network/egress.ts";
import { processLayer, Tier } from "../tiers.ts";
import { reachOf } from "./allowed-hosts.ts";
import { type DiskUsage, measureDisk } from "./computer-disk.ts";
import { prepareDiskClearing, SET_ASIDE_DIRECTORY } from "./computer-disk-clearing.ts";
import { ComputerProviderStore } from "./computer-provider-store.ts";
import { ComputerSignIn } from "./computer-sign-in.ts";
import { Computers } from "./computers.ts";
import { pinnedToDigest, withoutTag } from "./image-digest.ts";
import type { ComputerLeaseHolderKind } from "./sql.ts";

/** How long a lease holds a computer awake unless it is renewed. */
const LEASE = Duration.seconds(90);
const INTENT_LIFETIME = Duration.seconds(60);
const INTENT_RENEWAL = Duration.seconds(15);
const INTENT_RETRY = Duration.seconds(1);
/** How often a turn renews its lease, well inside {@link LEASE}. */
export const LEASE_RENEWAL = Duration.seconds(30);
/** How long a computer sits with no turn using it before it is asleep. */
const IDLE_BEFORE_SLEEP = Duration.minutes(5);
/** How long before its credentials expire a computer in use is given new ones. */
const CREDENTIAL_REFRESH_MARGIN = Duration.minutes(10);
/** How often the sweeps look for idle computers to put to sleep, and running ones to measure. */
const SWEEP_INTERVAL = Duration.minutes(1);
/** How long a running computer's disk goes before it is measured again. */
const DISK_MEASUREMENT_INTERVAL = Duration.minutes(2);
/** How many computers' disks are measured at once. */
const DISK_MEASUREMENT_CONCURRENCY = 4;
/** How long what an image's tag names is relied on before its registry is asked again. */
const IMAGE_RECHECK = Duration.minutes(10);
/** How long a registry has to say what an image's tag names. */
const REGISTRY_TIMEOUT = Duration.seconds(5);
/** How long after a computer fails to upgrade on its own before it is tried again. */
const UPGRADE_RETRY = Duration.hours(1);
/**
 * How long making a computer may take before a machine it left at its
 * provider, unrecorded, is looked for there by its label and destroyed.
 */
const CREATION_GRACE = Duration.minutes(15);
/** How long a machine left behind waits before it is destroyed by the sweep, and between tries. */
const LEFT_BEHIND_RETRY = Duration.minutes(5);
/** How many machines left behind one sweep destroys at most. */
const LEFT_BEHIND_BATCH = 20;
/**
 * Clearing a filling disk stops once the work directory's disk is less than
 * this share full, leaving room for the next turn's clones and installs.
 */
const CLEARED_BELOW_SHARE = 0.7;

/**
 * The only writer of `computer` and `computer_lease`: each project's one
 * computer, made the first time one of its bots needs it, then opened, and resumed, on
 * every later use. A turn using it holds a lease, and a computer no turn has
 * held for {@link IDLE_BEFORE_SLEEP} is asleep, so it stops costing compute.
 * A turn waiting for a member's approval has ended its run and holds no
 * lease, so nobody pays for a computer while a member is away.
 */
export interface Interface {
	/**
	 * The project's computer at `provider`, the workspace's enabled one, ready to
	 * run commands, with a lease for `holder` that keeps it awake until
	 * released or expired.
	 */
	readonly open: (
		project: Project,
		provider: ComputerProviderStore.Configured,
		holder: Holder,
	) => Effect.Effect<Opened, Computers.Unavailable>;
	/**
	 * Extends `holder`'s leases, and starts signing their computers in afresh when their
	 * credentials are about to expire. Nothing happens if it has none.
	 */
	readonly renew: (holder: Holder) => Effect.Effect<void, never, Scope.Scope>;
	/** Ends `holder`'s leases, starting the idle time of the computers it held. */
	readonly release: (holder: Holder) => Effect.Effect<void>;
	readonly sleepIfIdle: <P, I>(
		work: DoesStoredWork<P, I, "computerSleep">,
	) => Effect.Effect<void, ClaimLost | Computers.Unavailable>;
	/**
	 * Upgrades every computer nobody has used or watched for
	 * {@link IDLE_BEFORE_SLEEP} whose image is behind what the workspace's
	 * enabled provider makes computers from now, as {@link upgrade} does, and
	 * leaves the new one asleep. Only at a provider that takes images as they
	 * are; a template is left to be rebuilt and upgraded to by hand. Skips for
	 * {@link UPGRADE_RETRY} a computer that failed to upgrade.
	 */
	readonly upgradeIdle: Effect.Effect<void>;
	/**
	 * Measures the disk of every running computer not measured for
	 * {@link DISK_MEASUREMENT_INTERVAL}, without resuming any: a sleeping
	 * computer's disk doesn't change, so its last measurement still holds.
	 */
	readonly measureDisks: Effect.Effect<void>;
	/**
	 * Destroys, at their providers, the machines left behind whose time has
	 * come (see `computer_destruction`): by their ids, or, for a creation that
	 * never recorded one, by the label it was made with. One whose provider
	 * can't be reached now is tried again later.
	 */
	readonly destroyLeftBehind: Effect.Effect<void>;
	/** The last measurement of the project's computer's disk, if it has one. */
	readonly diskOf: (project: Project) => Effect.Effect<MeasuredDisk | undefined>;
	/** The last measurement of the disk of each of the workspace's projects' computers that has one. */
	readonly disksIn: (workspaceId: string) => Effect.Effect<readonly ProjectDisk[]>;
	/**
	 * Destroys every computer `provider` made and forgets them, so the provider
	 * can be removed without leaving machines running at it.
	 */
	readonly destroyAllMadeBy: (
		workspaceId: string,
		provider: ComputerProviderStore.Configured,
	) => Effect.Effect<void, Computers.Unavailable>;
	/**
	 * Keeps the running computers of the workspace's projects, or of one
	 * project, to the hosts each may reach now, signed in as each project is now. A sleeping one
	 * is brought up to date when it is next opened; one that can't be reached
	 * is logged and left for then too.
	 */
	readonly applyNetwork: (where: {
		workspaceId: string;
		projectId?: string;
	}) => Effect.Effect<void>;
	/** Whether `providerId` has made any computer that still exists. */
	readonly anyMadeBy: (workspaceId: string, providerId: string) => Effect.Effect<boolean>;
	/**
	 * How the project's computer stands, asking its provider without resuming it.
	 * `current` is the workspace's enabled provider, which says whether the
	 * computer's image is out of date.
	 */
	readonly status: (
		project: Project,
		current: ComputerProviderStore.Configured | undefined,
	) => Effect.Effect<Status>;
	/** Destroys the project's computer and forgets it; its next use makes a new one. */
	readonly reset: (
		project: Project,
	) => Effect.Effect<void, ClaimLost | ComputerInUse | Computers.Unavailable>;
	/**
	 * Destroys the project's computer at its provider and forgets it, even while a
	 * turn uses it, for a project about to be deleted, or a bot with its default
	 * project: deleting the project deletes the
	 * record, the only way anything finds the machine. When the provider can't
	 * be reached it fails and keeps the record, so the project is kept to try again.
	 */
	readonly destroy: <W, J>(
		recorded: ProjectDeletionRecorded<W, J>,
	) => Effect.Effect<void, ClaimLost | Computers.Unavailable>;
	/**
	 * Does {@link destroy} for every project in the workspace that has a
	 * computer, for a workspace about to be deleted. Stops at the first
	 * provider that can't be reached, keeping that record and those not yet reached.
	 */
	readonly destroyAllIn: <W>(
		recorded: DeletionRecorded<W>,
	) => Effect.Effect<void, ClaimLost | Computers.Unavailable>;
	/**
	 * Moves the project's work to a new computer made by `provider`, the
	 * workspace's enabled one, from its image, then destroys the old computer.
	 * Work the provider keeps apart from the computer carries over whole;
	 * otherwise `/workspace` is copied across, less what `.gitignore` files
	 * leave out. Once started it finishes, even if the caller goes away, as
	 * does {@link reset}.
	 */
	readonly upgrade: (
		project: Project,
		provider: ComputerProviderStore.Configured,
	) => Effect.Effect<
		void,
		ClaimLost | ComputerInUse | NoComputer | UpgradeFailed | Computers.Unavailable
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ProjectComputers",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const computers = yield* Computers.Service;
	const ids = yield* Ids.Service;
	const providers = yield* ComputerProviderStore.Service;
	const signIns = yield* ComputerSignIn.Service;
	const egress = yield* Egress.Service;
	const operation = yield* serviceOperations<Interface>("ProjectComputers");
	// Destruction calls in this process run one at a time per project.
	const changes = new Map<string, Semaphore.Semaphore>();
	const oneAtATime = (projectId: string) => {
		let semaphore = changes.get(projectId);
		if (!semaphore) {
			semaphore = Semaphore.makeUnsafe(1);
			changes.set(projectId, semaphore);
		}
		return semaphore.withPermits(1);
	};

	// When each project's computer must be signed in again, from when it last was by
	// this process. Another process's computers are signed in on first renewal.
	const signInDue = new Map<string, number>();

	// What each image's tag named when its registry was last asked, and until when that is relied on.
	const tagged = new Map<string, { pinned: string | undefined; until: number }>();
	/** `image` pinned to the digest its tag names now, if its registry says. */
	const pinnedNow = (image: string) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const known = tagged.get(image);
			if (known && known.until > now) return known.pinned;
			// Asked on the way to making a turn's computer, so a registry that
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
	 * The provider access with an image its provider takes as it is pinned to the
	 * digest its tag names now, so a new computer gets that image rather than
	 * whatever the provider's host last pulled for the tag.
	 */
	const pinnedAccess = (access: Computers.ProviderAccess) =>
		access.provider === "opensandbox"
			? Effect.map(
					pinnedNow(access.image),
					(pinned): Computers.ProviderAccess => ({ ...access, image: pinned ?? access.image }),
				)
			: Effect.succeed(access);

	/** Whether a computer made from `madeFrom` is behind what `access` makes computers from now. */
	const isBehind = (madeFrom: string, access: Computers.ProviderAccess) =>
		access.provider === "opensandbox"
			? Effect.map(pinnedNow(access.image), (pinned) =>
					imageIsBehind(madeFrom, access.image, pinned),
				)
			: Effect.succeed(madeFrom !== imageOf(access));

	// When a computer that failed to upgrade on its own may be tried again, by its record's id.
	const upgradeRetryAt = new Map<string, number>();

	/**
	 * Sets what the project's computer may reach and what it is signed in with,
	 * as far as its provider can add credentials.
	 */
	const applyNetwork = (project: Project, computer: Computers.Computer, at: Computers.Provider) =>
		Effect.gen(function* () {
			const [reach, signedIn] = yield* Effect.all([
				reachOf(project, at),
				signIns.forProject(project),
			]);
			yield* computer.setNetwork({
				reach,
				credentials: fittedTo(at.capabilities.credentials, signedIn.credentials),
			});
			if (signedIn.expiresAt === undefined) {
				signInDue.delete(project.projectId);
				return;
			}
			const due = DateTime.subtractDuration(signedIn.expiresAt, CREDENTIAL_REFRESH_MARGIN);
			signInDue.set(project.projectId, DateTime.toEpochMillis(due));
		});

	/**
	 * Brings a running computer's network up to date. The intent protects the
	 * running-state check and the provider open from a concurrent sleep.
	 */
	const applyNetworkWhileRunning = (row: ComputerRow) =>
		withComputerIntent(
			sameComputer(row),
			() => isNull(computerTable.sleptAt),
			() =>
				Effect.gen(function* () {
					const configured = yield* providers.access(row.workspaceId, row.computerProviderId);
					if (!configured) return;
					const at = computers.forAccess(configured.access);
					const { computer } = yield* at.open(row.providerComputerId);
					yield* applyNetwork(row, computer, at);
				}).pipe(Effect.uninterruptible),
		).pipe(
			Effect.asVoid,
			Effect.catchTags({
				ClaimLost: (error) => Effect.logWarning("Could not refresh the computer network", error),
				ComputerMissing: () => Effect.void,
				// Its replacement is made with the network allowed then.
				ComputerStopped: () => Effect.void,
				ComputerUnavailable: (failure) =>
					Effect.gen(function* () {
						signInDue.delete(row.projectId);
						yield* Effect.logWarning(
							"Could not bring a computer's network up to date. The next lease renewal or open will retry.",
							failure,
						);
					}),
			}),
		);

	const refreshingSignIn = new Set<string>();
	const refreshSignIn = (row: ComputerRow) =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				if (refreshingSignIn.has(row.id)) return false;
				refreshingSignIn.add(row.id);
				return true;
			}),
			(started) => (started ? applyNetworkWhileRunning(row) : Effect.void),
			(started) =>
				Effect.sync(() => {
					if (started) refreshingSignIn.delete(row.id);
				}),
		).pipe(
			Effect.catchCause((cause) =>
				Effect.logError("Refreshing a computer's sign-in failed", { computerId: row.id, cause }),
			),
		);

	const recorded = (project: Project) =>
		query((db) => db.select().from(computerTable).where(inProject(project)).limit(1)).pipe(
			Effect.map(([row]) => row),
		);

	const lockComputer = (matching: SQL | undefined) =>
		query((db) => db.select().from(computerTable).where(matching).for("update")).pipe(
			Effect.map(([row]) => row),
		);

	/**
	 * withComputerIntent claims a matching row in a short transaction. It
	 * renews the claim while work runs and clears only the claim it owns.
	 */
	const withComputerIntent = <A, E, R>(
		matching: SQL | undefined,
		eligible: (now: DateTime.Utc) => SQL | undefined,
		work: (row: ComputerRow, intentId: string) => Effect.Effect<A, E, R>,
	) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const intentId = yield* ids.random;
				const attempt = transaction(
					Effect.gen(function* () {
						const row = yield* restore(lockComputer(matching));
						if (!row) return undefined;
						const now = yield* DateTime.now;
						if (hasFreshIntent(row, now)) return "busy" as const;
						const [claimed] = yield* query((db) =>
							db
								.update(computerTable)
								.set({ intentId, intentExpiresAt: intentExpiry(now) })
								.where(and(eq(computerTable.id, row.id), eligible(now)))
								.returning(),
						);
						return { row, claimed };
					}),
				);

				let intent = yield* attempt;
				while (intent === "busy") {
					yield* restore(Effect.sleep(INTENT_RETRY));
					intent = yield* attempt;
				}
				if (!intent?.claimed) return { row: intent?.row, value: undefined };
				const { claimed } = intent;
				const ownsIntent = and(
					eq(computerTable.id, claimed.id),
					eq(computerTable.intentId, intentId),
				);
				const renewIntent = Effect.flatMap(DateTime.now, (now) =>
					query((db) =>
						db
							.update(computerTable)
							.set({ intentExpiresAt: intentExpiry(now) })
							.where(and(ownsIntent, gt(computerTable.intentExpiresAt, DateTime.toDateUtc(now))))
							.returning({ id: computerTable.id }),
					).pipe(Effect.map((rows) => rows.length > 0)),
				);
				const clearIntent = query((db) =>
					db.update(computerTable).set(CLEARED_INTENT).where(ownsIntent),
				);

				const monitor = Effect.sleep(INTENT_RENEWAL).pipe(
					Effect.andThen(renewIntent),
					Effect.catchCause((cause) =>
						Effect.logError("Renewing a computer intent failed", cause).pipe(Effect.as(true)),
					),
					Effect.flatMap((renewed) => (renewed ? Effect.void : Effect.fail(new ClaimLost()))),
					Effect.forever,
					Effect.interruptible,
				);
				return yield* Effect.scoped(
					Effect.gen(function* () {
						const worker = yield* Effect.forkScoped(restore(work(claimed, intentId)));
						const renewer = yield* Effect.forkScoped(monitor);
						const value = yield* restore(
							Effect.raceFirst(Fiber.join(worker), Fiber.join(renewer)),
						).pipe(
							// Keep renewing until the worker has finished any uninterruptible provider call.
							Effect.ensuring(Fiber.interrupt(worker)),
						);
						return { row: claimed, value };
					}),
				).pipe(Effect.ensuring(clearIntent));
			}),
		);

	const requireIntent = (row: ComputerRow, intentId: string) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const [claimed] = yield* query((db) =>
				db
					.select({ id: computerTable.id })
					.from(computerTable)
					.where(claimedComputer(row, intentId, now)),
			);
			if (!claimed) return yield* new ClaimLost();
		});

	/**
	 * Deletes `row`'s record, while it still records the same computer: one
	 * another process put in its place meanwhile is kept, recorded.
	 */
	const forget = (row: ComputerRow) =>
		query((db) => db.delete(computerTable).where(sameComputer(row)));

	/**
	 * Destroys `row`'s computer at its provider. One whose provider's settings
	 * can't be read fails, keeping its record: forgetting it would leave the
	 * machine running with nothing to find it.
	 */
	const destroyAtProvider = <E, R>(row: ComputerRow, beforeDestroy: Effect.Effect<void, E, R>) =>
		Effect.gen(function* () {
			const at = yield* reachableProvider(row);
			yield* beforeDestroy;
			yield* at.destroy(row.providerComputerId);
		});

	/** The provider that made `machine`, failing when its settings can't be read. */
	const reachableProvider = (machine: { workspaceId: string; computerProviderId: string }) =>
		Effect.flatMap(
			providers.access(machine.workspaceId, machine.computerProviderId),
			(configured) =>
				configured
					? Effect.succeed(computers.forAccess(configured.access))
					: Effect.fail(
							new Computers.Unavailable({
								provider: "unconfigured",
								reason: userText`The computer provider lacks the settings to reach its computers. Restore its key or address, then try again.`,
								cause: undefined,
							}),
						),
		);

	/**
	 * Writes down a creation about to start at `providerId`, as a machine to
	 * look for once {@link CREATION_GRACE} has passed, which the transaction
	 * recording its computer settles.
	 */
	const expectCreation = (workspaceId: string, providerId: string) =>
		Effect.gen(function* () {
			const creationId = yield* ids.random;
			const now = yield* DateTime.now;
			const written = yield* query((db) =>
				db
					.insert(computerDestruction)
					.values({
						workspaceId,
						computerProviderId: providerId,
						creationId,
						dueAt: DateTime.toDateUtc(DateTime.addDuration(now, CREATION_GRACE)),
					})
					.returning({ id: computerDestruction.id }),
			).pipe(Effect.flatMap(writtenRow("computer_destruction")));
			return { id: written.id, creationId } satisfies Creation;
		});

	/**
	 * Settles `creation` in the transaction recording its computer, so nothing
	 * destroys it. Fails with `ClaimLost` once the sweep has claimed it, which
	 * destroys the computer whatever the recording does.
	 */
	const settled = (creation: Creation) =>
		query((db) =>
			db
				.delete(computerDestruction)
				.where(and(eq(computerDestruction.id, creation.id), eq(computerDestruction.attempts, 0)))
				.returning({ id: computerDestruction.id }),
		).pipe(
			Effect.flatMap((rows) => (rows.length > 0 ? Effect.void : Effect.fail(new ClaimLost()))),
		);

	/**
	 * In the transaction that moves a project from `old` to `creation`'s
	 * computer, `creation`'s record names `old`'s machine instead, to be
	 * destroyed: at once by whoever moved it, or by the sweep if they stop first.
	 */
	const leftBehindBy = (creation: Creation, old: LeftBehind) =>
		Effect.gen(function* () {
			const now = yield* DateTime.now;
			const [kept] = yield* query((db) =>
				db
					.update(computerDestruction)
					.set({
						computerProviderId: old.computerProviderId,
						providerComputerId: old.providerComputerId,
						creationId: null,
						dueAt: DateTime.toDateUtc(DateTime.addDuration(now, LEFT_BEHIND_RETRY)),
					})
					.where(and(eq(computerDestruction.id, creation.id), eq(computerDestruction.attempts, 0)))
					.returning({ id: computerDestruction.id }),
			);
			if (!kept) return yield* new ClaimLost();
		});

	/**
	 * Destroys `machine` at `at` and forgets its `computer_destruction` row. One
	 * that can't be destroyed now is left to the sweep.
	 */
	const destroyedNow = (
		at: Computers.Provider,
		machine: Computers.ComputerId,
		destructionId: string,
	) =>
		at.destroy(machine).pipe(
			Effect.andThen(
				query((db) =>
					db.delete(computerDestruction).where(eq(computerDestruction.id, destructionId)),
				),
			),
			Effect.catchCause((cause) =>
				Effect.logWarning("Could not destroy a computer left behind; the sweep tries again", cause),
			),
		);

	/** Destroys the machines `left` names at `at`, then forgets it, unless someone claimed it since. */
	const destroyLeftBehindAt = (at: Computers.Provider, left: LeftBehindRow) =>
		Effect.gen(function* () {
			const machines = left.providerComputerId
				? [left.providerComputerId]
				: left.creationId
					? yield* at.labelled(CREATION_LABEL, left.creationId)
					: [];
			yield* Effect.forEach(machines, (machine) => at.destroy(machine), { discard: true });
			yield* query((db) =>
				db
					.delete(computerDestruction)
					.where(
						and(
							eq(computerDestruction.id, left.id),
							eq(computerDestruction.attempts, left.attempts),
						),
					),
			);
		});

	/** The machines left behind by `providerId`, or by any of the workspace's providers. */
	const leftBehindIn = (workspaceId: string, providerId?: string) =>
		query((db) =>
			db
				.select()
				.from(computerDestruction)
				.where(
					and(
						eq(computerDestruction.workspaceId, workspaceId),
						providerId === undefined
							? undefined
							: eq(computerDestruction.computerProviderId, providerId),
					),
				),
		);

	/** Claims the machines left behind by `providerId`, or by any of the workspace's providers, for removal. */
	const claimForRemoval = (workspaceId: string, providerId?: string) =>
		Effect.flatMap(DateTime.now, (now) =>
			query((db) =>
				db
					.update(computerDestruction)
					.set(destructionClaim(now))
					.where(
						and(
							eq(computerDestruction.workspaceId, workspaceId),
							providerId === undefined
								? undefined
								: eq(computerDestruction.computerProviderId, providerId),
							// A known machine can be removed immediately. A pending creation needs its
							// grace to become visible, and only its creator or the claim can win.
							or(
								lte(computerDestruction.dueAt, DateTime.toDateUtc(now)),
								and(isNull(computerDestruction.creationId), eq(computerDestruction.attempts, 0)),
							),
						),
					)
					.returning(),
			),
		);

	/** Destroys every machine the workspace's providers, or `providerId`, left behind, stopping at the first that fails. */
	const destroyAllLeftBehind = (workspaceId: string, providerId?: string) =>
		Effect.gen(function* () {
			for (const left of yield* claimForRemoval(workspaceId, providerId)) {
				yield* destroyLeftBehindAt(yield* reachableProvider(left), left);
			}
		});

	const destroyClaimedComputer = (row: ComputerRow, intentId: string) =>
		Effect.gen(function* () {
			yield* destroyAtProvider(row, requireIntent(row, intentId));
			const now = yield* DateTime.nowAsDate;
			const [removed] = yield* query((db) =>
				db
					.delete(computerTable)
					.where(claimedComputer(row, intentId, now))
					.returning({ id: computerTable.id }),
			);
			if (!removed) return yield* new ClaimLost();
		});

	const resetClaimedComputer = (row: ComputerRow, intentId: string) =>
		Effect.andThen(requireIdle(row.id), destroyClaimedComputer(row, intentId)).pipe(
			Effect.uninterruptible,
		);

	const destroyProjectComputer = (project: Project) =>
		withComputerIntent(inProject(project), () => undefined, destroyClaimedComputer).pipe(
			Effect.asVoid,
		);

	/**
	 * Opens `row`'s computer, resuming it if it is asleep, and records it
	 * running, as one step that isn't stopped part-way when whoever asked goes
	 * away: the provider finishes a resume it has started regardless, and a
	 * computer recorded asleep is one the idle sweep never puts to sleep again. It is
	 * recorded as just used so the sweep leaves it running until a lease holds it.
	 */
	const openedAndRecorded = (at: Computers.Provider, row: ComputerRow, intentId: string) =>
		Effect.gen(function* () {
			yield* requireIntent(row, intentId);
			const opened = yield* at.open(row.providerComputerId);
			const now = yield* DateTime.nowAsDate;
			const [recorded] = yield* query((db) =>
				db
					.update(computerTable)
					.set({ sleptAt: null, lastUsedAt: now })
					.where(computerWithIntent(row, intentId))
					.returning({ id: computerTable.id }),
			);
			if (!recorded) return yield* new ClaimLost();
			return opened;
		}).pipe(Effect.uninterruptible);

	/**
	 * What the project's computer is made from. Its work is named by the computer's
	 * record, which a replacement or an upgrade keeps and a reset doesn't, so
	 * a reset starts from empty.
	 */
	const specFor = (project: Project, recordId: string, at: Computers.Provider) =>
		Effect.map(
			reachOf(project, at),
			(reach): Computers.Spec => ({
				labels: {
					"sugabots.workspace": project.workspaceId,
					"sugabots.project": project.projectId,
				},
				reach,
				workName: recordId,
			}),
		);

	/**
	 * Makes a computer through `provider`'s access, from its image pinned to
	 * its digest, and hands it to `record` with what it was made from, as one
	 * step that isn't stopped part-way when whoever asked goes away. The
	 * creation is written down first, and labels the computer, and `record`
	 * settles it in the transaction recording the computer: a machine made by
	 * a process that stopped before recording it is found by the sweep and
	 * destroyed, as is one whose recording fails and can't be destroyed now.
	 */
	const madeAndRecorded = <E, R>(
		project: Project,
		provider: { id: string; access: Computers.ProviderAccess },
		spec: Computers.Spec,
		record: (
			computer: Computers.Computer,
			image: string,
			creation: Creation,
		) => Effect.Effect<unknown, E, R>,
	) =>
		Effect.gen(function* () {
			const pinned = yield* pinnedAccess(provider.access);
			const at = computers.forAccess(pinned);
			const creation = yield* recordWhileOpen(
				project,
				expectCreation(project.workspaceId, provider.id),
			);
			const labelled = {
				...spec,
				labels: { ...spec.labels, [CREATION_LABEL]: creation.creationId },
			};
			const computer = yield* Effect.uninterruptible(
				Effect.tap(at.create(labelled), (computer) =>
					record(computer, imageOf(pinned), creation).pipe(
						Effect.onError(() => destroyedNow(at, computer.id, creation.id)),
					),
				),
			);
			return { computer, creation };
		});

	// A computer created while deletion starts is destroyed by madeAndRecorded
	// when the recording transaction finds the committed intent.
	const requireProjectOpen = (project: Project) =>
		Effect.gen(function* () {
			const [open] = yield* query((db) =>
				db
					.select({ id: projectTable.id })
					.from(workspaceTable)
					.innerJoin(projectTable, eq(projectTable.workspaceId, workspaceTable.id))
					.where(
						and(
							eq(workspaceTable.id, project.workspaceId),
							eq(projectTable.id, project.projectId),
							eq(workspaceTable.deleting, false),
							eq(projectTable.deleting, false),
						),
					),
			);
			if (!open) {
				return yield* new Computers.Unavailable({
					provider: "project",
					reason: userText`This project is being deleted.`,
					cause: undefined,
				});
			}
		});
	// Read again after taking the workspace lock so a project intent that
	// committed while waiting for the lock is visible to the recording.
	const recordWhileOpen = <A, E, R>(project: Project, record: Effect.Effect<A, E, R>) =>
		transaction(
			query((db) =>
				db
					.select({ id: workspaceTable.id })
					.from(workspaceTable)
					.where(eq(workspaceTable.id, project.workspaceId))
					.for("share"),
			).pipe(Effect.andThen(requireProjectOpen(project)), Effect.andThen(record)),
		);

	const made = (project: Project, provider: ComputerProviderStore.Configured) =>
		Effect.gen(function* () {
			const id = yield* ids.next;
			const at = computers.forAccess(provider.access);
			const { computer } = yield* madeAndRecorded(
				project,
				provider,
				yield* specFor(project, id, at),
				(computer, image, creation) =>
					recordWhileOpen(
						project,
						query((db) =>
							db.insert(computerTable).values({
								id,
								workspaceId: project.workspaceId,
								projectId: project.projectId,
								computerProviderId: provider.id,
								providerComputerId: computer.id,
								image,
							}),
						).pipe(Effect.andThen(settled(creation))),
					),
			);
			return computer;
		});

	/**
	 * Forgets the project's computer at a provider the workspace no longer
	 * uses, writing its machine down to be destroyed in the same transaction,
	 * then destroys it. A provider that can't be reached leaves it to the
	 * sweep rather than blocking the project's work at its new provider.
	 */
	const leaveOldProvider = (row: ComputerRow) =>
		Effect.gen(function* () {
			const destruction = yield* transaction(
				Effect.gen(function* () {
					const [forgotten] = yield* query((db) =>
						db.delete(computerTable).where(sameComputer(row)).returning({ id: computerTable.id }),
					);
					if (!forgotten) return undefined;
					const now = yield* DateTime.now;
					return yield* query((db) =>
						db
							.insert(computerDestruction)
							.values({
								workspaceId: row.workspaceId,
								computerProviderId: row.computerProviderId,
								providerComputerId: row.providerComputerId,
								dueAt: DateTime.toDateUtc(DateTime.addDuration(now, LEFT_BEHIND_RETRY)),
							})
							.returning({ id: computerDestruction.id }),
					).pipe(Effect.flatMap(writtenRow("computer_destruction")));
				}),
			);
			if (!destruction) return;
			const old = yield* providers.access(row.workspaceId, row.computerProviderId);
			if (old) {
				yield* destroyedNow(
					computers.forAccess(old.access),
					row.providerComputerId,
					destruction.id,
				);
			}
		});

	const opened = (project: Project, provider: ComputerProviderStore.Configured) =>
		Effect.gen(function* () {
			const at = computers.forAccess(provider.access);
			const replaced = (computer: Computers.Computer): Opened => ({
				computer,
				arrival: "replaced",
			});
			const { row, value: existing } = yield* withComputerIntent(
				inProject(project),
				() => eq(computerTable.computerProviderId, provider.id),
				(row, intentId) =>
					openedAndRecorded(at, row, intentId).pipe(
						Effect.map(
							({ computer, resumed }): Opened => ({
								computer,
								arrival: !resumed
									? "running"
									: at.capabilities.sleepKeeps === "disk"
										? "rebooted"
										: "resumed",
							}),
						),
						Effect.catchTag("ComputerMissing", () =>
							Effect.map(restarted(project, row, provider.access, intentId), replaced),
						),
						Effect.catchTag("ComputerStopped", () =>
							Effect.map(
								restarted(project, row, provider.access, intentId),
								(computer): Opened => ({ computer, arrival: "rebooted" }),
							),
						),
					),
			);
			if (existing) return existing;
			if (!row)
				return { computer: yield* made(project, provider), arrival: "made" } satisfies Opened;
			yield* leaveOldProvider(row);
			return replaced(yield* made(project, provider));
		});

	/**
	 * A new computer in place of one that is gone or stopped for good, made
	 * with its work name, so it carries on with any work kept apart from it.
	 */
	const restarted = (
		project: Project,
		row: ComputerRow,
		access: Computers.ProviderAccess,
		intentId: string,
	) =>
		Effect.gen(function* () {
			const at = computers.forAccess(access);
			const spec = yield* specFor(project, row.id, at);
			yield* requireIntent(row, intentId);
			const { computer: fresh, creation } = yield* madeAndRecorded(
				project,
				{ id: row.computerProviderId, access },
				spec,
				(computer, image, creation) =>
					moveRecord(row, intentId, row.computerProviderId, computer.id, image, creation),
			);
			yield* destroyedNow(at, row.providerComputerId, creation.id);
			return fresh;
		}).pipe(Effect.uninterruptible);

	/**
	 * Points the project's record, `row`, at its new computer, made from
	 * `image`, which is running and unused, and writes the old one down to be
	 * destroyed in the same transaction. Losing the claim interrupts the write so
	 * `madeAndRecorded` destroys the unrecorded replacement.
	 */
	const moveRecord = (
		row: ComputerRow,
		intentId: string,
		providerId: string,
		computerId: Computers.ComputerId,
		image: string,
		creation: Creation,
	) =>
		recordWhileOpen(
			row,
			Effect.gen(function* () {
				yield* leftBehindBy(creation, row);
				const now = yield* DateTime.nowAsDate;
				const [moved] = yield* query((db) =>
					db
						.update(computerTable)
						.set({
							computerProviderId: providerId,
							providerComputerId: computerId,
							image,
							sleptAt: null,
							lastUsedAt: now,
							diskUsage: null,
							diskMeasuredAt: null,
						})
						.where(claimedComputer(row, intentId, now))
						.returning({ id: computerTable.id }),
				);
				if (!moved) return yield* new ClaimLost();
			}),
		);

	const lease = (project: Project, holder: Holder, providerComputerId: Computers.ComputerId) =>
		Effect.gen(function* () {
			const attempt = recordWhileOpen(
				project,
				Effect.gen(function* () {
					const row = yield* lockComputer(inProject(project));
					if (!row || row.providerComputerId !== providerComputerId || row.sleptAt) return false;
					const now = yield* DateTime.now;
					if (hasFreshIntent(row, now)) return "busy" as const;
					const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, LEASE));
					yield* query((db) =>
						db
							.insert(computerLease)
							.values({
								computerId: row.id,
								providerComputerId,
								holderKind: holder.kind,
								holderId: holder.id,
								expiresAt,
							})
							.onConflictDoUpdate({
								target: [
									computerLease.computerId,
									computerLease.holderKind,
									computerLease.holderId,
								],
								set: { providerComputerId, expiresAt },
							}),
					);
					return true;
				}),
			);
			let leased = yield* attempt;
			while (leased === "busy") {
				yield* Effect.sleep(INTENT_RETRY);
				leased = yield* attempt;
			}
			return leased;
		});

	/** Records `usage` as the computer's disk now, unless the project has moved to another computer since. */
	const recordMeasurement = (row: ComputerRow, usage: DiskUsage, intentId?: string) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db
					.update(computerTable)
					.set({ diskUsage: usage, diskMeasuredAt: now })
					.where(
						and(sameComputer(row), intentId ? eq(computerTable.intentId, intentId) : undefined),
					),
			);
		});

	/**
	 * clearDiskIfFilling finishes deletion and invalidates stale disk usage
	 * before releasing the sleep intent. Opening, listing and re-measuring
	 * can be interrupted.
	 */
	const clearDiskIfFilling = (row: ComputerRow, at: Computers.Provider, intentId: string) =>
		Effect.gen(function* () {
			if (!row.diskUsage || computerDiskShare(row.diskUsage) < COMPUTER_DISK_WARNING_SHARE) return;
			const { computer } = yield* at.open(row.providerComputerId);
			const clear = yield* prepareDiskClearing(computer, row.workspaceId, CLEARED_BELOW_SHARE);
			yield* requireIntent(row, intentId);
			const { cleared, stoppedAtTimeout } = yield* clear.pipe(
				Effect.onExit((exit) => {
					if (
						Exit.isSuccess(exit) &&
						exit.value.cleared.length === 0 &&
						!exit.value.stoppedAtTimeout
					) {
						return Effect.void;
					}
					return Effect.flatMap(DateTime.nowAsDate, (now) =>
						query((db) =>
							db
								.update(computerTable)
								.set({ diskUsage: null, diskMeasuredAt: null })
								.where(claimedComputer(row, intentId, now)),
						),
					);
				}),
				Effect.uninterruptible,
			);
			if (cleared.length === 0 && !stoppedAtTimeout) return;
			const clearedByReason = Object.fromEntries(
				Array.from(
					Map.groupBy(cleared, ({ reason }) => reason),
					([reason, folders]) => [reason, folders.length],
				),
			);
			yield* Effect.logInfo("Cleared folders to free a computer's disk", {
				cleared: clearedByReason,
				stoppedAtTimeout,
			});
			yield* recordMeasurement(row, yield* measureDisk(computer), intentId);
		}).pipe(
			Effect.catchTags({
				// Putting it to sleep finds the same, and deals with it.
				ComputerMissing: () => Effect.void,
				ComputerStopped: () => Effect.void,
				ComputerUnavailable: (failure) =>
					Effect.logWarning(
						"Could not clear a computer's disk; trying again when next idle",
						failure,
					),
				DiskUnmeasurable: (failure) =>
					Effect.logWarning("A computer's disk could not be measured after clearing it", {
						exitCode: failure.exitCode,
						stderr: failure.stderr,
					}),
			}),
			Effect.catchDefect((defect) => Effect.logError("Clearing a computer's disk failed", defect)),
			Effect.annotateLogs({ computerId: row.id }),
		);

	/**
	 * Puts one idle computer to sleep, unless a turn took it since it was found idle,
	 * clearing space on its disk first if it is filling.
	 */
	const sleepIfStillIdle = (row: ComputerRow) =>
		withComputerIntent(sameComputer(row), idleAt, (current, intentId) =>
			Effect.gen(function* () {
				const configured = yield* providers.access(current.workspaceId, current.computerProviderId);
				if (!configured) return;
				const at = computers.forAccess(configured.access);
				yield* clearDiskIfFilling(current, at, intentId);
				const claimed = computerWithIntent(current, intentId);
				const now = yield* DateTime.nowAsDate;
				const [stillClaimed] = yield* query((db) =>
					db
						.select({ id: computerTable.id })
						.from(computerTable)
						.where(and(claimed, gt(computerTable.intentExpiresAt, now))),
				);
				if (!stillClaimed) return yield* new ClaimLost();
				yield* at.sleep(current.providerComputerId).pipe(
					Effect.andThen(
						Effect.flatMap(DateTime.nowAsDate, (sleptAt) =>
							query((db) =>
								db
									.update(computerTable)
									.set({ sleptAt, ...CLEARED_INTENT })
									.where(claimed),
							),
						),
					),
					Effect.catchTag("ComputerMissing", () =>
						query((db) => db.delete(computerTable).where(claimed)),
					),
					Effect.uninterruptible,
				);
			}),
		).pipe(Effect.asVoid);

	/**
	 * Measures one computer's disk if it is running. An intent protects the
	 * running-state check and open from a concurrent sleep. The measurement
	 * may fail if the computer sleeps after the intent is cleared.
	 */
	const measureDiskIfRunning = (row: ComputerRow) =>
		Effect.gen(function* () {
			const configured = yield* providers.access(row.workspaceId, row.computerProviderId);
			if (!configured) return;
			const at = computers.forAccess(configured.access);
			const { value: running } = yield* withComputerIntent(
				sameComputer(row),
				() => isNull(computerTable.sleptAt),
				() =>
					Effect.gen(function* () {
						const { state } = yield* at.info(row.providerComputerId);
						if (state !== "running") return undefined;
						return (yield* at.open(row.providerComputerId)).computer;
					}).pipe(Effect.uninterruptible),
			);
			if (!running) return;
			yield* recordMeasurement(row, yield* measureDisk(running));
		}).pipe(
			Effect.catchTags({
				ComputerMissing: () => Effect.void,
				ComputerStopped: () => Effect.void,
				ComputerUnavailable: (failure) =>
					Effect.logWarning("Could not measure a computer's disk; trying again later", failure),
				DiskUnmeasurable: (failure) =>
					Effect.logWarning("A computer's disk could not be measured", {
						exitCode: failure.exitCode,
						stderr: failure.stderr,
					}),
			}),
		);

	const madeBy = (workspaceId: string, providerId: string) =>
		query((db) =>
			db
				.select()
				.from(computerTable)
				.where(
					and(
						eq(computerTable.workspaceId, workspaceId),
						eq(computerTable.computerProviderId, providerId),
					),
				),
		);

	/** Who holds a live lease on the computer: turns, and members watching a desktop. */
	const holders = (computerId: string) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const leases = yield* query((db) =>
				db
					.select({ holderKind: computerLease.holderKind })
					.from(computerLease)
					.innerJoin(computerTable, leaseMatchesComputer())
					.where(and(eq(computerLease.computerId, computerId), gt(computerLease.expiresAt, now))),
			);
			const turns = leases.filter(({ holderKind }) => holderKind === "turn").length;
			return { turns, watching: leases.length - turns };
		});

	/** Fails while a turn is using the computer, which a reset or upgrade would pull out from under it. */
	const requireIdle = (computerId: string) =>
		Effect.flatMap(holders(computerId), ({ turns }) =>
			turns > 0 ? Effect.fail(new ComputerInUse()) : Effect.void,
		);

	/**
	 * Moves the work of the project's computer, `row`, to a new one `provider`
	 * makes, as {@link Interface.upgrade} describes, and destroys the old one.
	 * The caller holds an intent and has checked nobody is using it.
	 */
	const movedToNewComputer = (
		row: ComputerRow,
		provider: ComputerProviderStore.Configured,
		intentId: string,
	) =>
		Effect.gen(function* () {
			const configured = yield* providers.access(row.workspaceId, row.computerProviderId);
			if (!configured) {
				return yield* new UpgradeFailed({
					reason: userText`The computer's provider has lost its settings, so its work can't be copied. Reset it instead.`,
				});
			}
			const from = computers.forAccess(configured.access);
			const to = computers.forAccess(provider.access);
			const destroyOld = (creation: Creation) =>
				destroyedNow(from, row.providerComputerId, creation.id);
			yield* requireIntent(row, intentId);
			const { workKeptApart } = yield* from
				.info(row.providerComputerId)
				.pipe(Effect.catchTag("ComputerMissing", () => Effect.fail(new NoComputer())));
			if (workKeptApart && provider.id === row.computerProviderId) {
				const spec = yield* specFor(row, row.id, to);
				yield* requireIntent(row, intentId);
				const { computer: fresh, creation } = yield* madeAndRecorded(
					row,
					provider,
					spec,
					(computer, image, creation) =>
						moveRecord(row, intentId, provider.id, computer.id, image, creation),
				);
				yield* destroyOld(creation);
				return fresh;
			}
			const old = yield* openedAndRecorded(from, row, intentId).pipe(
				Effect.map(({ computer }) => computer),
				Effect.catchTags({
					ComputerMissing: () => Effect.fail(new NoComputer()),
					ComputerStopped: () =>
						Effect.fail(
							new UpgradeFailed({
								reason: userText`The computer has stopped, so its work can't be copied to another provider. Have a bot use it once to start it again, then upgrade.`,
							}),
						),
				}),
			);
			const archivePath = `/tmp/sugabots-work-${yield* ids.random}.tgz`;
			const packed = yield* old.exec(
				`cd ${Computers.WORK_DIRECTORY} && tar --exclude-vcs-ignores --exclude=./${posix.basename(SET_ASIDE_DIRECTORY)} -czf ${archivePath} .`,
				COPY_STEP,
			);
			if (packed.exitCode !== 0) {
				return yield* new UpgradeFailed({
					reason: userText`The computer's work couldn't be packed up to copy.`,
				});
			}
			const archive = yield* old.downloadFile(archivePath).pipe(
				Effect.catchTag("ComputerFileFailed", () =>
					Effect.fail(
						new UpgradeFailed({
							reason: userText`The computer's work couldn't be read to copy.`,
						}),
					),
				),
			);
			const spec = yield* specFor(row, row.id, to);
			yield* requireIntent(row, intentId);
			const { computer: fresh, creation } = yield* madeAndRecorded(
				row,
				provider,
				spec,
				(computer, image, creation) =>
					computer.uploadFile(archivePath, archive).pipe(
						Effect.andThen(
							computer.exec(
								`tar -xzf ${archivePath} -C ${Computers.WORK_DIRECTORY} && rm ${archivePath}`,
								COPY_STEP,
							),
						),
						Effect.map((execution) => execution.exitCode === 0),
						Effect.catchTag("ComputerFileFailed", () => Effect.succeed(false)),
						Effect.flatMap((unpacked) =>
							Effect.gen(function* () {
								if (!unpacked) {
									return yield* new UpgradeFailed({
										reason: userText`The work couldn't be unpacked in the new computer. The old one is untouched.`,
									});
								}
								yield* moveRecord(row, intentId, provider.id, computer.id, image, creation);
							}),
						),
					),
			);
			yield* destroyOld(creation);
			return fresh;
		});

	/**
	 * Upgrades the workspace's idle computers, found as
	 * {@link Interface.upgradeIdle} describes, that are behind its enabled
	 * provider.
	 */
	const upgradeBehindIn = (
		workspaceId: string,
		idle: readonly ComputerRow[],
		idleSince: Date,
		now: Date,
	) =>
		Effect.gen(function* () {
			const provider = yield* providers.enabled(workspaceId);
			if (!provider) return;
			const at = computers.forAccess(provider.access);
			if (at.templates) return;
			for (const row of idle) {
				// One at a provider no longer enabled moves when next opened.
				if (row.computerProviderId !== provider.id) continue;
				if ((upgradeRetryAt.get(row.id) ?? 0) > now.getTime()) continue;
				if (!(yield* isBehind(row.image, provider.access))) continue;
				yield* upgradeIfStillIdle(row, provider, at, idleSince, now).pipe(
					Effect.catchCause((cause) => Effect.logError("Upgrading an idle computer failed", cause)),
					Effect.annotateLogs({ computerId: row.id }),
				);
			}
		});

	/** Upgrades one idle computer, unless someone took it since it was found. */
	const upgradeIfStillIdle = (
		row: ComputerRow,
		provider: ComputerProviderStore.Configured,
		at: Computers.Provider,
		idleSince: Date,
		now: Date,
	) =>
		withComputerIntent(
			sameComputer(row),
			(current) =>
				and(lt(computerTable.lastUsedAt, idleSince), noLiveLease(DateTime.toDateUtc(current))),
			(current, intentId) =>
				Effect.gen(function* () {
					const fresh = yield* movedToNewComputer(current, provider, intentId);
					yield* sleepUnused({ ...current, providerComputerId: fresh.id }, intentId, at);
				}).pipe(Effect.uninterruptible),
		).pipe(
			Effect.asVoid,
			Effect.catchTags({
				// Gone at the provider: the next use makes a new one.
				NoComputer: () => Effect.void,
				UpgradeFailed: (failure) => retryUpgradeLater(row.id, now, failure),
				ComputerUnavailable: (failure) => retryUpgradeLater(row.id, now, failure),
			}),
		);

	/**
	 * Gives the project's record back the time `row` was last used, since nobody
	 * has used the computer it was upgraded to, then puts that computer to sleep. One
	 * that can't be put to sleep now is put to sleep by the idle sweep, as idle as before.
	 */
	const sleepUnused = (row: ComputerRow, intentId: string, at: Computers.Provider) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const [claimed] = yield* query((db) =>
				db
					.update(computerTable)
					.set({ lastUsedAt: row.lastUsedAt })
					.where(claimedComputer(row, intentId, now))
					.returning({ id: computerTable.id }),
			);
			if (!claimed) return yield* new ClaimLost();
			yield* at.sleep(row.providerComputerId);
			const sleptAt = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db.update(computerTable).set({ sleptAt }).where(computerWithIntent(row, intentId)),
			);
		}).pipe(
			Effect.catchTags({
				ComputerMissing: () => Effect.void,
				ComputerUnavailable: (failure) =>
					Effect.logWarning(
						"Could not put an upgraded computer to sleep; it sleeps once idle",
						failure,
					),
			}),
		);

	const retryUpgradeLater = (recordId: string, now: Date, failure: unknown) =>
		Effect.andThen(
			Effect.sync(() =>
				upgradeRetryAt.set(recordId, now.getTime() + Duration.toMillis(UPGRADE_RETRY)),
			),
			Effect.logWarning("Could not upgrade an idle computer; trying again later", failure),
		);

	return Service.of({
		open: (project, provider, holder) =>
			operation(
				"open",
				Effect.gen(function* () {
					while (true) {
						const result = yield* requireProjectOpen(project).pipe(
							Effect.andThen(opened(project, provider)),
							Effect.catchTag("ClaimLost", () => Effect.succeed(undefined)),
							Effect.catchCause((cause) =>
								violatedUniqueConstraint(cause) === "computer_project_id_idx"
									? Effect.succeed(undefined)
									: Effect.failCause(cause),
							),
						);
						if (!result) continue;
						if (!(yield* lease(project, holder, result.computer.id))) continue;
						yield* applyNetwork(project, result.computer, computers.forAccess(provider.access));
						return result;
					}
				}),
			),

		renew: (holder) =>
			operation(
				"renew",
				Effect.gen(function* () {
					const { now, rows } = yield* transaction(
						Effect.gen(function* () {
							const rows = yield* query((db) =>
								db
									.select({ computer: computerTable, expiresAt: computerLease.expiresAt })
									.from(computerTable)
									.innerJoin(computerLease, leaseMatchesComputer())
									.where(heldBy(holder))
									.orderBy(computerTable.id)
									.for("update", { of: computerTable }),
							);
							const now = yield* DateTime.now;
							const renewable = rows.filter(
								({ computer, expiresAt }) =>
									expiresAt > DateTime.toDateUtc(now) ||
									(computer.sleptAt === null && !hasFreshIntent(computer, now)),
							);
							if (renewable.length === 0) return { now, rows: [] };
							const renewed = yield* query((db) =>
								db
									.update(computerLease)
									.set({ expiresAt: DateTime.toDateUtc(DateTime.addDuration(now, LEASE)) })
									.where(
										and(
											heldBy(holder),
											inArray(
												computerLease.computerId,
												renewable.map(({ computer }) => computer.id),
											),
										),
									)
									.returning({ computerId: computerLease.computerId }),
							);
							const renewedIds = new Set(renewed.map(({ computerId }) => computerId));
							return {
								now,
								rows: renewable.flatMap(({ computer }) =>
									renewedIds.has(computer.id) ? [computer] : [],
								),
							};
						}),
					);
					const nowMillis = DateTime.toEpochMillis(now);
					for (const row of rows) {
						const due = signInDue.get(row.projectId);
						if (due !== undefined && due > nowMillis) continue;
						yield* Effect.forkScoped(refreshSignIn(row));
					}
				}),
			),

		release: (holder) =>
			operation(
				"release",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					const released = yield* query((db) =>
						db.delete(computerLease).where(heldBy(holder)).returning({
							computerId: computerLease.computerId,
							providerComputerId: computerLease.providerComputerId,
						}),
					);
					for (const { computerId, providerComputerId } of released) {
						yield* query((db) =>
							db
								.update(computerTable)
								.set({ lastUsedAt: now })
								.where(
									and(
										eq(computerTable.id, computerId),
										eq(computerTable.providerComputerId, providerComputerId),
									),
								),
						);
					}
				}),
			),

		sleepIfIdle: (proof) =>
			operation(
				"sleepIfIdle",
				Effect.gen(function* () {
					const now = yield* DateTime.now;
					const [row] = yield* query((db) =>
						db
							.select()
							.from(computerTable)
							.where(
								and(
									eq(computerTable.id, proof.id.value),
									eq(computerTable.workspaceId, proof.workspace),
									eq(computerTable.projectId, proof.work.project),
									idleAt(now),
								),
							),
					);
					if (row) yield* sleepIfStillIdle(row);
				}),
			),

		measureDisks: operation(
			"measureDisks",
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const measuredBefore = DateTime.toDateUtc(
					DateTime.subtractDuration(now, DISK_MEASUREMENT_INTERVAL),
				);
				// A computer nobody has used since its last measurement isn't measured
				// again. Its disk barely changes, and opening one can postpone the
				// provider's own sleep, the backstop for when ours fails.
				const usedSinceMeasured = or(
					liveLease(DateTime.toDateUtc(now)),
					gt(computerTable.lastUsedAt, computerTable.diskMeasuredAt),
				);
				const due = yield* query((db) =>
					db
						.select()
						.from(computerTable)
						.where(
							and(
								isNull(computerTable.sleptAt),
								or(
									isNull(computerTable.diskMeasuredAt),
									and(lt(computerTable.diskMeasuredAt, measuredBefore), usedSinceMeasured),
								),
							),
						),
				);
				// One computer that can't be measured, such as one whose provider's
				// key no longer decrypts, mustn't stop the others being measured.
				const measureOnItsOwn = (row: ComputerRow) =>
					measureDiskIfRunning(row).pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Measuring a computer's disk failed", cause),
						),
						Effect.annotateLogs({ computerId: row.id }),
					);
				yield* Effect.forEach(due, measureOnItsOwn, {
					concurrency: DISK_MEASUREMENT_CONCURRENCY,
					discard: true,
				});
			}),
		),

		diskOf: (project) =>
			operation(
				"diskOf",
				Effect.map(
					query((db) =>
						db
							.select(MEASUREMENT_COLUMNS)
							.from(computerTable)
							.where(
								and(
									eq(computerTable.workspaceId, project.workspaceId),
									eq(computerTable.projectId, project.projectId),
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
							.select({ projectId: computerTable.projectId, ...MEASUREMENT_COLUMNS })
							.from(computerTable)
							.where(eq(computerTable.workspaceId, workspaceId)),
					),
					(rows) =>
						rows.flatMap((row) => {
							const disk = measuredDiskOf(row);
							return disk ? [{ projectId: row.projectId, disk }] : [];
						}),
				),
			),

		destroyAllMadeBy: (workspaceId, provider) =>
			operation(
				"destroyAllMadeBy",
				Effect.gen(function* () {
					const at = computers.forAccess(provider.access);
					for (const row of yield* madeBy(workspaceId, provider.id)) {
						yield* oneAtATime(row.projectId)(
							at.destroy(row.providerComputerId).pipe(Effect.andThen(forget(row))),
						);
					}
					for (const left of yield* claimForRemoval(workspaceId, provider.id)) {
						yield* destroyLeftBehindAt(at, left);
					}
				}),
			),

		applyNetwork: ({ workspaceId, projectId }) =>
			operation(
				"applyNetwork",
				Effect.gen(function* () {
					const running = yield* query((db) =>
						db
							.select()
							.from(computerTable)
							.where(
								and(
									eq(computerTable.workspaceId, workspaceId),
									projectId === undefined ? undefined : eq(computerTable.projectId, projectId),
									isNull(computerTable.sleptAt),
								),
							),
					);
					for (const row of running) yield* applyNetworkWhileRunning(row);
				}),
			),

		anyMadeBy: (workspaceId, providerId) =>
			operation(
				"anyMadeBy",
				Effect.map(
					Effect.all([madeBy(workspaceId, providerId), leftBehindIn(workspaceId, providerId)]),
					([made, left]) => made.length + left.length > 0,
				),
			),

		status: (project, current) =>
			operation(
				"status",
				Effect.gen(function* (): Effect.fn.Return<Status, never, Database> {
					const row = yield* recorded(project);
					if (!row) return { kind: "none" };
					const using = yield* holders(row.id);
					const present = {
						kind: "present" as const,
						providerId: row.computerProviderId,
						createdAt: row.createdAt,
						lastUsedAt: row.lastUsedAt,
						turnsUsing: using.turns,
						membersWatching: using.watching,
						disk: measuredDiskOf(row),
					};
					const configured = yield* providers.access(row.workspaceId, row.computerProviderId);
					if (!configured) return { ...present, state: "unreachable", upgradeAvailable: false };
					return yield* computers
						.forAccess(configured.access)
						.info(row.providerComputerId)
						.pipe(
							Effect.flatMap((info) =>
								Effect.map(
									current === undefined || current.id !== row.computerProviderId
										? Effect.succeed(current !== undefined)
										: isBehind(row.image, current.access),
									(upgradeAvailable): Status => ({
										...present,
										state: info.state,
										image: row.image,
										upgradeAvailable,
									}),
								),
							),
							Effect.catchTags({
								ComputerMissing: () =>
									Effect.succeed<Status>({ ...present, state: "lost", upgradeAvailable: false }),
								ComputerUnavailable: () =>
									Effect.succeed<Status>({
										...present,
										state: "unreachable",
										upgradeAvailable: false,
									}),
							}),
						);
				}),
			),

		reset: (project) =>
			operation(
				"reset",
				withComputerIntent(inProject(project), () => undefined, resetClaimedComputer).pipe(
					Effect.asVoid,
				),
			),

		destroy: (recorded) =>
			operation(
				"destroy",
				destroyProjectComputer({
					workspaceId: recorded.workspace.value,
					projectId: recorded.project.value,
				}),
			),

		destroyAllIn: (recorded) =>
			operation(
				"destroyAllIn",
				Effect.gen(function* () {
					const workspaceId = recorded.workspace.value;
					const rows = yield* query((db) =>
						db
							.select({ projectId: computerTable.projectId })
							.from(computerTable)
							.where(eq(computerTable.workspaceId, workspaceId)),
					);
					for (const { projectId } of rows) {
						yield* destroyProjectComputer({ workspaceId, projectId });
					}
					yield* destroyAllLeftBehind(workspaceId);
				}),
			),

		upgrade: (project, provider) =>
			operation(
				"upgrade",
				withComputerIntent(
					inProject(project),
					() => undefined,
					(row, intentId) =>
						Effect.andThen(requireIdle(row.id), movedToNewComputer(row, provider, intentId)).pipe(
							Effect.uninterruptible,
						),
				).pipe(Effect.flatMap(({ row }) => (row ? Effect.void : Effect.fail(new NoComputer())))),
			),

		destroyLeftBehind: operation(
			"destroyLeftBehind",
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const due = DateTime.toDateUtc(now);
				// Claimed by moving each on, so another process's sweep skips it, and
				// one that fails waits its turn again.
				const claimed = yield* query((db) =>
					db
						.update(computerDestruction)
						.set(destructionClaim(now))
						.where(
							inArray(
								computerDestruction.id,
								db
									.select({ id: computerDestruction.id })
									.from(computerDestruction)
									.where(lte(computerDestruction.dueAt, due))
									.orderBy(computerDestruction.dueAt, computerDestruction.id)
									.limit(LEFT_BEHIND_BATCH)
									.for("update", { skipLocked: true }),
							),
						)
						.returning(),
				);
				for (const left of claimed) {
					yield* reachableProvider(left).pipe(
						Effect.flatMap((at) => destroyLeftBehindAt(at, left)),
						Effect.catchCause((cause) =>
							Effect.logWarning(
								"Could not destroy a computer left behind; trying again later",
								cause,
							),
						),
						Effect.annotateLogs({ computerDestructionId: left.id }),
					);
				}
			}),
		),

		upgradeIdle: operation(
			"upgradeIdle",
			Effect.gen(function* () {
				const now = yield* DateTime.now;
				const idleSince = DateTime.toDateUtc(DateTime.subtractDuration(now, IDLE_BEFORE_SLEEP));
				const idle = yield* query((db) =>
					db
						.select()
						.from(computerTable)
						.where(
							and(lt(computerTable.lastUsedAt, idleSince), noLiveLease(DateTime.toDateUtc(now))),
						),
				);
				// A workspace whose provider can't be read, such as one whose key no
				// longer decrypts, is logged once, and the others still upgrade.
				for (const [workspaceId, rows] of Map.groupBy(idle, (row) => row.workspaceId)) {
					yield* upgradeBehindIn(workspaceId, rows, idleSince, DateTime.toDateUtc(now)).pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Upgrading a workspace's idle computers failed", cause),
						),
						Effect.annotateLogs({ workspaceId }),
					);
				}
			}),
		),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([Computers.layer, ComputerProviderStore.layer]),
);

/**
 * Runs `measureDisks`, `upgradeIdle` and `destroyLeftBehind` every minute on separate fibers.
 */
export const sweepLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const projectComputers = yield* Service;
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
		yield* repeatedly(projectComputers.measureDisks, "Measuring computers' disks failed");
		yield* repeatedly(projectComputers.upgradeIdle, "Upgrading idle computers failed");
		yield* repeatedly(
			projectComputers.destroyLeftBehind,
			"Destroying computers left behind failed",
		);
	}),
).pipe(processLayer, Layer.provide(layer));

/** The columns that record a computer's last disk measurement. */
const MEASUREMENT_COLUMNS = {
	diskUsage: computerTable.diskUsage,
	diskMeasuredAt: computerTable.diskMeasuredAt,
};

/** The row's last disk measurement; the columns are null together until there is one. */
function measuredDiskOf(
	row: Pick<ComputerRow, "diskUsage" | "diskMeasuredAt">,
): MeasuredDisk | undefined {
	if (!row.diskUsage || !row.diskMeasuredAt) return undefined;
	return { ...row.diskUsage, measuredAt: row.diskMeasuredAt };
}

/**
 * The row, while it still records the same computer: the one its provider
 * knows by that id. Another process replacing the computer changes them.
 */
function sameComputer(row: Pick<ComputerRow, "id" | "computerProviderId" | "providerComputerId">) {
	return and(
		eq(computerTable.id, row.id),
		eq(computerTable.computerProviderId, row.computerProviderId),
		eq(computerTable.providerComputerId, row.providerComputerId),
	);
}

const computerWithIntent = (row: ComputerRow, intentId: string) =>
	and(sameComputer(row), eq(computerTable.intentId, intentId));

const claimedComputer = (row: ComputerRow, intentId: string, now: Date) =>
	and(computerWithIntent(row, intentId), gt(computerTable.intentExpiresAt, now));

const inProject = (project: Project) =>
	and(
		eq(computerTable.projectId, project.projectId),
		eq(computerTable.workspaceId, project.workspaceId),
	);

const CLEARED_INTENT = { intentId: null, intentExpiresAt: null };

const intentExpiry = (now: DateTime.Utc) =>
	DateTime.toDateUtc(DateTime.addDuration(now, INTENT_LIFETIME));

const hasFreshIntent = (row: ComputerRow, now: DateTime.Utc) =>
	row.intentExpiresAt !== null && row.intentExpiresAt > DateTime.toDateUtc(now);

const idleAt = (now: DateTime.Utc) =>
	and(
		isNull(computerTable.sleptAt),
		lt(
			computerTable.lastUsedAt,
			DateTime.toDateUtc(DateTime.subtractDuration(now, IDLE_BEFORE_SLEEP)),
		),
		noLiveLease(DateTime.toDateUtc(now)),
	);

export const idleComputerIds = (now: DateTime.Utc) =>
	query((db) => db.select({ id: computerTable.id }).from(computerTable).where(idleAt(now)));

const leaseMatchesComputer = () =>
	and(
		eq(computerLease.computerId, computerTable.id),
		eq(computerLease.providerComputerId, computerTable.providerComputerId),
	);

/** A lease on the computer that is still in force at `now`. */
function liveLease(now: Date) {
	return sql`exists (select 1 from ${computerLease} where ${leaseMatchesComputer()} and ${computerLease.expiresAt} > ${now})`;
}

/** No lease on the computer that is still in force at `now`. */
function noLiveLease(now: Date) {
	return sql`not ${liveLease(now)}`;
}

/**
 * Whether a computer made from `madeFrom` is behind `configured`, whose tag
 * names `pinned` now if its registry said. When the registry didn't say, only
 * a computer made from another image altogether is known to be behind: one
 * pinned from `configured` may still be what its tag names.
 */
function imageIsBehind(madeFrom: string, configured: string, pinned: string | undefined) {
	if (pinned !== undefined) return madeFrom !== pinned;
	return madeFrom !== configured && !madeFrom.startsWith(`${withoutTag(configured)}@`);
}

type ComputerRow = typeof computerTable.$inferSelect;

type LeftBehindRow = typeof computerDestruction.$inferSelect;

const destructionClaim = (now: DateTime.Utc) => ({
	attempts: sql`${computerDestruction.attempts} + 1`,
	dueAt: DateTime.toDateUtc(DateTime.addDuration(now, LEFT_BEHIND_RETRY)),
});

/** A machine given up at its provider. */
type LeftBehind = Pick<ComputerRow, "computerProviderId" | "providerComputerId">;

/** A creation written down before it starts: its `computer_destruction` row, and the label value it makes. */
interface Creation {
	readonly id: string;
	readonly creationId: string;
}

/** What holds a lease: a turn using the computer, or a member viewing its desktop. */
export interface Holder {
	readonly kind: ComputerLeaseHolderKind;
	readonly id: string;
}

function heldBy(holder: Holder) {
	return and(eq(computerLease.holderKind, holder.kind), eq(computerLease.holderId, holder.id));
}

export interface Project {
	readonly workspaceId: string;
	readonly projectId: string;
}

export interface Opened {
	readonly computer: Computers.Computer;
	/**
	 * How the computer came to be ready, which decides what the bot is told:
	 * - `made`: new, with nothing in it.
	 * - `running`: as the bot left it.
	 * - `resumed`: asleep, and back with its programs still running.
	 * - `rebooted`: asleep or stopped, and back with its files but no running
	 *   programs.
	 * - `replaced`: new, because the project's earlier one is gone with its work:
	 *   its provider lost it, it stopped with its work on its own disk, or the
	 *   workspace changed provider.
	 */
	readonly arrival: "made" | "running" | "resumed" | "rebooted" | "replaced";
}

type Status =
	| { readonly kind: "none" }
	| {
			readonly kind: "present";
			/**
			 * `lost`: the provider no longer has it. `unreachable`: its provider
			 * didn't answer, or has lost its settings.
			 */
			readonly state: "running" | "asleep" | "lost" | "unreachable";
			/** What it was made from, as Sugabots asked for it; only when the provider answered. */
			readonly image?: string;
			readonly providerId: string;
			readonly createdAt: Date;
			readonly lastUsedAt: Date;
			readonly turnsUsing: number;
			readonly membersWatching: number;
			/** Whether the enabled provider would make it from another image, or is another provider. */
			readonly upgradeAvailable: boolean;
			/** Its last measurement, if it has been measured. */
			readonly disk?: MeasuredDisk;
	  };

/** How full a computer's disk was when it was measured. */
export interface MeasuredDisk extends DiskUsage {
	readonly measuredAt: Date;
}

/** The last measurement of a project's computer's disk. */
interface ProjectDisk {
	readonly projectId: string;
	readonly disk: MeasuredDisk;
}

const COPY_STEP = { timeout: "5 minutes", maxOutputCharacters: 4_000 } as const;

/** The image or template a provider access makes computers from. */
function imageOf(access: Computers.ProviderAccess): string {
	return access.provider === "e2b" ? access.template : access.image;
}

/**
 * Locks the project until the caller's transaction ends, for a caller that has
 * destroyed its computer and is about to delete it, so no computer is recorded
 * for it meanwhile: recording one waits on the lock, then fails once the
 * project is gone, and its machine is destroyed. Fails if one was recorded
 * after the computer was destroyed, so the caller deletes nothing and can try
 * again.
 */
export const lockWithoutComputer = (
	project: Project,
): Effect.Effect<void, ComputerMadeMeanwhile, Database | Transaction> =>
	Effect.gen(function* () {
		yield* query((db) =>
			db
				.select({ id: projectTable.id })
				.from(projectTable)
				.where(eq(projectTable.id, project.projectId))
				.for("update"),
		);
		const [madeMeanwhile] = yield* query((db) =>
			db
				.select({ id: computerTable.id })
				.from(computerTable)
				.where(eq(computerTable.projectId, project.projectId))
				.limit(1),
		);
		if (madeMeanwhile) return yield* new ComputerMadeMeanwhile();
	});

/**
 * Locks the provider until the caller's transaction ends, for a caller that
 * has destroyed its computers and is about to remove it, as
 * {@link lockWithoutComputer} locks a project: no computer is recorded as
 * made by it meanwhile, and it fails if one was since they were destroyed.
 */
export const lockProviderWithoutComputers = (
	workspaceId: string,
	providerId: string,
): Effect.Effect<void, ComputerMadeMeanwhile, Database | Transaction> =>
	Effect.gen(function* () {
		yield* query((db) =>
			db
				.select({ id: computerProviderTable.id })
				.from(computerProviderTable)
				.where(
					and(
						eq(computerProviderTable.id, providerId),
						eq(computerProviderTable.workspaceId, workspaceId),
					),
				)
				.for("update"),
		);
		const [madeMeanwhile] = yield* query((db) =>
			db
				.select({ id: computerTable.id })
				.from(computerTable)
				.where(eq(computerTable.computerProviderId, providerId))
				.limit(1),
		);
		const [leftMeanwhile] = yield* query((db) =>
			db
				.select({ id: computerDestruction.id })
				.from(computerDestruction)
				.where(eq(computerDestruction.computerProviderId, providerId))
				.limit(1),
		);
		if (madeMeanwhile || leftMeanwhile) return yield* new ComputerMadeMeanwhile();
	});

/**
 * Locks the workspace and its projects until the caller's transaction ends,
 * for a caller that has destroyed the workspace's computers and is about to
 * delete it: no project is made, and no project's computer recorded or moved,
 * until the workspace is gone, so recording one afterwards fails and its
 * machine is destroyed. Fails if one was recorded since they were destroyed,
 * as {@link lockWithoutComputer} does for a project.
 */
export const lockWorkspaceWithoutComputers = (
	workspaceId: string,
): Effect.Effect<void, ComputerMadeMeanwhile, Database | Transaction> =>
	Effect.gen(function* () {
		yield* query((db) =>
			db
				.select({ id: workspaceTable.id })
				.from(workspaceTable)
				.where(eq(workspaceTable.id, workspaceId))
				.for("update"),
		);
		yield* query((db) =>
			db
				.select({ id: projectTable.id })
				.from(projectTable)
				.where(eq(projectTable.workspaceId, workspaceId))
				.for("update"),
		);
		const [madeMeanwhile] = yield* query((db) =>
			db
				.select({ id: computerTable.id })
				.from(computerTable)
				.where(eq(computerTable.workspaceId, workspaceId))
				.limit(1),
		);
		const [leftMeanwhile] = yield* query((db) =>
			db
				.select({ id: computerDestruction.id })
				.from(computerDestruction)
				.where(eq(computerDestruction.workspaceId, workspaceId))
				.limit(1),
		);
		if (madeMeanwhile || leftMeanwhile) return yield* new ComputerMadeMeanwhile();
	});

/**
 * What of `credentials` a provider that adds them by `scope` can add: by
 * host alone, the first for each host, which then covers its every path.
 */
function fittedTo(
	scope: Computers.Capabilities["credentials"],
	credentials: readonly Computers.Credential[],
): readonly Computers.Credential[] {
	if (scope === "none") return [];
	const kept = new Map<string, Computers.Credential>();
	for (const credential of credentials) {
		const fitted = scope === "host" ? { ...credential, pathPrefix: undefined } : credential;
		const key = `${fitted.host} ${fitted.pathPrefix ?? ""} ${fitted.header}`;
		if (!kept.has(key)) kept.set(key, fitted);
	}
	return [...kept.values()];
}
