import { SystemWorkAuthentication } from "@sugabots/core/authentication/system-work";
import { ComputerProviderStore } from "@sugabots/core/computers/computer-provider-store";
import { ComputerSignIn } from "@sugabots/core/computers/computer-sign-in";
import { Computers } from "@sugabots/core/computers/computers";
import { ProjectComputers } from "@sugabots/core/computers/project-computers";
import { Database, layer as databaseLayer, query } from "@sugabots/core/database/database";
import {
	computer,
	computerLease,
	member,
	project,
	workspace,
} from "@sugabots/core/database/schema";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	type TestInfrastructure,
	waitUntilWaitingOnLocks,
} from "@sugabots/core/database/testing";
import { Operations } from "@sugabots/core/operations/registry";
import { scheduledWorkOperations } from "@sugabots/core/operations/scheduled-work";
import { Egress } from "@sugabots/core/providers/network/egress";
import { unimplemented } from "@sugabots/core/testing";
import { seedProject } from "@sugabots/core/workspaces/projects/seed.test-support";
import { and, eq, sql } from "drizzle-orm";
import {
	Clock,
	ConfigProvider,
	Context,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { layer, make } from "./scheduler.ts";

/**
 * Whether the idle sweep can still pause a project's computer after it was woken
 * by something that didn't finish, whether a computer made in place of
 * another is left running when its record goes meanwhile, and whether the
 * record keeps the computer another process put in its place, against Postgres
 * and an in-memory provider whose resumes and pauses a case can hold part-way.
 * Skips without a database.
 */
const HOLDER: ProjectComputers.Holder = { kind: "turn", id: "turn-under-test" };

describe.skipIf(!process.env.DATABASE_URL)(
	"putting bots' computers to sleep, against Postgres",
	() => {
		// Every computer the provider has, and whether it runs.
		const atProvider = new Map<string, "running" | "asleep">();
		let nextId = 0;
		let beforeCreate: (() => Promise<void>) | undefined;
		let workKeptApart = false;
		let beforeProviderAccess: (() => Promise<void>) | undefined;
		let exec: Computers.Computer["exec"] | undefined;
		let resuming: Held | undefined;
		let pausing: Held | undefined;
		let sleepOutage = false;
		const sleepAttempts: string[] = [];
		// Called after each query the service runs, so a case can tell when one has.
		let afterQuery: (() => void | Promise<void>) | undefined;
		let afterTransaction: (() => void | Promise<void>) | undefined;

		const fakeComputer = (id: Computers.ComputerId): Computers.Computer => ({
			id,
			// Every command fails, which is as far as an upgrade gets here.
			exec: (...args) =>
				exec?.(...args) ??
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
			capabilities: { sleepKeeps: "disk", credentials: "host-and-path", blocksHosts: true },
			networkMode: "open",
			check: Effect.void,
			create: () =>
				Effect.promise(async () => {
					await beforeCreate?.();
					const id = Computers.ComputerId(`fake-${++nextId}`);
					atProvider.set(id, "running");
					return fakeComputer(id);
				}),
			open: (id) =>
				atProvider.has(id)
					? Effect.promise(async () => {
							const resumed = atProvider.get(id) === "asleep";
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
					workKeptApart,
				}),
			sleep: (id) =>
				Effect.promise(async () => {
					sleepAttempts.push(id);
					await pausing?.wait();
					return atProvider.has(id);
				}).pipe(
					Effect.flatMap((present): ReturnType<Computers.Provider["sleep"]> => {
						if (sleepOutage) {
							return Effect.fail(
								new Computers.Unavailable({ provider: "opensandbox", cause: "Provider offline" }),
							);
						}
						return present
							? Effect.sync(() => void atProvider.set(id, "asleep"))
							: Effect.fail(new Computers.Missing({ provider: "opensandbox", computerId: id }));
					}),
				),
			destroy: (id) => Effect.sync(() => void atProvider.delete(id)),
		};

		let projectComputers: ProjectComputers.Interface;
		/** The same service as another process has it, with its own locks. */
		let anotherProcess: ProjectComputers.Interface;
		let providers: ComputerProviderStore.Interface;
		let theProject: ProjectComputers.Project;

		const providerStore = Layer.effect(
			ComputerProviderStore.Service,
			Effect.map(ComputerProviderStore.Service, (store) =>
				ComputerProviderStore.Service.of({
					...store,
					access: (...input) =>
						Effect.suspend(() => {
							const access = store.access(...input);
							return beforeProviderAccess
								? Effect.promise(beforeProviderAccess).pipe(Effect.andThen(access))
								: access;
						}),
				}),
			),
		).pipe(Layer.provide(ComputerProviderStore.layer));

		/**
		 * The service and the provider settings as one process has them: two calls
		 * make two processes' services, each with its own locks.
		 */
		const processServices = Effect.all([
			ProjectComputers.Service,
			ComputerProviderStore.Service,
		]).pipe(
			Effect.provide(
				Layer.merge(
					ProjectComputers.layerNoDeps.pipe(
						Layer.provide([
							Layer.succeed(Computers.Service, { forAccess: () => fakeProvider }),
							providerStore,
							Layer.effect(
								Database,
								Effect.map(Database, (database) =>
									Database.of({
										...database,
										execute: (run) =>
											Effect.tap(database.execute(run), () =>
												Effect.promise(async () => {
													await afterQuery?.();
												}),
											),
										transaction: (use) =>
											Effect.tap(database.transaction(use), () =>
												Effect.promise(async () => {
													await afterTransaction?.();
												}),
											),
									}),
								),
							),
						]),
					),
					ComputerProviderStore.layer,
				),
			),
			Effect.provide([ComputerSignIn.none, unimplemented(Egress.Service, {})]),
		);
		const aProcess = () => runOnPostgres(processServices);

		const sleepOperations = unimplemented(Operations.Service, {
			"projectComputer.sleepIfIdle": (...input) =>
				scheduledWorkOperations["projectComputer.sleepIfIdle"]
					.run(...input)
					.pipe(Effect.provideService(ProjectComputers.Service, projectComputers)),
		});

		const schedulerForComputers = make.pipe(
			Effect.provide(SystemWorkAuthentication.layer),
			Effect.provide(sleepOperations),
		);
		const sleepIdle = Effect.flatMap(
			schedulerForComputers,
			(scheduler) => scheduler.sleepIdleComputers,
		);

		beforeAll(async () => {
			[projectComputers, providers] = await aProcess();
			[anotherProcess] = await aProcess();
		});

		afterAll(closeDatabase);

		beforeEach(async () => {
			atProvider.clear();
			beforeCreate = undefined;
			workKeptApart = false;
			beforeProviderAccess = undefined;
			exec = undefined;
			resuming = undefined;
			pausing = undefined;
			sleepOutage = false;
			sleepAttempts.length = 0;
			afterQuery = undefined;
			afterTransaction = undefined;
			const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const [space] = await onDatabase((db) =>
				db
					.insert(workspace)
					.values({ name: `Pausing ${suffix}`, slug: `pausing-${suffix}` })
					.returning(),
			);
			const [owner] = await onDatabase((db) =>
				db
					.insert(member)
					.values({ name: "Sam", email: `pausing-${suffix}@example.com` })
					.returning(),
			);
			if (!space || !owner) throw new Error("fixture");
			const made = await onDatabase((db) =>
				seedProject(db, { workspaceId: space.id, name: "Launch", slug: "launch" }),
			);
			theProject = { workspaceId: space.id, projectId: made.id };
			await runOnPostgres(
				providers.create(theProject.workspaceId, {
					createdById: owner.id,
					provider: {
						// The fake stands in for whatever the settings name.
						settings: {
							builtIn: "opensandbox",
							serverUrl: "http://computers.test",
							image: "debian",
						},
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
		const idleForAnHour = (project = theProject) =>
			onDatabase((db) =>
				db
					.update(computer)
					.set({ lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) })
					.where(eq(computer.projectId, project.projectId)),
			);
		/** Whether the provider and the project's record agree the computer is asleep. */
		const asleepEverywhere = async (id: Computers.ComputerId) => {
			const [row] = await onDatabase((db) =>
				db.select().from(computer).where(eq(computer.projectId, theProject.projectId)),
			);
			return { atProvider: atProvider.get(id), recordedAsleep: row?.sleptAt != null };
		};
		it("refuses to sleep another computer for authenticated sleep work", async () => {
			await open();
			const [row] = await onDatabase((db) =>
				db
					.select({ id: computer.id })
					.from(computer)
					.where(eq(computer.projectId, theProject.projectId)),
			);
			if (!row) throw new Error("Missing computer");
			await expect(
				runOnPostgres(
					Effect.gen(function* () {
						const auth = yield* SystemWorkAuthentication.Service;
						const principal = yield* auth.computerSleep(row.id);
						return yield* scheduledWorkOperations["projectComputer.sleepIfIdle"].run(
							principal,
							{ computerId: crypto.randomUUID() },
							{ kind: "request", request: crypto.randomUUID() },
						);
					}).pipe(
						Effect.provide(SystemWorkAuthentication.layer),
						Effect.provideService(ProjectComputers.Service, projectComputers),
					),
				),
			).rejects.toMatchObject({ _tag: "ResourceHidden" });
		});

		const ASLEEP_EVERYWHERE = { atProvider: "asleep", recordedAsleep: true };
		/** A turn used the computer, let it go, and the idle sweep paused it. */
		const usedThenAsleep = async () => {
			const { computer: opened } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			await runOnPostgres(sleepIdle);
			expect(await asleepEverywhere(opened.id)).toEqual(ASLEEP_EVERYWHERE);
			return opened.id;
		};

		it("puts back to sleep a computer whose turn was stopped while it was resuming", async () => {
			const id = await usedThenAsleep();
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
			await runOnPostgres(sleepIdle);

			expect(await asleepEverywhere(id)).toEqual(ASLEEP_EVERYWHERE);
		});

		it("records a provider resume when the same claim expires during the call", async () => {
			const id = await usedThenAsleep();
			const resume = held();
			resuming = resume;
			const provider = await enabledProvider();
			const opening = runOnPostgres(projectComputers.open(theProject, provider, HOLDER));
			await resume.hasStarted;
			try {
				await onDatabase((db) =>
					db
						.update(computer)
						.set({ intentExpiresAt: new Date(Date.now() - 1_000) })
						.where(eq(computer.projectId, theProject.projectId)),
				);
			} finally {
				resume.finish();
			}
			expect(await opening).toMatchObject({ computer: { id }, arrival: "rebooted" });
			expect(await asleepEverywhere(id)).toEqual({ atProvider: "running", recordedAsleep: false });
		});

		it("puts back to sleep a computer an upgrade resumed to copy its work, then failed", async () => {
			const id = await usedThenAsleep();

			const failed = await runOnPostgres(
				Effect.exit(projectComputers.upgrade(theProject, await enabledProvider())),
			);
			await idleForAnHour();
			await runOnPostgres(sleepIdle);

			expect(failed.toString()).toContain("UpgradeFailed");
			expect(await asleepEverywhere(id)).toEqual(ASLEEP_EVERYWHERE);
		});

		it("doesn't resume a computer to bring its network up to date as the sweep puts it to sleep", async () => {
			const { computer: opened } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			const pause = held();
			pausing = pause;

			await runOnPostgres(
				Effect.gen(function* () {
					const sweeping = yield* Effect.forkChild(sleepIdle);
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

			expect(await asleepEverywhere(opened.id)).toEqual(ASLEEP_EVERYWHERE);
		});

		it("keeps a lease from landing after the idle recheck and before the provider sleep", async () => {
			const { computer: first } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			const provider = await enabledProvider();
			const beforeSleep = held();
			beforeProviderAccess = beforeSleep.wait;

			const sweeping = runOnPostgres(sleepIdle);
			await beforeSleep.hasStarted;
			const waiting = Promise.withResolvers<void>();
			const opening = runOnPostgres(
				observeSleep(anotherProcess.open(theProject, provider, HOLDER), waiting.resolve),
			);
			try {
				await waiting.promise;
				expect(sleepAttempts).toHaveLength(0);
				const [record] = await onDatabase((db) =>
					db.select().from(computer).where(eq(computer.projectId, theProject.projectId)),
				);
				expect(record?.intentId).toEqual(expect.any(String));
				const leases = await onDatabase((db) =>
					db.select().from(computerLease).where(eq(computerLease.holderId, HOLDER.id)),
				);
				expect(leases.some(({ computerId }) => computerId === record?.id)).toBe(false);
			} finally {
				beforeSleep.finish();
				await sweeping;
			}

			expect(await opening).toMatchObject({ computer: { id: first.id }, arrival: "rebooted" });
			expect(await asleepEverywhere(first.id)).toEqual({
				atProvider: "running",
				recordedAsleep: false,
			});
		});

		it("renews another project's lease while a provider sleep is in progress", async () => {
			await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			const provider = await enabledProvider();
			const second = await onDatabase((db) =>
				seedProject(db, { workspaceId: theProject.workspaceId, name: "Other", slug: "other" }),
			);
			const using = { ...HOLDER, id: crypto.randomUUID() };
			await runOnPostgres(
				anotherProcess.open({ ...theProject, projectId: second.id }, provider, using),
			);
			const expiry = async () => {
				const [lease] = await onDatabase((db) =>
					db.select().from(computerLease).where(eq(computerLease.holderId, using.id)),
				);
				return lease?.expiresAt.getTime() ?? 0;
			};
			const before = await expiry();
			const pause = held();
			pausing = pause;
			const sweeping = runOnPostgres(sleepIdle);
			try {
				await pause.hasStarted;
				await runOnPostgres(Effect.scoped(anotherProcess.renew(using)));
				expect(await expiry()).toBeGreaterThan(before);
			} finally {
				pause.finish();
				await sweeping;
			}
		});

		it("revives a late lease and renews it again while sign-in is still waiting", async () => {
			await open();
			const [record] = await onDatabase((db) =>
				db
					.select({ id: computer.id })
					.from(computer)
					.where(eq(computer.projectId, theProject.projectId)),
			);
			if (!record) throw new Error("Missing computer");
			const ownLease = and(
				eq(computerLease.holderId, HOLDER.id),
				eq(computerLease.computerId, record.id),
			);
			const expiredAt = new Date(Date.now() - 1_000);
			await onDatabase((db) =>
				db.update(computerLease).set({ expiresAt: expiredAt }).where(ownLease),
			);

			const signingIn = held();
			beforeProviderAccess = signingIn.wait;
			await runOnPostgres(
				Effect.scoped(
					Effect.gen(function* () {
						yield* projectComputers.renew(HOLDER);
						yield* Effect.promise(() => signingIn.hasStarted);
						try {
							const [revived] = yield* query((db) =>
								db.select().from(computerLease).where(ownLease),
							);
							expect(revived?.expiresAt.getTime()).toBeGreaterThan(Date.now());
							const expiresSoon = new Date(Date.now() + 1_000);
							yield* query((db) =>
								db.update(computerLease).set({ expiresAt: expiresSoon }).where(ownLease),
							);
							yield* projectComputers.renew(HOLDER);
							const [renewed] = yield* query((db) =>
								db.select().from(computerLease).where(ownLease),
							);
							expect(renewed?.expiresAt.getTime()).toBeGreaterThan(expiresSoon.getTime());
						} finally {
							signingIn.finish();
						}
					}),
				),
			);
		});

		it("does not revive a lapsed lease after an upgrade replaces its provider computer", async () => {
			const { computer: old } = await open();
			workKeptApart = true;
			const provider = await enabledProvider();
			const [row] = await onDatabase((db) =>
				db
					.select({ id: computer.id })
					.from(computer)
					.where(eq(computer.projectId, theProject.projectId)),
			);
			if (!row) throw new Error("Missing computer");
			const heldLease = and(
				eq(computerLease.computerId, row.id),
				eq(computerLease.holderId, HOLDER.id),
			);
			const expiredAt = new Date(Date.now() - 1_000);
			await onDatabase((db) =>
				db.update(computerLease).set({ expiresAt: expiredAt }).where(heldLease),
			);
			await runOnPostgres(projectComputers.upgrade(theProject, provider));
			await runOnPostgres(Effect.scoped(projectComputers.renew(HOLDER)));

			const readLease = () => onDatabase((db) => db.select().from(computerLease).where(heldLease));
			expect(await readLease()).toMatchObject([
				{ providerComputerId: old.id, expiresAt: expiredAt },
			]);
			const { computer: replacement } = await open();
			expect(replacement.id).not.toBe(old.id);
			expect(await readLease()).toMatchObject([{ providerComputerId: replacement.id }]);
		});

		it("waits for a crashed sleeper's claim to expire before opening the computer", async () => {
			const { computer: first } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			const provider = await enabledProvider();
			const now = Date.now();
			await onDatabase((db) =>
				db
					.update(computer)
					.set({
						intentId: crypto.randomUUID(),
						intentExpiresAt: new Date(now + 1000),
					})
					.where(eq(computer.projectId, theProject.projectId)),
			);
			atProvider.set(first.id, "asleep");
			const waiting = Promise.withResolvers<void>();
			const opened = await runOnPostgres(
				Effect.gen(function* () {
					yield* TestClock.setTime(now);
					const opening = yield* Effect.forkChild(
						observeSleep(anotherProcess.open(theProject, provider, HOLDER), waiting.resolve),
					);
					yield* Effect.promise(() => waiting.promise);
					yield* TestClock.adjust("2 seconds");
					return yield* Fiber.join(opening);
				}).pipe(Effect.provide(TestClock.layer())),
			);
			expect(opened).toMatchObject({ computer: { id: first.id }, arrival: "rebooted" });
			const [record] = await onDatabase((db) =>
				db.select().from(computer).where(eq(computer.projectId, theProject.projectId)),
			);
			expect(record).toMatchObject({ intentId: null, intentExpiresAt: null, sleptAt: null });
		});

		it("leaves the database pool free while a resume and a sleep wait for the provider", async () => {
			const firstId = await usedThenAsleep();
			const provider = await enabledProvider();
			const second = await onDatabase((db) =>
				seedProject(db, { workspaceId: theProject.workspaceId, name: "Other", slug: "other" }),
			);
			const secondProject = { ...theProject, projectId: second.id };
			await runOnPostgres(projectComputers.open(secondProject, provider, HOLDER));
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour(secondProject);

			const [secondRecord] = await onDatabase((db) =>
				db.select({ id: computer.id }).from(computer).where(eq(computer.projectId, second.id)),
			);
			if (!secondRecord) throw new Error("Missing computer");
			const scope = Scope.makeUnsafe();
			onTestFinished(() => runOnPostgres(Scope.close(scope, Exit.void)));
			const database = await runOnPostgres(
				Layer.buildWithScope(
					databaseLayer.pipe(
						Layer.provide(
							ConfigProvider.layer(
								ConfigProvider.fromEnv({ env: { ...process.env, DATABASE_POOL_SIZE: "1" } }),
							),
						),
					),
					scope,
				).pipe(Effect.map((context) => Context.get(context, Database))),
			);
			const runOnSmallPool = <A, E>(work: Effect.Effect<A, E, TestInfrastructure>) =>
				runOnPostgres(Effect.provideService(work, Database, database));
			const [computers] = await runOnSmallPool(processServices);
			const resume = held();
			const pause = held();
			resuming = resume;
			pausing = pause;
			const opening = runOnSmallPool(computers.open(theProject, provider, HOLDER));
			const sweeping = runOnSmallPool(
				Effect.gen(function* () {
					const auth = yield* SystemWorkAuthentication.Service;
					const principal = yield* auth.computerSleep(secondRecord.id);
					yield* scheduledWorkOperations["projectComputer.sleepIfIdle"].run(
						principal,
						{ computerId: secondRecord.id },
						{ kind: "request", request: crypto.randomUUID() },
					);
				}).pipe(
					Effect.provide(SystemWorkAuthentication.layer),
					Effect.provideService(ProjectComputers.Service, computers),
				),
			);
			try {
				await Promise.all([resume.hasStarted, pause.hasStarted]);
				const transactions = await runOnSmallPool(
					query((db) =>
						db.execute(
							sql`
						select pid from pg_stat_activity
						where datname = current_database() and state = 'idle in transaction'
					`,
							"objects",
						),
					),
				);
				expect(transactions).toHaveLength(0);
			} finally {
				resume.finish();
				pause.finish();
				await Promise.all([opening, sweeping]);
			}
			expect(await opening).toMatchObject({ computer: { id: firstId }, arrival: "rebooted" });
		});

		it("closes the scheduler scope while the sleep sweep waits for a computer lock", async () => {
			const { computer: opened } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			const locked = await holdRecord();
			let skipFirstSweepDelay = true;
			try {
				await runOnPostgres(
					withSleep(
						Effect.scoped(
							Layer.build(layer.pipe(Layer.provide(sleepOperations))).pipe(
								Effect.andThen(Effect.promise(() => waitUntilWaitingOnLocks(1))),
							),
						),
						(duration, clock) => {
							if (skipFirstSweepDelay && Duration.toSeconds(duration) === 60) {
								skipFirstSweepDelay = false;
								return Effect.void;
							}
							return clock.sleep(duration);
						},
					),
				);
				expect(await asleepEverywhere(opened.id)).toEqual({
					atProvider: "running",
					recordedAsleep: false,
				});
			} finally {
				await locked.release();
			}
			await runOnPostgres(sleepIdle);
		});

		it("keeps the sleep sweep running when renewal detects a stolen claim", async () => {
			const { computer: first } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			const beforeSleep = held();
			beforeProviderAccess = beforeSleep.wait;
			const intentId = crypto.randomUUID();
			const ofProject = eq(computer.projectId, theProject.projectId);
			await runOnPostgres(
				Effect.gen(function* () {
					yield* TestClock.setTime(Date.now());
					const scheduler = yield* schedulerForComputers;
					const finished = yield* Queue.unbounded<void>();
					const runAgain = yield* Queue.unbounded<void>();
					yield* Effect.forkChild(
						scheduler.sleepIdleComputers.pipe(
							Effect.andThen(Queue.offer(finished, undefined)),
							Effect.andThen(Queue.take(runAgain)),
							Effect.forever,
						),
					);
					yield* Effect.promise(() => beforeSleep.hasStarted);
					const now = yield* Clock.currentTimeMillis;
					yield* query((db) =>
						db
							.update(computer)
							.set({ intentId, intentExpiresAt: new Date(now + 60_000) })
							.where(ofProject),
					);
					yield* TestClock.adjust("15 seconds");
					yield* Queue.take(finished);
					expect(sleepAttempts).toHaveLength(0);
					const [record] = yield* query((db) => db.select().from(computer).where(ofProject));
					expect(record?.intentId).toBe(intentId);
					beforeSleep.finish();
					yield* query((db) =>
						db.update(computer).set({ intentId: null, intentExpiresAt: null }).where(ofProject),
					);
					yield* TestClock.adjust("5 minutes");
					yield* Queue.offer(runAgain, undefined);
					yield* Queue.take(finished);
				}).pipe(Effect.provide(TestClock.layer())),
			);
			expect(await asleepEverywhere(first.id)).toEqual(ASLEEP_EVERYWHERE);
		});

		it.each(["reset", "upgrade"] as const)(
			"fences a stale %s before it calls the provider",
			async (operation) => {
				const { computer: first } = await open();
				await runOnPostgres(projectComputers.release(HOLDER));
				const provider = await enabledProvider();
				const waiting = held();
				beforeProviderAccess = waiting.wait;
				const work =
					operation === "reset"
						? projectComputers.reset(theProject)
						: projectComputers.upgrade(theProject, provider);
				const result = runOnPostgres(Effect.exit(work));
				await waiting.hasStarted;
				const intentId = crypto.randomUUID();
				const ofProject = eq(computer.projectId, theProject.projectId);
				await onDatabase((db) =>
					db
						.update(computer)
						.set({ intentId, intentExpiresAt: new Date(Date.now() + 60_000) })
						.where(ofProject),
				);
				waiting.finish();
				expect(Exit.isFailure(await result)).toBe(true);
				const [record] = await onDatabase((db) => db.select().from(computer).where(ofProject));
				expect(record).toMatchObject({ providerComputerId: first.id, intentId });
				expect(atProvider.get(first.id)).toBe("running");
				await onDatabase((db) =>
					db.update(computer).set({ intentId: null, intentExpiresAt: null }).where(ofProject),
				);
			},
		);

		it("invalidates disk usage on interruption and measures it later", async () => {
			const { computer: opened } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			const ofProject = eq(computer.projectId, theProject.projectId);
			await onDatabase((db) =>
				db
					.update(computer)
					.set({
						diskUsage: { usedBytes: 95, totalBytes: 100, folders: null },
						diskMeasuredAt: new Date(0),
					})
					.where(ofProject),
			);
			const clearing = held();
			const folder = `${Computers.CHATS_DIRECTORY}/${crypto.randomUUID()}`;
			const output = (text: string) =>
				Effect.succeed({
					exitCode: 0,
					stdout: { text, truncated: false },
					stderr: { text: "", truncated: false },
				});
			let measurements = 0;
			exec = (command) => {
				if (command.startsWith("find ")) return output(folder);
				if (command.startsWith("df ")) {
					measurements++;
					return output("Used Available\n40 60");
				}
				if (command.startsWith("shopt ")) return output("12\t/tmp");
				return Effect.promise(clearing.wait).pipe(Effect.andThen(output(folder)));
			};

			await runOnPostgres(
				Effect.gen(function* () {
					const sweeping = yield* Effect.forkChild(sleepIdle);
					yield* Effect.promise(() => clearing.hasStarted);
					const stopping = yield* Effect.forkChild(Fiber.interrupt(sweeping), {
						startImmediately: true,
					});
					const [record] = yield* query((db) => db.select().from(computer).where(ofProject));
					expect(record?.intentId).toEqual(expect.any(String));
					clearing.finish();
					yield* Fiber.join(stopping);
				}),
			);
			const [record] = await onDatabase((db) => db.select().from(computer).where(ofProject));
			expect(record).toMatchObject({
				intentId: null,
				diskUsage: null,
				diskMeasuredAt: null,
			});
			expect(await asleepEverywhere(opened.id)).toEqual({
				atProvider: "running",
				recordedAsleep: false,
			});
			expect(measurements).toBe(0);
			await runOnPostgres(projectComputers.measureDisks);
			expect(await runOnPostgres(projectComputers.diskOf(theProject))).toMatchObject({
				usedBytes: 40,
				totalBytes: 100,
			});
			await runOnPostgres(sleepIdle);
		});

		it("backs off after a computer provider refuses to put a computer to sleep", async () => {
			const { computer: opened } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			sleepOutage = true;
			const attempts = () => sleepAttempts.filter((id) => id === opened.id);
			await runOnPostgres(
				Effect.gen(function* () {
					yield* TestClock.setTime(Date.now());
					const scheduler = yield* schedulerForComputers;
					yield* scheduler.sleepIdleComputers;
					expect(attempts()).toHaveLength(1);
					sleepOutage = false;
					yield* TestClock.adjust("4 minutes");
					yield* scheduler.sleepIdleComputers;
					expect(attempts()).toHaveLength(1);
					yield* TestClock.adjust("1 minute");
					yield* scheduler.sleepIdleComputers;
					expect(attempts()).toHaveLength(2);
				}).pipe(Effect.provide(TestClock.layer())),
			);
			expect(await asleepEverywhere(opened.id)).toEqual(ASLEEP_EVERYWHERE);
		});

		it.each(["deleted", "claimed"] as const)(
			"destroys an unrecorded replacement after the original row was %s elsewhere",
			async (change) => {
				const { computer: first } = await open();
				await runOnPostgres(projectComputers.release(HOLDER));
				atProvider.delete(first.id);
				const creating = held();
				beforeCreate = creating.wait;
				const retrying = Promise.withResolvers<void>();
				const reopened = runOnPostgres(
					withSleep(
						Effect.exit(projectComputers.open(theProject, await enabledProvider(), HOLDER)),
						(duration, clock) => {
							if (Duration.toSeconds(duration) === 1) retrying.resolve();
							return clock.sleep(duration);
						},
					),
				);
				await creating.hasStarted;
				const ofProject = eq(computer.projectId, theProject.projectId);
				const intentId = crypto.randomUUID();
				if (change === "deleted") {
					await onDatabase((db) => db.delete(project).where(eq(project.id, theProject.projectId)));
				} else {
					await onDatabase((db) =>
						db
							.update(computer)
							.set({ intentId, intentExpiresAt: new Date(Date.now() + 60_000) })
							.where(ofProject),
					);
				}
				creating.finish();

				if (change === "deleted") {
					expect(Exit.isFailure(await reopened)).toBe(true);
					expect([...atProvider.keys()]).toEqual([]);
				} else {
					await retrying.promise;
					const [record] = await onDatabase((db) => db.select().from(computer).where(ofProject));
					expect(record).toMatchObject({ providerComputerId: first.id, intentId });
					expect([...atProvider.keys()]).toEqual([]);
					await onDatabase((db) =>
						db.update(computer).set({ intentId: null, intentExpiresAt: null }).where(ofProject),
					);
					const opened = await reopened;
					expect(Exit.isSuccess(opened)).toBe(true);
					expect([...atProvider.keys()]).toEqual([await recordedComputerId()]);
				}
			},
		);

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

		it.each([false, true])(
			"keeps one replacement for concurrent opens across processes: %s",
			async (acrossProcesses) => {
				await usedThenLost();
				const provider = await enabledProvider();
				const creating = held();
				let attempts = 0;
				beforeCreate = () => {
					attempts++;
					return creating.wait();
				};
				const first = runOnPostgres(projectComputers.open(theProject, provider, HOLDER));
				await creating.hasStarted;
				const waiting = Promise.withResolvers<void>();
				const other = acrossProcesses ? anotherProcess : projectComputers;
				const second = runOnPostgres(
					observeSleep(
						other.open(theProject, provider, { ...HOLDER, id: "other-turn" }),
						waiting.resolve,
					),
				);
				try {
					await waiting.promise;
				} finally {
					creating.finish();
				}
				const opened = await Promise.all([first, second]);
				const recorded = await recordedComputerId();
				expect(opened.map(({ computer }) => computer.id)).toEqual([recorded, recorded]);
				expect(attempts).toBe(1);
				expect([...atProvider.keys()]).toEqual([recorded]);
			},
		);

		it("keeps the record of a computer another process made in place of one its provider's removal destroys", async () => {
			await usedThenLost();
			const provider = await enabledProvider();
			const creating = held();
			beforeCreate = creating.wait;
			const replacing = runOnPostgres(anotherProcess.open(theProject, provider, HOLDER));
			await creating.hasStarted;
			const hold = await holdRecord();
			creating.finish();
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

		it("destroys the old provider computer when an upgrade loses its claim after the move", async () => {
			const { computer: old } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			workKeptApart = true;
			const moved = held();
			beforeCreate = async () => {
				afterTransaction = () => {
					afterTransaction = undefined;
					return moved.wait();
				};
			};
			const provider = await enabledProvider();
			const upgrading = runOnPostgres(projectComputers.upgrade(theProject, provider));
			await moved.hasStarted;
			const replacement = await recordedComputerId();
			const intentId = crypto.randomUUID();
			try {
				expect(replacement).not.toBe(old.id);
				await onDatabase((db) =>
					db
						.update(computer)
						.set({ intentId, intentExpiresAt: new Date(Date.now() + 60_000) })
						.where(eq(computer.projectId, theProject.projectId)),
				);
			} finally {
				moved.finish();
			}
			await upgrading;
			expect([...atProvider.keys()]).toEqual([replacement]);
		});

		it("replaces a missing computer from another process after the sweep forgets it", async () => {
			const { computer: first } = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			const pause = held();
			pausing = pause;

			const provider = await enabledProvider();
			const sweeping = runOnPostgres(sleepIdle);
			await pause.hasStarted;
			atProvider.delete(first.id);
			const waiting = Promise.withResolvers<void>();
			const opening = runOnPostgres(
				observeSleep(anotherProcess.open(theProject, provider, HOLDER), waiting.resolve),
			);
			try {
				await waiting.promise;
			} finally {
				pause.finish();
				await sweeping;
			}

			const { computer: replacement } = await opening;
			expect(replacement.id).not.toBe(first.id);
			expect(await recordedComputerId()).toBe(replacement.id);
		});
	},
);

function observeSleep<A, E, R>(work: Effect.Effect<A, E, R>, sleeping: () => void) {
	return withSleep(work, (duration, clock) =>
		Effect.sync(sleeping).pipe(Effect.andThen(clock.sleep(duration))),
	);
}

function withSleep<A, E, R>(
	work: Effect.Effect<A, E, R>,
	sleep: (duration: Duration.Duration, clock: Clock.Clock) => Effect.Effect<void>,
) {
	return Clock.clockWith((clock) =>
		Effect.provideService(
			work,
			Clock.Clock,
			Object.assign(Object.create(clock), {
				sleep: (duration: Duration.Duration) => Effect.suspend(() => sleep(duration, clock)),
			}),
		),
	);
}

/** A resume or pause the fake provider holds part-way until `finish`. */
function held() {
	const started = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	onTestFinished(() => finished.resolve());
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
