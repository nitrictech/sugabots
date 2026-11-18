export * as BotComputers from "./bot-computers.ts";

import { posix } from "node:path";
import { COMPUTER_DISK_WARNING_SHARE, computerDiskShare } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Clock, Context, Data, DateTime, Duration, Effect, Layer, Semaphore } from "effect";
import { Database, query, serviceOperations } from "../database/database.ts";
import { computerLease, computer as computerTable } from "../database/schema.ts";
import { Ids } from "../ids/ids.ts";
import { Egress } from "../providers/network/egress.ts";
import type { UserFacing } from "../user-message.ts";
import { reachOf } from "./allowed-hosts.ts";
import { ComputerCredentials } from "./computer-credentials.ts";
import { type DiskUsage, measureDisk } from "./computer-disk.ts";
import { freeDiskSpace, SET_ASIDE_DIRECTORY } from "./computer-disk-clearing.ts";
import { ComputerProviderRepository } from "./computer-provider-repository.ts";
import { Computers } from "./computers.ts";
import { pinnedToDigest, withoutTag } from "./image-digest.ts";
import type { ComputerLeaseHolderKind } from "./sql.ts";

/** How long a lease holds a computer awake unless it is renewed. */
const LEASE = Duration.seconds(90);
/** How often a turn renews its lease, well inside {@link LEASE}. */
export const LEASE_RENEWAL = Duration.seconds(30);
/** How long a computer sits with no turn using it before it is paused. */
const IDLE_BEFORE_PAUSE = Duration.minutes(5);
/** How long before its credentials expire a computer in use is given new ones. */
const CREDENTIAL_REFRESH_MARGIN = Duration.minutes(10);
/** How often the sweeps look for idle computers to pause, and running ones to measure. */
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
 * Clearing a filling disk stops once the workspace is less than this share
 * full, leaving room for the next turn's clones and installs.
 */
const CLEARED_BELOW_SHARE = 0.7;

/**
 * The only writer of `computer` and `computer_lease`: each bot's one computer,
 * made the first time the bot needs it, then opened, and resumed, on
 * every later use. A turn using it holds a lease, and a computer no turn has
 * held for {@link IDLE_BEFORE_PAUSE} is paused, so it stops costing compute.
 * A turn waiting for a person's approval has ended its run and holds no
 * lease, so nobody pays for a computer while a person is away.
 */
