import { eq } from "drizzle-orm";
import { Effect, Exit, Fiber, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database, query } from "../database/database.ts";
import { computer, project as projectTable, user, workspace } from "../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	waitUntilWaitingOnLocks,
} from "../database/testing.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { ComputerCredentials } from "./computer-credentials.ts";
import { ComputerProviderRepository } from "./computer-provider-repository.ts";
import { Computers } from "./computers.ts";
import { ProjectComputers } from "./project-computers.ts";

/**
 * Whether the idle sweep can still pause a project's computer after it was woken
 * by something that didn't finish, whether a computer made in place of
 * another is left running when its record goes meanwhile, and whether the
 * record keeps the computer another process put in its place, against Postgres
 * and an in-memory provider whose resumes and pauses a case can hold part-way.
 * Skips without a database.
 */
const HOLDER: ProjectComputers.Holder = { kind: "turn", id: "turn-under-test" };

describe.skipIf(!process.env.DATABASE_URL)("pausing bots' computers, against Postgres", () => {
	// Every computer the provider has, and whether it runs.
	const atProvider = new Map<string, "running" | "paused">();
	let nextId = 0;
	let resuming: Held | undefined;
	let pausing: Held | undefined;
	// Called after each query the service runs, so a case can tell when one has.
	let afterQuery: (() => void) | undefined;

	const fakeComputer = (id: Computers.ComputerId): Computers.Computer => ({
		id,
		// Every command fails, which is as far as an upgrade gets here.
		exec: () =>
			Effect.succeed({
				exitCode: 1,
				stdout: { text: "", truncated: false },
				stderr: { text: "", truncated: false },
			}),
		readFile: () => Effect.die("unused"),
		writeFile: () => Effect.die("unused"),
		downloadFile: () => Effect.die("unused"),
		uploadFile: () => Effect.die("unused"),
		endpoint: () => Effect.die("unused"),
		setNetwork: () => Effect.void,
	});

	// Like the real providers, `open` and `pause` ignore interruption: the
	// provider carries on once asked, whether or not the caller waits.
	const fakeProvider: Computers.Provider = {
		capabilities: { pauseKeeps: "disk", credentials: "host-and-path", blocksHosts: true },
		networkMode: "open",
		check: Effect.void,
		create: () =>
			Effect.sync(() => {
				const id = Computers.ComputerId(`fake-${++nextId}`);
				atProvider.set(id, "running");
				return fakeComputer(id);
			}),
		open: (id) =>
			atProvider.has(id)
				? Effect.promise(async () => {
						const resumed = atProvider.get(id) === "paused";
						if (resumed) {
							await resuming?.wait();
							atProvider.set(id, "running");
						}
						return { computer: fakeComputer(id), resumed };
					})
				: Effect.fail(new Computers.Missing({ provider: "opensandbox", computerId: id })),
		info: (id) =>
			Effect.succeed({
				state: atProvider.get(id) ?? "running",
				image: "debian",
				workKeptApart: false,
			}),
		pause: (id) =>
			Effect.promise(async () => {
				await pausing?.wait();
				return atProvider.has(id);
			}).pipe(
				Effect.flatMap((present) =>
					present
						? Effect.sync(() => void atProvider.set(id, "paused"))
						: Effect.fail(new Computers.Missing({ provider: "opensandbox", computerId: id })),
				),
			),
		destroy: (id) => Effect.sync(() => void atProvider.delete(id)),
	};

	let projectComputers: ProjectComputers.Interface;
	/** The same service as another process has it, with its own locks. */
	let anotherProcess: ProjectComputers.Interface;
	let providers: ComputerProviderRepository.Interface;
	let theProject: ProjectComputers.Project;

	/**
	 * The service and the provider settings as one process has them: two calls
	 * make two processes' services, each with its own locks.
	 */
	const aProcess = () =>
		runOnPostgres(
			Effect.all([ProjectComputers.Service, ComputerProviderRepository.Service]).pipe(
				Effect.provide(
					Layer.merge(
						ProjectComputers.layerNoDeps.pipe(
							Layer.provide([
								Layer.succeed(Computers.Service, { forConnection: () => fakeProvider }),
								ComputerProviderRepository.layer,
								Layer.effect(
									Database,
									Effect.map(Database, (database) =>
										Database.of({
											...database,
											execute: (run) =>
												Effect.tap(database.execute(run), () => Effect.sync(() => afterQuery?.())),
										}),
									),
								),
							]),
						),
						ComputerProviderRepository.layer,
					),
				),
				Effect.provide([ComputerCredentials.none, unimplemented(Egress.Service, {})]),
			),
		);

	beforeAll(async () => {
		[projectComputers, providers] = await aProcess();
		[anotherProcess] = await aProcess();
	});

	afterAll(closeDatabase);

	beforeEach(async () => {
		atProvider.clear();
		resuming = undefined;
		pausing = undefined;
		afterQuery = undefined;
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Pausing ${suffix}`, slug: `pausing-${suffix}` })
				.returning(),
		);
		const [owner] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `pausing-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		const [made] = await onDatabase((db) =>
			db
				.insert(projectTable)
				.values({ workspaceId: space.id, name: "Launch", slug: "launch" })
				.returning(),
		);
		if (!made) throw new Error("fixture");
		theProject = { workspaceId: space.id, projectId: made.id };
		await runOnPostgres(
			providers.create(theProject.workspaceId, {
				createdById: owner.id,
				provider: {
					// The fake stands in for whatever the settings name.
					settings: { preset: "opensandbox", serverUrl: "http://computers.test", image: "debian" },
					enabled: true,
					apiKey: "key",
				},
			}),
		);
	});

	const enabledProvider = async () => {
		const provider = await runOnPostgres(providers.enabled(theProject.workspaceId));
		if (!provider) throw new Error("no enabled provider");
		return provider;
	};
	const open = async () =>
		runOnPostgres(projectComputers.open(theProject, await enabledProvider(), HOLDER));
	const idleForAnHour = () =>
		onDatabase((db) =>
			db
				.update(computer)
				.set({ lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) })
				.where(eq(computer.projectId, theProject.projectId)),
		);
	/** Whether the provider and the project's record agree the computer is paused. */
	const pausedEverywhere = async (id: Computers.ComputerId) => {
		const [row] = await onDatabase((db) =>
			db.select().from(computer).where(eq(computer.projectId, theProject.projectId)),
		);
		return { atProvider: atProvider.get(id), recordedPaused: row?.pausedAt != null };
	};
	const PAUSED_EVERYWHERE = { atProvider: "paused", recordedPaused: true };
	/** A turn used the computer, let it go, and the idle sweep paused it. */
	const usedThenPaused = async () => {
		const { computer: opened } = await open();
		await runOnPostgres(projectComputers.release(HOLDER));
		await idleForAnHour();
		await runOnPostgres(projectComputers.pauseIdle);
		expect(await pausedEverywhere(opened.id)).toEqual(PAUSED_EVERYWHERE);
		return opened.id;
	};

	it("pauses again a computer whose turn was stopped while it was resuming", async () => {
		const id = await usedThenPaused();
		const resume = held();
		resuming = resume;
		const provider = await enabledProvider();

		await runOnPostgres(
			Effect.gen(function* () {
				const opening = yield* Effect.forkChild(
					projectComputers.open(theProject, provider, HOLDER),
				);
				yield* Effect.promise(() => resume.hasStarted);
				// Asked to stop before the provider has finished resuming it.
				const stopping = yield* Effect.forkChild(Fiber.interrupt(opening), {
					startImmediately: true,
				});
				yield* Effect.sync(resume.finish);
				yield* Fiber.join(stopping);
			}),
		);
		await idleForAnHour();
		await runOnPostgres(projectComputers.pauseIdle);

		expect(await pausedEverywhere(id)).toEqual(PAUSED_EVERYWHERE);
	});

	it("pauses again a computer an upgrade resumed to copy its work, then failed", async () => {
		const id = await usedThenPaused();

		const failed = await runOnPostgres(
			Effect.exit(projectComputers.upgrade(theProject, await enabledProvider())),
		);
		await idleForAnHour();
		await runOnPostgres(projectComputers.pauseIdle);

		expect(failed.toString()).toContain("UpgradeFailed");
		expect(await pausedEverywhere(id)).toEqual(PAUSED_EVERYWHERE);
	});

	it("doesn't resume a computer to bring its network up to date as the sweep pauses it", async () => {
		const { computer: opened } = await open();
		await runOnPostgres(projectComputers.release(HOLDER));
		await idleForAnHour();
		const pause = held();
		pausing = pause;

		await runOnPostgres(
			Effect.gen(function* () {
				const sweeping = yield* Effect.forkChild(projectComputers.pauseIdle);
				yield* Effect.promise(() => pause.hasStarted);
				// An allowed host changes once the sweep holds the project: the update's
				// first query finds the computer running, then it waits its turn for
				// the project. Nothing else queries while the sweep is held.
				const found = Promise.withResolvers<void>();
				afterQuery = found.resolve;
				const updating = yield* Effect.forkChild(
					projectComputers.applyNetwork({
						workspaceId: theProject.workspaceId,
						projectId: theProject.projectId,
					}),
				);
				yield* Effect.promise(() => found.promise);
				yield* Effect.sync(pause.finish);
				yield* Fiber.join(sweeping);
				yield* Fiber.join(updating);
			}),
		);

		expect(await pausedEverywhere(opened.id)).toEqual(PAUSED_EVERYWHERE);
	});

	it("destroys a computer made in place of a missing one when its record is deleted meanwhile", async () => {
		const { computer: first } = await open();
		await runOnPostgres(projectComputers.release(HOLDER));
		atProvider.delete(first.id);
		const ofTheProject = eq(computer.projectId, theProject.projectId);
		// Holds the record while its replacement is made, then deletes it, as
		// deleting the project in another process would.
		const hold = holdTransaction(
			query((db) =>
				db.select({ id: computer.id }).from(computer).where(ofTheProject).for("no key update"),
			),
			query((db) => db.delete(computer).where(ofTheProject)),
		);
		await hold.held;
		const reopened = runOnPostgres(
			Effect.exit(projectComputers.open(theProject, await enabledProvider(), HOLDER)),
		);
		await waitUntilWaitingOnLocks(1);
		await hold.release();

		expect(Exit.isFailure(await reopened)).toBe(true);
		expect([...atProvider.keys()]).toEqual([]);
	});

	/** The provider's id for the computer the project's record names, if it has one. */
	const recordedComputerId = async () => {
		const [row] = await onDatabase((db) =>
			db
				.select({ providerComputerId: computer.providerComputerId })
				.from(computer)
				.where(eq(computer.projectId, theProject.projectId)),
		);
		return row?.providerComputerId;
	};
	/** Locks the project's record until released, so the writes after it queue in order. */
	const holdRecord = async () => {
		const hold = holdTransaction(
			query((db) =>
				db
					.select({ id: computer.id })
					.from(computer)
					.where(eq(computer.projectId, theProject.projectId))
					.for("update"),
			),
		);
		await hold.held;
		return hold;
	};
	/** A computer a turn used and let go of, then its provider lost. */
	const usedThenLost = async () => {
		const { computer: opened } = await open();
		await runOnPostgres(projectComputers.release(HOLDER));
		atProvider.delete(opened.id);
	};

	it("keeps one computer when two processes replace the same missing one", async () => {
		await usedThenLost();
		const provider = await enabledProvider();
		const hold = await holdRecord();
		// Each makes its replacement, then waits to point the record at it.
		const reopenings = [projectComputers, anotherProcess].map((service) =>
			runOnPostgres(Effect.exit(service.open(theProject, provider, HOLDER))),
		);
		await waitUntilWaitingOnLocks(2);
		await hold.release();

		const opened = await Promise.all(reopenings);
		expect(opened.filter(Exit.isSuccess)).toHaveLength(1);
		expect([...atProvider.keys()]).toEqual([await recordedComputerId()]);
	});

	it("keeps the record of a computer another process made in place of one its provider's removal destroys", async () => {
		await usedThenLost();
		const provider = await enabledProvider();
		const hold = await holdRecord();
		const replacing = runOnPostgres(anotherProcess.open(theProject, provider, HOLDER));
		await waitUntilWaitingOnLocks(1);
		// Reads the lost computer's record, then waits behind the replacement to forget it.
		const destroying = runOnPostgres(
			projectComputers.destroyAllMadeBy(theProject.workspaceId, provider),
		);
		await waitUntilWaitingOnLocks(2);
		await hold.release();

		const { computer: replacement } = await replacing;
		await destroying;
		expect(await recordedComputerId()).toBe(replacement.id);
		expect([...atProvider.keys()]).toEqual([replacement.id]);
	});

	it("keeps the record of a computer another process made in place of one the sweep finds missing", async () => {
		const { computer: first } = await open();
		await runOnPostgres(projectComputers.release(HOLDER));
		await idleForAnHour();
		const pause = held();
		pausing = pause;

		await runOnPostgres(
			Effect.gen(function* () {
				const sweeping = yield* Effect.forkChild(projectComputers.pauseIdle);
				yield* Effect.promise(() => pause.hasStarted);
				// Lost while the sweep pauses it, and replaced by a turn in another process.
				atProvider.delete(first.id);
				const { computer: replacement } = yield* anotherProcess.open(
					theProject,
					yield* Effect.promise(enabledProvider),
					HOLDER,
				);
				yield* Effect.sync(pause.finish);
				yield* Fiber.join(sweeping);

				expect(yield* Effect.promise(recordedComputerId)).toBe(replacement.id);
			}),
		);
	});
});

/** A resume or pause the fake provider holds part-way until `finish`. */
function held() {
	const started = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	return {
		/** Settles once the provider has started, and is waiting. */
		hasStarted: started.promise,
		wait: () => {
			started.resolve();
			return finished.promise;
		},
		finish: () => finished.resolve(),
	};
}

type Held = ReturnType<typeof held>;