export interface Interface {
	/**
	 * The bot's computer at `provider`, the workspace's enabled one, ready to
	 * run commands, with a lease for `holder` that keeps it awake until
	 * released or expired.
	 */
	readonly open: (
		bot: Bot,
		provider: ComputerProviderRepository.Configured,
		holder: Holder,
	) => Effect.Effect<Opened, Computers.Unavailable>;
	/**
	 * Extends `holder`'s leases, and signs their computers in afresh when their
	 * credentials are about to expire. Nothing happens if it has none.
	 */
	readonly renew: (holder: Holder) => Effect.Effect<void>;
	/** Ends `holder`'s leases, starting the idle time of the computers it held. */
	readonly release: (holder: Holder) => Effect.Effect<void>;
	/**
	 * Pauses every computer idle for {@link IDLE_BEFORE_PAUSE}, first clearing
	 * any last measured close to full to below {@link CLEARED_BELOW_SHARE}.
	 */
	readonly pauseIdle: Effect.Effect<void>;
	/**
	 * Upgrades every computer nobody has used or watched for
	 * {@link IDLE_BEFORE_PAUSE} whose image is behind what the workspace's
	 * enabled provider makes computers from now, as {@link upgrade} does, and
	 * leaves the new one paused. Only at a provider that takes images as they
	 * are; a template is left to be rebuilt and upgraded to by hand. Skips for
	 * {@link UPGRADE_RETRY} a computer that failed to upgrade.
	 */
	readonly upgradeIdle: Effect.Effect<void>;
	/**
	 * Measures the disk of every running computer not measured for
	 * {@link DISK_MEASUREMENT_INTERVAL}, without resuming any: a paused
	 * computer's disk doesn't change, so its last measurement still holds.
	 */
	readonly measureDisks: Effect.Effect<void>;
	/** The last measurement of the bot's computer's disk, if it has one. */
	readonly diskOf: (bot: Bot) => Effect.Effect<MeasuredDisk | undefined>;
	/** The last measurement of the disk of each of the workspace's bots' computers that has one. */
	readonly disksIn: (workspaceId: string) => Effect.Effect<readonly BotDisk[]>;
	/**
	 * Destroys every computer `provider` made and forgets them, so the provider
	 * can be removed without leaving machines running at it.
	 */
	readonly destroyAllMadeBy: (
		workspaceId: string,
		provider: ComputerProviderRepository.Configured,
	) => Effect.Effect<void, Computers.Unavailable>;
	/**
	 * Keeps the running computers of the workspace's bots, or of one bot, to
	 * the hosts each may reach now, signed in as each bot is now. A paused one
	 * is brought up to date when it is next opened; one that can't be reached
	 * is logged and left for then too.
	 */
	readonly applyNetwork: (where: { workspaceId: string; botId?: string }) => Effect.Effect<void>;
	/** Whether `providerId` has made any computer that still exists. */
	readonly anyMadeBy: (workspaceId: string, providerId: string) => Effect.Effect<boolean>;
	/**
	 * How the bot's computer stands, asking its provider without resuming it.
	 * `current` is the workspace's enabled provider, which says whether the
	 * computer's image is out of date.
	 */
	readonly status: (
		bot: Bot,
		current: ComputerProviderRepository.Configured | undefined,
	) => Effect.Effect<Status>;
	/** Destroys the bot's computer and forgets it; its next use makes a new one. */
	readonly reset: (bot: Bot) => Effect.Effect<void, ComputerInUse | Computers.Unavailable>;
	/**
	 * Destroys the bot's computer at its provider and forgets it, even while a
	 * turn uses it, for a bot about to be deleted: deleting the bot deletes the
	 * record, the only way anything finds the machine. When the provider can't
	 * be reached it fails and keeps the record, so the bot is kept to try again.
	 */
	readonly destroy: (bot: Bot) => Effect.Effect<void, Computers.Unavailable>;
	/**
	 * Moves the bot's work to a new computer made by `provider`, the
	 * workspace's enabled one, from its image, then destroys the old computer.
	 * Work the provider keeps apart from the computer carries over whole;
	 * otherwise `/workspace` is copied across, less what `.gitignore` files
	 * leave out. Once started it finishes, even if the caller goes away, as
	 * does {@link reset}.
	 */
	readonly upgrade: (
		bot: Bot,
		provider: ComputerProviderRepository.Configured,
	) => Effect.Effect<void, ComputerInUse | NoComputer | UpgradeFailed | Computers.Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BotComputers") {}

export const make = Effect.gen(function* () {
	const computers = yield* Computers.Service;
	const ids = yield* Ids.Service;
	const providers = yield* ComputerProviderRepository.Service;
	const signIns = yield* ComputerCredentials.Service;
	const egress = yield* Egress.Service;
	const operation = yield* serviceOperations<Interface>("BotComputers");
	// One change to a bot's computer at a time: two turns' first commands make
	// one computer, and the sweep never pauses one a turn is opening.
	const changes = new Map<string, Semaphore.Semaphore>();
	const oneAtATime = (botId: string) => {
		let semaphore = changes.get(botId);
		if (!semaphore) {
			semaphore = Semaphore.makeUnsafe(1);
			changes.set(botId, semaphore);
		}
		return semaphore.withPermits(1);
	};

	// When each bot's computer must be signed in again, from when it last was by
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
	 * The connection with an image its provider takes as it is pinned to the
	 * digest its tag names now, so a new computer gets that image rather than
	 * whatever the provider's host last pulled for the tag.
	 */
	const pinnedConnection = (connection: Computers.Connection) =>
		connection.provider === "opensandbox"
			? Effect.map(
					pinnedNow(connection.image),
					(pinned): Computers.Connection => ({ ...connection, image: pinned ?? connection.image }),
				)
			: Effect.succeed(connection);

	/** Whether a computer made from `madeFrom` is behind what `connection` makes computers from now. */
	const isBehind = (madeFrom: string | null, connection: Computers.Connection) =>
		connection.provider === "opensandbox"
			? Effect.map(pinnedNow(connection.image), (pinned) =>
					imageIsBehind(madeFrom, connection.image, pinned),
				)
			: Effect.succeed(madeFrom !== imageOf(connection));

	// When a computer that failed to upgrade on its own may be tried again, by its record's id.
	const upgradeRetryAt = new Map<string, number>();

	/**
	 * Sets what the bot's computer may reach and what it is signed in with,
	 * as far as its provider can add credentials.
	 */
	const applyNetwork = (bot: Bot, computer: Computers.Computer, at: Computers.Provider) =>
		Effect.gen(function* () {
			const [reach, signedIn] = yield* Effect.all([reachOf(bot, at), signIns.forBot(bot)]);
			yield* computer.setNetwork({
				reach,
				credentials: fittedTo(at.capabilities.credentials, signedIn.credentials),
				environment: at.capabilities.credentials === "none" ? {} : signedIn.environment,
			});
			if (signedIn.expiresAt === undefined) {
				signInDue.delete(bot.botId);
				return;
			}
			const due = DateTime.subtractDuration(signedIn.expiresAt, CREDENTIAL_REFRESH_MARGIN);
			signInDue.set(bot.botId, DateTime.toEpochMillis(due));
		});

	/**
	 * Brings a running computer's network up to date, as {@link applyNetwork}
	 * does on open. Checked again under the bot's lock, so a computer the sweep
	 * paused meanwhile isn't resumed for it.
	 */
	const applyNetworkWhileRunning = (row: ComputerRow) =>
		oneAtATime(row.botId)(
			Effect.gen(function* () {
				if (!(yield* isRecordedRunning(row))) return;
				const configured = yield* providers.connection(row.workspaceId, row.computerProviderId);
				if (!configured) return;
				const at = computers.forConnection(configured.connection);
				const { computer } = yield* at.open(row.providerComputerId);
				yield* applyNetwork(row, computer, at);
			}),
		).pipe(
			Effect.catchTags({
				ComputerMissing: () => Effect.void,
				// Its replacement is made with the network allowed then.
				ComputerStopped: () => Effect.void,
				ComputerUnavailable: (failure) =>
					Effect.logWarning(
						"Could not bring a computer's network up to date; it is when next opened",
						failure,
					),
			}),
		);

	const recorded = (bot: Bot) =>
		query((db) =>
			db
				.select()
				.from(computerTable)
				.where(
					and(eq(computerTable.botId, bot.botId), eq(computerTable.workspaceId, bot.workspaceId)),
				)
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	const forget = (botId: string) =>
		query((db) => db.delete(computerTable).where(eq(computerTable.botId, botId)));

	/** Whether the bot's record still points at `row`'s computer, and says it is running. */
	const isRecordedRunning = (row: ComputerRow) =>
		query((db) =>
			db
				.select({ id: computerTable.id })
				.from(computerTable)
				.where(and(sameComputer(row), isNull(computerTable.pausedAt))),
		).pipe(Effect.map((rows) => rows.length > 0));

	/**
	 * Opens `row`'s computer, resuming it if it is paused, and records it
	 * running, as one step that isn't stopped part-way when whoever asked goes
	 * away: the provider finishes a resume it has started regardless, and a
	 * computer recorded paused is one the idle sweep never pauses again. It is
	 * recorded as just used too: another process's sweep doesn't wait for the
	 * bot's lock, and would otherwise find it idle before a lease holds it.
	 */
	const openedAndRecorded = (at: Computers.Provider, row: ComputerRow) =>
		Effect.uninterruptible(
			Effect.tap(at.open(row.providerComputerId), () =>
				Effect.flatMap(DateTime.nowAsDate, (now) =>
					query((db) =>
						db
							.update(computerTable)
							.set({ pausedAt: null, lastUsedAt: now })
							.where(sameComputer(row)),
					),
				),
			),
		);

	/**
	 * What the bot's computer is made from. Its work is named by the computer's
	 * record, which a replacement or an upgrade keeps and a reset doesn't, so
	 * a reset starts from empty.
	 */
	const specFor = (bot: Bot, recordId: string, at: Computers.Provider) =>
		Effect.map(
			reachOf(bot, at),
			(reach): Computers.Spec => ({
				labels: { "sugabots.workspace": bot.workspaceId, "sugabots.bot": bot.botId },
				reach,
				workName: recordId,
			}),
		);

	/**
	 * Makes a computer through `connection`, from its image pinned to its
	 * digest, and hands it to `record` with what it was made from, as one step
	 * that isn't stopped part-way when whoever asked goes away: a computer made
	 * but never recorded is one nothing would find to destroy. One whose
	 * recording fails is destroyed.
	 */
	const madeAndRecorded = <E, R>(
		connection: Computers.Connection,
		spec: Computers.Spec,
		record: (computer: Computers.Computer, image: string) => Effect.Effect<unknown, E, R>,
	) =>
		Effect.flatMap(pinnedConnection(connection), (pinned) => {
			const at = computers.forConnection(pinned);
			return Effect.uninterruptible(
				Effect.tap(at.create(spec), (computer) =>
					record(computer, imageOf(pinned)).pipe(
						Effect.onError(() => at.destroy(computer.id).pipe(Effect.ignore)),
					),
				),
			);
		});

	const made = (bot: Bot, provider: ComputerProviderRepository.Configured) =>
		Effect.gen(function* () {
			const id = yield* ids.next;
			const at = computers.forConnection(provider.connection);
			return yield* madeAndRecorded(
				provider.connection,
				yield* specFor(bot, id, at),
				(computer, image) =>
					query((db) =>
						db.insert(computerTable).values({
							id,
							workspaceId: bot.workspaceId,
							botId: bot.botId,
							computerProviderId: provider.id,
							providerComputerId: computer.id,
							image,
						}),
					),
			);
		});

	/**
	 * Destroys the bot's computer at a provider the workspace no longer uses.
	 * A provider that can't be reached leaves it running there, which is
	 * logged rather than blocking the bot's work at its new provider.
	 */
	const leaveOldProvider = (workspaceId: string, providerId: string, id: Computers.ComputerId) =>
		Effect.gen(function* () {
			const old = yield* providers.connection(workspaceId, providerId);
			if (!old) return;
			yield* computers
				.forConnection(old.connection)
				.destroy(id)
				.pipe(
					Effect.catchTag("ComputerUnavailable", (failure) =>
						Effect.logWarning(
							"Could not destroy a computer at a provider no longer in use",
							failure,
						),
					),
				);
		});

	const opened = (bot: Bot, provider: ComputerProviderRepository.Configured) =>
		Effect.gen(function* () {
			const row = yield* recorded(bot);
			const replaced = (computer: Computers.Computer): Opened => ({
				computer,
				arrival: "replaced",
			});
			if (!row) return { computer: yield* made(bot, provider), arrival: "made" } satisfies Opened;
			if (row.computerProviderId !== provider.id) {
				yield* leaveOldProvider(bot.workspaceId, row.computerProviderId, row.providerComputerId);
				yield* forget(bot.botId);
				return replaced(yield* made(bot, provider));
			}
			const at = computers.forConnection(provider.connection);
			return yield* openedAndRecorded(at, row).pipe(
				Effect.map(
					({ computer, resumed }): Opened => ({
						computer,
						arrival: !resumed
							? "running"
							: at.capabilities.pauseKeeps === "disk"
								? "rebooted"
								: "resumed",
					}),
				),
				Effect.catchTag("ComputerMissing", () =>
					Effect.map(restarted(bot, row, provider.connection), replaced),
				),
				Effect.catchTag("ComputerStopped", (stopped) =>
					Effect.map(
						restarted(bot, row, provider.connection),
						(computer): Opened => ({
							computer,
							arrival: stopped.workKept ? "rebooted" : "replaced",
						}),
					),
				),
			);
		});

	/**
	 * A new computer in place of one that is gone or stopped for good, made
	 * with its work name, so it carries on with any work kept apart from it.
	 */
	const restarted = (bot: Bot, row: ComputerRow, connection: Computers.Connection) =>
		Effect.gen(function* () {
			const at = computers.forConnection(connection);
			const fresh = yield* madeAndRecorded(
				connection,
				yield* specFor(bot, row.id, at),
				(computer, image) => moveRecord(row.id, row.computerProviderId, computer.id, image),
			);
			yield* at
				.destroy(row.providerComputerId)
				.pipe(
					Effect.catchTag("ComputerUnavailable", (failure) =>
						Effect.logWarning("Could not destroy a computer that stopped", failure),
					),
				);
			return fresh;
		}).pipe(Effect.uninterruptible);

	/** Points the bot's record at its new computer, made from `image`, which is running and unused. */
	const moveRecord = (
		recordId: string,
		providerId: string,
		computerId: Computers.ComputerId,
		image: string,
	) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db
					.update(computerTable)
					.set({
						computerProviderId: providerId,
						providerComputerId: computerId,
						image,
						pausedAt: null,
						lastUsedAt: now,
						diskUsage: null,
						diskMeasuredAt: null,
					})
					.where(eq(computerTable.id, recordId)),
			);
		});

	/** Takes or extends `holder`'s lease on the bot's computer. */
	const lease = (bot: Bot, holder: Holder) =>
		Effect.gen(function* () {
			const row = yield* recorded(bot);
			if (!row) return;
			const now = yield* DateTime.now;
			const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, LEASE));
			yield* query((db) =>
				db
					.insert(computerLease)
					.values({ computerId: row.id, holderKind: holder.kind, holderId: holder.id, expiresAt })
					.onConflictDoUpdate({
						target: [computerLease.computerId, computerLease.holderKind, computerLease.holderId],
						set: { expiresAt },
					}),
			);
		});

	/** Records `usage` as the computer's disk now, unless the bot has moved to another computer since. */
	const recordMeasurement = (row: ComputerRow, usage: DiskUsage) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db
					.update(computerTable)
					.set({ diskUsage: usage, diskMeasuredAt: now })
					.where(sameComputer(row)),
			);
		});

	/**
	 * Re-measures after clearing, since a paused computer keeps its last
	 * measurement. Runs under the bot's lock, so a turn arriving meanwhile
	 * waits instead of finding its folder half gone.
	 */
	const clearDiskIfFilling = (row: ComputerRow, at: Computers.Provider) =>
		Effect.gen(function* () {
			if (!row.diskUsage || computerDiskShare(row.diskUsage) < COMPUTER_DISK_WARNING_SHARE) return;
			const { computer } = yield* at.open(row.providerComputerId);
			const { cleared, stoppedAtTimeout } = yield* freeDiskSpace(
				computer,
				row.workspaceId,
				CLEARED_BELOW_SHARE,
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
			yield* recordMeasurement(row, yield* measureDisk(computer));
		}).pipe(
			Effect.catchTags({
				// Pausing it finds the same, and deals with it.
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
			Effect.catchCause((cause) => Effect.logError("Clearing a computer's disk failed", cause)),
			Effect.annotateLogs({ computerId: row.id }),
		);

	/**
	 * Pauses one idle computer, unless a turn took it since it was found idle,
	 * clearing space on its disk first if it is filling.
	 */
	const pauseIfStillIdle = (row: ComputerRow, idleSince: Date, now: Date) =>
		oneAtATime(row.botId)(
			Effect.gen(function* () {
				const [still] = yield* query((db) =>
					db
						.select({ id: computerTable.id })
						.from(computerTable)
						.where(
							and(
								eq(computerTable.id, row.id),
								isNull(computerTable.pausedAt),
								lt(computerTable.lastUsedAt, idleSince),
								noLiveLease(now),
							),
						),
				);
				if (!still) return;
				const configured = yield* providers.connection(row.workspaceId, row.computerProviderId);
				if (!configured) return;
				const at = computers.forConnection(configured.connection);
				yield* clearDiskIfFilling(row, at);
				yield* at.pause(row.providerComputerId).pipe(
					Effect.andThen(
						query((db) =>
							db.update(computerTable).set({ pausedAt: now }).where(eq(computerTable.id, row.id)),
						),
					),
					Effect.catchTags({
						// Gone at the provider: the next use makes a new one.
						ComputerMissing: () => forget(row.botId),
						ComputerUnavailable: (failure) =>
							Effect.logWarning("Could not pause an idle computer; trying again later", failure),
					}),
				);
			}),
		);

	/**
	 * Measures one computer's disk if it is running. It is opened under the
	 * bot's lock, which the pause sweep pauses under, so a computer paused
	 * meanwhile is never resumed to be measured. The measuring itself runs
	 * outside the lock, so as not to hold up turns; a computer paused while
	 * it runs fails it, and keeps its last measurement.
	 */
	const measureDiskIfRunning = (row: ComputerRow) =>
		Effect.gen(function* () {
			const configured = yield* providers.connection(row.workspaceId, row.computerProviderId);
			if (!configured) return;
			const at = computers.forConnection(configured.connection);
			const running = yield* oneAtATime(row.botId)(
				Effect.gen(function* () {
					if (!(yield* isRecordedRunning(row))) return undefined;
					const { state } = yield* at.info(row.providerComputerId);
					if (state !== "running") return undefined;
					return (yield* at.open(row.providerComputerId)).computer;
				}),
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

	/** Who holds a live lease on the computer: turns, and people watching a desktop. */
	const holders = (computerId: string) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const leases = yield* query((db) =>
				db
					.select({ holderKind: computerLease.holderKind })
					.from(computerLease)
					.where(and(eq(computerLease.computerId, computerId), gt(computerLease.expiresAt, now))),
			);
			const turns = leases.filter(({ holderKind }) => holderKind === "turn").length;
			return { turns, watching: leases.length - turns };
		});

	/** Fails while a turn is using the computer, which a reset or upgrade would pull out from under it. */
	const requireIdle = (computerId: string) =>
		Effect.flatMap(holders(computerId), ({ turns }) =>
			turns > 0 ? Effect.fail(new ComputerInUse({ turns })) : Effect.void,
		);

	/**
	 * Moves the work of the bot's computer, `row`, to a new one `provider`
	 * makes, as {@link Interface.upgrade} describes, and destroys the old one.
	 * The caller holds the bot's lock and has checked nobody is using it.
	 */
	const movedToNewComputer = (row: ComputerRow, provider: ComputerProviderRepository.Configured) =>
		Effect.gen(function* () {
			const configured = yield* providers.connection(row.workspaceId, row.computerProviderId);
			if (!configured) {
				return yield* new UpgradeFailed({
					reason: userText`The computer's provider has lost its settings, so its work can't be copied. Reset it instead.`,
				});
			}
			const from = computers.forConnection(configured.connection);
			const to = computers.forConnection(provider.connection);
			const destroyOld = from
				.destroy(row.providerComputerId)
				.pipe(
					Effect.catchTag("ComputerUnavailable", (failure) =>
						Effect.logWarning("Could not destroy a computer after upgrading its bot", failure),
					),
				);
			const { workKeptApart } = yield* from
				.info(row.providerComputerId)
				.pipe(Effect.catchTag("ComputerMissing", () => Effect.fail(new NoComputer())));
			if (workKeptApart && provider.id === row.computerProviderId) {
				const fresh = yield* madeAndRecorded(
					provider.connection,
					yield* specFor(row, row.id, to),
					(computer, image) => moveRecord(row.id, provider.id, computer.id, image),
				);
				yield* destroyOld;
				return fresh;
			}
			const old = yield* openedAndRecorded(from, row).pipe(
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
			const archivePath = `/tmp/sugabots-workspace-${yield* ids.random}.tgz`;
			const packed = yield* old.exec(
				`cd ${Computers.WORKSPACE_DIRECTORY} && tar --exclude-vcs-ignores --exclude=./${posix.basename(SET_ASIDE_DIRECTORY)} -czf ${archivePath} .`,
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
			const fresh = yield* madeAndRecorded(
				provider.connection,
				yield* specFor(row, row.id, to),
				(computer, image) =>
					computer.uploadFile(archivePath, archive).pipe(
						Effect.andThen(
							computer.exec(
								`tar -xzf ${archivePath} -C ${Computers.WORKSPACE_DIRECTORY} && rm ${archivePath}`,
								COPY_STEP,
							),
						),
						Effect.map((execution) => execution.exitCode === 0),
						Effect.catchTag("ComputerFileFailed", () => Effect.succeed(false)),
						Effect.flatMap((unpacked) =>
							unpacked
								? moveRecord(row.id, provider.id, computer.id, image)
								: Effect.fail(
										new UpgradeFailed({
											reason: userText`The work couldn't be unpacked in the new computer. The old one is untouched.`,
										}),
									),
						),
					),
			);
			yield* destroyOld;
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
			const at = computers.forConnection(provider.connection);
			if (at.templates) return;
			for (const row of idle) {
				// One at a provider no longer enabled moves when next opened.
				if (row.computerProviderId !== provider.id) continue;
				if ((upgradeRetryAt.get(row.id) ?? 0) > now.getTime()) continue;
				if (!(yield* isBehind(row.image, provider.connection))) continue;
				yield* upgradeIfStillIdle(row, provider, at, idleSince, now).pipe(
					Effect.catchCause((cause) => Effect.logError("Upgrading an idle computer failed", cause)),
					Effect.annotateLogs({ computerId: row.id }),
				);
			}
		});

	/** Upgrades one idle computer, unless someone took it since it was found. */
	const upgradeIfStillIdle = (
		row: ComputerRow,
		provider: ComputerProviderRepository.Configured,
		at: Computers.Provider,
		idleSince: Date,
		now: Date,
	) =>
		oneAtATime(row.botId)(
			Effect.uninterruptible(
				Effect.gen(function* () {
					const [still] = yield* query((db) =>
						db
							.select({ id: computerTable.id })
							.from(computerTable)
							.where(
								and(sameComputer(row), lt(computerTable.lastUsedAt, idleSince), noLiveLease(now)),
							),
					);
					if (!still) return;
					const fresh = yield* movedToNewComputer(row, provider);
					yield* pausedUnused(row, fresh.id, at);
				}),
			),
		).pipe(
			Effect.catchTags({
				// Gone at the provider: the next use makes a new one.
				NoComputer: () => Effect.void,
				UpgradeFailed: (failure) => retryUpgradeLater(row.id, now, failure),
				ComputerUnavailable: (failure) => retryUpgradeLater(row.id, now, failure),
			}),
		);

	/**
	 * Gives the bot's record back the time `row` was last used, since nobody
	 * has used the computer it was upgraded to, then pauses that computer. One
	 * that can't be paused now is paused by the idle sweep, as idle as before.
	 */
	const pausedUnused = (row: ComputerRow, freshId: Computers.ComputerId, at: Computers.Provider) =>
		query((db) =>
			db
				.update(computerTable)
				.set({ lastUsedAt: row.lastUsedAt })
				.where(eq(computerTable.id, row.id)),
		).pipe(
			Effect.andThen(at.pause(freshId)),
			Effect.andThen(
				Effect.flatMap(DateTime.nowAsDate, (now) =>
					query((db) =>
						db.update(computerTable).set({ pausedAt: now }).where(eq(computerTable.id, row.id)),
					),
				),
			),
			Effect.catchTags({
				ComputerMissing: () => Effect.void,
				ComputerUnavailable: (failure) =>
					Effect.logWarning(
						"Could not pause an upgraded computer; it is paused once idle",
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
		open: (bot, provider, holder) =>
			operation(
				"open",
				oneAtATime(bot.botId)(
					opened(bot, provider).pipe(
						// What the workspace allows, and what the bot signs in to, may
						// have changed since the computer last ran.
						Effect.tap(({ computer }) =>
							applyNetwork(bot, computer, computers.forConnection(provider.connection)),
						),
						Effect.tap(() => lease(bot, holder)),
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
							.update(computerLease)
							.set({ expiresAt })
							.where(heldBy(holder))
							.returning({ computerId: computerLease.computerId }),
					);
					if (renewed.length === 0) return;
					const rows = yield* query((db) =>
						db
							.select()
							.from(computerTable)
							.where(
								inArray(
									computerTable.id,
									renewed.map(({ computerId }) => computerId),
								),
							),
					);
					const nowMillis = DateTime.toEpochMillis(now);
					for (const row of rows) {
						const due = signInDue.get(row.botId);
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
							.delete(computerLease)
							.where(heldBy(holder))
							.returning({ computerId: computerLease.computerId }),
					);
					for (const { computerId } of released) {
						yield* query((db) =>
							db
								.update(computerTable)
								.set({ lastUsedAt: now })
								.where(eq(computerTable.id, computerId)),
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
						.from(computerTable)
						.where(
							and(
								isNull(computerTable.pausedAt),
								lt(computerTable.lastUsedAt, idleSince),
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
				// A computer nobody has used since its last measurement isn't measured
				// again. Its disk barely changes, and opening one can postpone the
				// provider's own pause, the backstop for when ours fails.
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
								isNull(computerTable.pausedAt),
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

		diskOf: (bot) =>
			operation(
				"diskOf",
				Effect.map(
					query((db) =>
						db
							.select(MEASUREMENT_COLUMNS)
							.from(computerTable)
							.where(
								and(
									eq(computerTable.workspaceId, bot.workspaceId),
									eq(computerTable.botId, bot.botId),
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
							.select({ botId: computerTable.botId, ...MEASUREMENT_COLUMNS })
							.from(computerTable)
							.where(eq(computerTable.workspaceId, workspaceId)),
					),
					(rows) =>
						rows.flatMap((row) => {
							const disk = measuredDiskOf(row);
							return disk ? [{ botId: row.botId, disk }] : [];
						}),
				),
			),

		destroyAllMadeBy: (workspaceId, provider) =>
			operation(
				"destroyAllMadeBy",
				Effect.gen(function* () {
					const at = computers.forConnection(provider.connection);
					for (const row of yield* madeBy(workspaceId, provider.id)) {
						yield* oneAtATime(row.botId)(
							at.destroy(row.providerComputerId).pipe(Effect.andThen(forget(row.botId))),
						);
					}
				}),
			),

		applyNetwork: ({ workspaceId, botId }) =>
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
									botId === undefined ? undefined : eq(computerTable.botId, botId),
									isNull(computerTable.pausedAt),
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

		status: (bot, current) =>
			operation(
				"status",
				Effect.gen(function* (): Effect.fn.Return<Status, never, Database> {
					const row = yield* recorded(bot);
					if (!row) return { kind: "none" };
					const using = yield* holders(row.id);
					const present = {
						kind: "present" as const,
						providerId: row.computerProviderId,
						createdAt: row.createdAt,
						lastUsedAt: row.lastUsedAt,
						turnsUsing: using.turns,
						peopleWatching: using.watching,
						disk: measuredDiskOf(row),
					};
					const configured = yield* providers.connection(row.workspaceId, row.computerProviderId);
					if (!configured) return { ...present, state: "unreachable", upgradeAvailable: false };
					return yield* computers
						.forConnection(configured.connection)
						.info(row.providerComputerId)
						.pipe(
							Effect.flatMap((info) => {
								// What Sugabots asked for, since a provider may name the image
								// by a tag it has for it: OpenSandbox answers a computer made
								// from `debian@sha256:…` with `debian:bookworm-slim`.
								const image = row.image ?? info.image;
								return Effect.map(
									current === undefined || current.id !== row.computerProviderId
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

		reset: (bot) =>
			operation(
				"reset",
				oneAtATime(bot.botId)(
					// Stopped between destroying and forgetting, the next use would
					// bring back the work the reset was asked to throw away.
					Effect.uninterruptible(
						Effect.gen(function* () {
							const row = yield* recorded(bot);
							if (!row) return;
							yield* requireIdle(row.id);
							const configured = yield* providers.connection(
								row.workspaceId,
								row.computerProviderId,
							);
							if (configured) {
								yield* computers
									.forConnection(configured.connection)
									.destroy(row.providerComputerId);
							}
							yield* forget(bot.botId);
						}),
					),
				),
			),

		destroy: (bot) =>
			operation(
				"destroy",
				oneAtATime(bot.botId)(
					Effect.uninterruptible(
						Effect.gen(function* () {
							const row = yield* recorded(bot);
							if (!row) return;
							const configured = yield* providers.connection(
								row.workspaceId,
								row.computerProviderId,
							);
							// With its provider's settings gone, there is nobody to ask.
							if (configured) {
								yield* computers
									.forConnection(configured.connection)
									.destroy(row.providerComputerId);
							}
							yield* forget(bot.botId);
						}),
					),
				),
			),

		upgrade: (bot, provider) =>
			operation(
				"upgrade",
				oneAtATime(bot.botId)(
					Effect.uninterruptible(
						Effect.gen(function* () {
							const row = yield* recorded(bot);
							if (!row) return yield* new NoComputer();
							yield* requireIdle(row.id);
							yield* movedToNewComputer(row, provider);
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

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Computers.layer, ComputerProviderRepository.layer]),
);

/**
 * Runs `pauseIdle`, `measureDisks` and `upgradeIdle` every minute, each on its
 * own so a slow measurement or upgrade never holds up a pause, for as long as
 * the layer's scope is open.
 */
export const sweepLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const botComputers = yield* Service;
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
		yield* repeatedly(botComputers.pauseIdle, "Pausing idle computers failed");
		yield* repeatedly(botComputers.measureDisks, "Measuring computers' disks failed");
		yield* repeatedly(botComputers.upgradeIdle, "Upgrading idle computers failed");
	}),
).pipe(Layer.provide(layer));

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

/** The row, while it still records the same computer at the provider. */
function sameComputer(row: ComputerRow) {
	return and(
		eq(computerTable.id, row.id),
		eq(computerTable.providerComputerId, row.providerComputerId),
	);
}

/** A lease on the computer that is still in force at `now`. */
function liveLease(now: Date) {
	return sql`exists (select 1 from ${computerLease} where ${computerLease.computerId} = ${computerTable.id} and ${computerLease.expiresAt} > ${now})`;
}

/** No lease on the computer that is still in force at `now`. */
function noLiveLease(now: Date) {
	return sql`not ${liveLease(now)}`;
}

/**
 * Whether a computer made from `madeFrom` is behind `configured`, whose tag
 * names `pinned` now if its registry said. A computer made before images were
 * recorded, from whatever its provider's host had for the tag, counts as
 * behind, so each is upgraded once onto a digest that is known. When the
 * registry didn't say, only a computer made from another image altogether is
 * known to be behind: one pinned from `configured`, or made before images
 * were recorded, may still be what its tag names.
 */
function imageIsBehind(madeFrom: string | null, configured: string, pinned: string | undefined) {
	if (pinned !== undefined) return madeFrom !== pinned;
	if (madeFrom === null) return false;
	return madeFrom !== configured && !madeFrom.startsWith(`${withoutTag(configured)}@`);
}

type ComputerRow = typeof computerTable.$inferSelect;

/** What holds a lease: a turn using the computer, or a person viewing its desktop. */
export interface Holder {
	readonly kind: ComputerLeaseHolderKind;
	readonly id: string;
}

function heldBy(holder: Holder) {
	return and(eq(computerLease.holderKind, holder.kind), eq(computerLease.holderId, holder.id));
}

export interface Bot {
	readonly workspaceId: string;
	readonly botId: string;
}

export interface Opened {
	readonly computer: Computers.Computer;
	/**
	 * How the computer came to be ready, which decides what the bot is told:
	 * - `made`: new, with nothing in it.
	 * - `running`: as the bot left it.
	 * - `resumed`: paused, and back with its programs still running.
	 * - `rebooted`: paused or stopped, and back with its files but no running
	 *   programs.
	 * - `replaced`: new, because the bot's earlier one is gone with its work:
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

/** How full a computer's disk was when it was measured. */
export interface MeasuredDisk extends DiskUsage {
	readonly measuredAt: Date;
}

/** The last measurement of a bot's computer's disk. */
interface BotDisk {
	readonly botId: string;
	readonly disk: MeasuredDisk;
}

const COPY_STEP = { timeout: "5 minutes", maxOutputCharacters: 4_000 } as const;

/** The image or template a connection makes computers from. */
function imageOf(connection: Computers.Connection): string {
	return connection.provider === "e2b" ? connection.template : connection.image;
}

/** A turn is using the computer, and resetting or upgrading it would pull it out from under the bot. */
export class ComputerInUse
	extends Data.TaggedError("ComputerInUse")<{ turns: number }>
	implements UserFacing
{
	get userMessage() {
		return userText`A bot is using the computer right now. Try again when it has finished.`;
	}
}

/** The bot has no computer to upgrade, or its provider lost it. */
export class NoComputer extends Data.TaggedError("NoComputer") implements UserFacing {
	get userMessage() {
		return userText`This bot has no computer to upgrade. Its next one is made from the current image.`;
	}
}

/** An upgrade stopped before the bot moved; its old computer is untouched. */
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
