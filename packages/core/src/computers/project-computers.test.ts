import { ComputerUnavailable } from "@sugabots/contracts/errors/computers";
import { eq, inArray } from "drizzle-orm";
import { DateTime, type Duration, Effect, Exit, Fiber, Layer, Redacted, Scope } from "effect";
import { afterAll, afterEach, describe, expect, it, onTestFinished } from "vitest";
import { query, transaction } from "../database/database.ts";
import {
	computer,
	computerDestruction,
	computerLease,
	computerProvider,
	project as projectTable,
	workspace,
} from "../database/schema.ts";
import { closeDatabase, holdTransaction, onDatabase, runOnPostgres } from "../database/testing.ts";
import { createWorkspaceFixture } from "../database/workspace.test-support.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { seedProject } from "../workspaces/projects/seed.test-support.ts";
import { ComputerProviderStore } from "./computer-provider-store.ts";
import { ComputerSignIn } from "./computer-sign-in.ts";
import type { Computers } from "./computers.ts";
import { sweepIdleComputers } from "./project-computers.test-support.ts";
import { ProjectComputers } from "./project-computers.ts";
import { inMemoryComputers, type ProviderHold } from "./testing.ts";

/**
 * A project's one computer, against Postgres and a provider that keeps its
 * computers in memory, so what is decided above a provider (leases, sleeping,
 * upgrades) runs without a server. What a real provider does with containers,
 * volumes and shells is in `project-computers.opensandbox.test.ts`.
 */
const DEBIAN = "debian:bookworm-slim";
const PYTHON = "python:3.13-slim";
const DEBIAN_DIGEST = `sha256:${"a".repeat(64)}`;
const PYTHON_DIGEST = `sha256:${"b".repeat(64)}`;
/** The OpenSandbox server the workspace's first provider reaches. */
const FIRST_SERVER = "http://computers.test";
/** Another OpenSandbox server, for a provider that replaces the first. */
const SECOND_SERVER = "http://other-computers.test";
const TURN: ProjectComputers.Holder = { kind: "turn", id: "turn-under-test" };
const OTHER_TURN: ProjectComputers.Holder = { kind: "turn", id: "another-turn" };

afterAll(closeDatabase);

/**
 * The workspaces cases made. The sweeps and renewals work on every computer
 * in the database, so a computer left idle or leased by one case would be
 * acted on, through the next case's provider, by that case's sweep.
 */
const workspacesMade: string[] = [];
/** The provider calls cases held, released after each so nothing is left waiting on one. */
const holdsMade: ProviderHold[] = [];
afterEach(async () => {
	for (const hold of holdsMade.splice(0)) hold.release();
	const made = workspacesMade.splice(0);
	if (made.length === 0) return;
	await onDatabase((db) => db.delete(workspace).where(inArray(workspace.id, made)));
});

/**
 * A fresh workspace with one project and an enabled provider, and the
 * service as one process has it, over a provider that keeps its computers in
 * memory and a registry that says what each image's tag names.
 */
async function startWorld(providerOptions: Parameters<typeof inMemoryComputers>[0] = {}) {
	const provider = inMemoryComputers(providerOptions);
	const registry = {
		digests: new Map([
			[DEBIAN, DEBIAN_DIGEST],
			[PYTHON, PYTHON_DIGEST],
		]),
		reachable: true,
		beforeAnswer: async () => {},
	};
	const registryFetch = (async (input: string | URL | Request) => {
		await registry.beforeAnswer();
		if (!registry.reachable) throw new Error("registry unreachable");
		const url = new URL(input instanceof Request ? input.url : input);
		const [, repository, tag] =
			/^\/v2\/(?:library\/)?(.+)\/manifests\/(.+)$/.exec(url.pathname) ?? [];
		const digest = registry.digests.get(`${repository}:${tag}`);
		return new Response(null, {
			status: digest ? 200 : 404,
			headers: digest ? { "docker-content-digest": digest } : {},
		});
	}) as typeof fetch;
	const signedInAs = new Map<string, ComputerSignIn.SignedIn>();

	const [projectComputers, providers] = await runOnPostgres(
		Effect.all([ProjectComputers.Service, ComputerProviderStore.Service]).pipe(
			Effect.provide(
				Layer.merge(
					ProjectComputers.layerNoDeps.pipe(
						Layer.provide([provider.layer, ComputerProviderStore.layer]),
					),
					ComputerProviderStore.layer,
				),
			),
			Effect.provide([
				Layer.succeed(ComputerSignIn.Service, {
					forProject: ({ projectId }) =>
						Effect.sync(() => {
							const signedIn = signedInAs.get(projectId);
							return signedIn && { revision: projectId, load: Effect.succeed(signedIn) };
						}),
				}),
				unimplemented(Egress.Service, { providers: { for: () => registryFetch } }),
			]),
		),
	);

	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const {
		workspace: space,
		members: { owner },
		project: made,
	} = await createWorkspaceFixture(
		{ name: `Computer ${suffix}`, slug: `computer-${suffix}` },
		{ owner: { name: "Sam", role: "editor" } },
		() => ({ project: { name: "Launch", slug: "launch" } }),
	);
	workspacesMade.push(space.id);
	const project: ProjectComputers.Project = { workspaceId: space.id, projectId: made.id };

	/** A provider for the workspace at `serverUrl`, enabled, which disables any other. */
	const addProvider = (serverUrl = FIRST_SERVER) =>
		runOnPostgres(
			providers.create(project.workspaceId, {
				createdById: owner.id,
				provider: {
					settings: { builtIn: "opensandbox", serverUrl, image: DEBIAN },
					enabled: true,
					apiKey: "a-key",
				},
			}),
		);
	await addProvider();

	const enabledProvider = async () => {
		const enabled = await runOnPostgres(providers.enabled(project.workspaceId));
		if (!enabled) throw new Error("no enabled provider");
		return enabled;
	};
	/** Registers `hold` to be released after the case, and returns it. */
	const released = (hold: ProviderHold) => {
		holdsMade.push(hold);
		return hold;
	};
	const world = {
		provider,
		registry,
		/** Holds every creation from now on until released. */
		holdCreations: () => released(provider.holdCreations()),
		holdLabelledLookups: () => released(provider.holdLabelledLookups()),
		/** Holds every opening of the computer `id` at its provider from now on until released. */
		holdOpening: (id: Computers.ComputerId) => released(provider.holdOpening(id)),
		/** What the project's computer is signed in with from now on. */
		signInAs: (signedIn: ComputerSignIn.SignedIn, inProject = project) =>
			void signedInAs.set(inProject.projectId, signedIn),
		/** Another project of the workspace, with no computer yet. */
		addProject: async (slug: string): Promise<ProjectComputers.Project> => {
			const added = await onDatabase((db) =>
				seedProject(db, { workspaceId: space.id, name: slug, slug }),
			);
			return { workspaceId: space.id, projectId: added.id };
		},
		project,
		projectComputers,
		addProvider,
		enabledProvider,
		open: async (holder = TURN, inProject = project) =>
			runOnPostgres(projectComputers.open(inProject, await enabledProvider(), holder)),
		release: (holder = TURN) => runOnPostgres(projectComputers.release(holder)),
		status: async () => runOnPostgres(projectComputers.status(project, await enabledProvider())),
		/** Changes the provider's image, as a workspace admin would, or as a release moves its tag. */
		changeImage: async (image: string) =>
			runOnPostgres(
				providers.update(project.workspaceId, (await enabledProvider()).id, {
					settings: { builtIn: "opensandbox", serverUrl: FIRST_SERVER, image },
				}),
			),
		/** Makes the project's computer look unused for longer than the idle window. */
		idleForAnHour: () =>
			onDatabase((db) =>
				db
					.update(computer)
					.set({ lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) })
					.where(eq(computer.projectId, project.projectId)),
			),
		/** Runs the scheduler's idle sweep: the computers idle now are put to sleep. */
		sleepIdle: () => runOnPostgres(sweepIdleComputers(projectComputers)),
	};
	return world;
}

type World = Awaited<ReturnType<typeof startWorld>>;

/** What a member is told about `error`. */
function userMessageOf(error: unknown): string {
	return String((error as { userMessage?: unknown }).userMessage);
}

/**
 * How many fibers forked into `scope` are still running. Effect keeps a
 * finalizer in the scope for each, to interrupt it when the scope closes,
 * from when it is forked until it ends.
 */
function fibersRunningIn(scope: Scope.Scope) {
	const { state } = scope;
	if (state._tag !== "Open") return 0;
	return (state.finalizer ? 1 : 0) + (state.finalizers?.size ?? 0);
}

/** The only computer the provider has, which a case that expects one asks for. */
function theOnly<A>(computers: readonly A[]): A {
	expect(computers).toHaveLength(1);
	return computers[0] as A;
}

describe("a project's computer, over an in-memory provider", () => {
	it("makes the project's computer on first use, and opens the same one after", async () => {
		const world = await startWorld();

		const first = await world.open();
		const second = await world.open();

		expect(first.arrival).toBe("made");
		expect(second.arrival).toBe("running");
		expect(second.computer.id).toBe(first.computer.id);
		expect(theOnly(world.provider.computers()).id).toBe(first.computer.id);
	});

	it("makes the computer from the digest its image's tag names, not from the tag the provider last pulled", async () => {
		const world = await startWorld();

		await world.open();

		const made = theOnly(world.provider.computers());
		expect(made.madeFrom).toBe(`debian@${DEBIAN_DIGEST}`);
		expect(made.spec.labels).toEqual({
			"sugabots.workspace": world.project.workspaceId,
			"sugabots.project": world.project.projectId,
			// Finds it at the provider if its creation never recorded it.
			"sugabots.creation": expect.any(String),
		});
		expect(await world.status()).toMatchObject({ image: `debian@${DEBIAN_DIGEST}` });
	});

	it("makes one computer when two turns open it at once, and both hold it", async () => {
		const world = await startWorld();
		const provider = await world.enabledProvider();
		const creating = world.holdCreations();

		const [one, other] = await runOnPostgres(
			Effect.gen(function* () {
				// Each runs at once until it first waits, so both are opening before either can finish.
				const opening = (holder: ProjectComputers.Holder) =>
					Effect.forkChild(world.projectComputers.open(world.project, provider, holder), {
						startImmediately: true,
					});
				const first = yield* opening(TURN);
				const second = yield* opening(OTHER_TURN);
				yield* Effect.promise(() => creating.started(1));
				creating.release();
				return yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
			}),
		);

		expect(one.computer.id).toBe(other.computer.id);
		expect(theOnly(world.provider.computers()).id).toBe(one.computer.id);
		expect(await world.status()).toMatchObject({ kind: "present", turnsUsing: 2 });
	});

	it.each([
		{ sleepKeeps: "disk", arrival: "rebooted" },
		{ sleepKeeps: "memory", arrival: "resumed" },
	] as const)(
		"says a computer put to sleep came back $arrival when its provider's sleep keeps $sleepKeeps",
		async ({ sleepKeeps, arrival }) => {
			const world = await startWorld({ sleepKeeps });
			const first = await world.open();
			await world.release();
			await world.idleForAnHour();
			await world.sleepIdle();

			const reopened = await world.open();

			expect(reopened.arrival).toBe(arrival);
			expect(reopened.computer.id).toBe(first.computer.id);
			expect(theOnly(world.provider.computers()).state).toBe("running");
		},
	);

	it("replaces a computer the provider lost", async () => {
		const world = await startWorld();
		const first = await world.open();
		world.provider.lose(first.computer.id);

		const replaced = await world.open();

		expect(replaced.arrival).toBe("replaced");
		expect(replaced.computer.id).not.toBe(first.computer.id);
		expect(theOnly(world.provider.computers()).id).toBe(replaced.computer.id);
	});

	it("makes again, with the same work, a computer that stopped for good", async () => {
		const world = await startWorld();
		const first = await world.open();
		const workName = theOnly(world.provider.computers()).spec.workName;
		world.provider.stopForGood(first.computer.id);

		const back = await world.open();

		expect(back.arrival).toBe("rebooted");
		expect(back.computer.id).not.toBe(first.computer.id);
		const now = theOnly(world.provider.computers());
		expect(now.id).toBe(back.computer.id);
		expect(now.spec.workName).toBe(workName);
	});

	it("moves the project to a newly enabled provider, destroying its computer at the old one", async () => {
		const world = await startWorld();
		await world.open();
		await world.addProvider(SECOND_SERVER);

		const moved = await world.open();

		expect(moved.arrival).toBe("replaced");
		expect(world.provider.computersAt(FIRST_SERVER)).toEqual([]);
		expect(theOnly(world.provider.computersAt(SECOND_SERVER)).id).toBe(moved.computer.id);
	});

	it("destroys and forgets every computer a provider made", async () => {
		const world = await startWorld();
		await world.open();
		const provider = await world.enabledProvider();

		await runOnPostgres(
			world.projectComputers.destroyAllMadeBy(world.project.workspaceId, provider),
		);

		expect(
			await runOnPostgres(world.projectComputers.anyMadeBy(world.project.workspaceId, provider.id)),
		).toBe(false);
		expect(world.provider.computers()).toEqual([]);
	});

	it("lets a workspace with computers be deleted", async () => {
		const world = await startWorld();
		await world.open();

		await onDatabase((db) =>
			db.delete(workspace).where(eq(workspace.id, world.project.workspaceId)),
		);

		const left = await onDatabase((db) =>
			db.select().from(computer).where(eq(computer.workspaceId, world.project.workspaceId)),
		);
		expect(left).toHaveLength(0);
	});

	describe("sleeping", () => {
		it("keeps a computer awake while a turn holds it, and puts it to sleep once the turn lets go and it has sat idle", async () => {
			const world = await startWorld();
			await world.open();
			await world.idleForAnHour();

			await world.sleepIdle();
			const whileHeld = await world.status();
			await world.release();
			await world.idleForAnHour();
			await world.sleepIdle();

			expect(whileHeld).toMatchObject({ state: "running" });
			expect(await world.status()).toMatchObject({ state: "asleep" });
			expect(theOnly(world.provider.computers()).state).toBe("asleep");
		});

		it.each([
			{
				name: "puts to sleep a computer whose turn's lease expired without being renewed",
				renewed: false,
				state: "asleep",
			},
			{
				name: "keeps awake a computer whose turn renewed its expired lease",
				renewed: true,
				state: "running",
			},
		] as const)("$name", async ({ renewed, state }) => {
			const world = await startWorld();
			await world.open();
			await onDatabase((db) =>
				db.update(computerLease).set({ expiresAt: new Date(Date.now() - 1000) }),
			);
			await world.idleForAnHour();
			if (renewed) await runOnPostgres(Effect.scoped(world.projectComputers.renew(TURN)));

			await world.sleepIdle();

			expect(theOnly(world.provider.computers()).state).toBe(state);
		});
	});

	describe("upgrading", () => {
		it("upgrades a computer to the provider's image once no turn uses it and it has sat idle, with its work, and leaves it asleep", async () => {
			const world = await startWorld({ workKeptApart: true });
			const first = await world.open();
			const workName = theOnly(world.provider.computers()).spec.workName;
			await world.changeImage(PYTHON);
			await world.idleForAnHour();

			await runOnPostgres(world.projectComputers.upgradeIdle);
			const whileUsed = theOnly(world.provider.computers());
			await world.release();
			await world.idleForAnHour();
			await runOnPostgres(world.projectComputers.upgradeIdle);

			expect(whileUsed).toMatchObject({
				id: first.computer.id,
				madeFrom: `debian@${DEBIAN_DIGEST}`,
			});
			const upgraded = theOnly(world.provider.computers());
			expect(upgraded).toMatchObject({ state: "asleep", madeFrom: `python@${PYTHON_DIGEST}` });
			expect(upgraded.id).not.toBe(first.computer.id);
			expect(upgraded.spec.workName).toBe(workName);
			const reopened = await world.open();
			expect(reopened.computer.id).toBe(upgraded.id);
			expect(reopened.arrival).toBe("rebooted");
		});

		it("when the registry won't say what a tag names, keeps a computer on it and upgrades only to another image", async () => {
			const world = await startWorld({ workKeptApart: true });
			world.registry.reachable = false;
			const first = await world.open();
			await world.release();
			await world.idleForAnHour();

			await runOnPostgres(world.projectComputers.upgradeIdle);
			const onItsTag = theOnly(world.provider.computers());
			const status = await world.status();
			await world.changeImage(PYTHON);
			await world.idleForAnHour();
			await runOnPostgres(world.projectComputers.upgradeIdle);

			expect(onItsTag).toMatchObject({ id: first.computer.id, madeFrom: DEBIAN });
			expect(status).toMatchObject({ upgradeAvailable: false });
			expect(theOnly(world.provider.computers()).madeFrom).toBe(PYTHON);
		});

		it("reports the project's computer, and when the provider would make it from another image", async () => {
			const world = await startWorld();
			const none = await world.status();
			await world.open();
			const now = await world.status();
			await world.changeImage(PYTHON);
			const later = await world.status();

			expect(none.kind).toBe("none");
			expect(now).toMatchObject({
				kind: "present",
				state: "running",
				turnsUsing: 1,
				image: `debian@${DEBIAN_DIGEST}`,
				upgradeAvailable: false,
			});
			expect(later).toMatchObject({ kind: "present", upgradeAvailable: true });
		});

		it("makes the work's computer again at its old name when upgrading within a provider that keeps work apart, then destroys the old one", async () => {
			const world = await startWorld({ workKeptApart: true });
			const first = await world.open();
			const workName = theOnly(world.provider.computers()).spec.workName;
			await world.release();
			await world.changeImage(PYTHON);

			await runOnPostgres(
				world.projectComputers.upgrade(world.project, await world.enabledProvider()),
			);
			const upgraded = await world.open();

			expect(upgraded.computer.id).not.toBe(first.computer.id);
			expect(upgraded.arrival).toBe("running");
			expect(theOnly(world.provider.computers())).toMatchObject({
				id: upgraded.computer.id,
				madeFrom: `python@${PYTHON_DIGEST}`,
				spec: expect.objectContaining({ workName }),
			});
		});

		it("copies the work to a new computer when upgrading to another provider, then destroys the old one", async () => {
			const world = await startWorld();
			await world.open();
			await world.release();
			const packedWork = new TextEncoder().encode("the old computer's packed-up work");
			world.provider.serveDownloadsAt(FIRST_SERVER, packedWork);
			await world.addProvider(SECOND_SERVER);

			await runOnPostgres(
				world.projectComputers.upgrade(world.project, await world.enabledProvider()),
			);

			expect(world.provider.computersAt(FIRST_SERVER)).toEqual([]);
			const upgraded = theOnly(world.provider.computersAt(SECOND_SERVER));
			expect([...upgraded.uploads.values()]).toEqual([packedWork]);
			expect((await world.open()).computer.id).toBe(upgraded.id);
		});

		it.each([
			{ failing: "packing the work up in the old computer", made: 1, failsIn: "old" },
			{ failing: "unpacking the work in the new computer", made: 2, failsIn: "new" },
		] as const)(
			"leaves the project on its old computer, and no other, when $failing fails",
			async ({ made, failsIn }) => {
				const world = await startWorld();
				const first = await world.open();
				await world.release();
				world.provider.serveDownloadsAt(FIRST_SERVER, new TextEncoder().encode("packed-up work"));
				await world.addProvider(SECOND_SERVER);
				world.provider.answerCommandsWith((computerId) =>
					(computerId === first.computer.id) === (failsIn === "old") ? 1 : 0,
				);

				const refused = await runOnPostgres(
					Effect.flip(world.projectComputers.upgrade(world.project, await world.enabledProvider())),
				);

				expect(refused).toBeInstanceOf(ProjectComputers.UpgradeFailed);
				expect(world.provider.made()).toBe(made);
				expect(theOnly(world.provider.computersAt(FIRST_SERVER)).id).toBe(first.computer.id);
				expect(world.provider.computersAt(SECOND_SERVER)).toEqual([]);
			},
		);

		it("finishes an upgrade whose caller goes away part-way, leaving one computer behind, which is the project's", async () => {
			const world = await startWorld({ workKeptApart: true });
			const first = await world.open();
			await world.release();
			const provider = await world.enabledProvider();
			const creating = world.holdCreations();

			const upgraded = await runOnPostgres(
				Effect.gen(function* () {
					const upgrading = yield* Effect.forkChild(
						world.projectComputers.upgrade(world.project, provider),
					);
					yield* Effect.promise(() => creating.started(1));
					// Asked to stop, as when its caller goes away, before the new computer is made.
					upgrading.interruptUnsafe();
					creating.release();
					return yield* Fiber.await(upgrading);
				}),
			);

			expect(Exit.hasInterrupts(upgraded)).toBe(true);
			const left = theOnly(world.provider.computers());
			expect(left.id).not.toBe(first.computer.id);
			const reopened = await world.open();
			expect(reopened.computer.id).toBe(left.id);
			expect(reopened.arrival).toBe("running");
		});
	});

	describe("resetting", () => {
		it("leases the record it opens, which a reset replaces with another", async () => {
			const world = await startWorld();
			const first = await world.open();
			const again = await world.open();
			await world.release();
			await runOnPostgres(world.projectComputers.reset(world.project));

			const replacement = await world.open();

			expect(again.record).toBe(first.record);
			expect(replacement.record).not.toBe(first.record);
		});

		it("won't reset a computer a turn is using, and resets it once the turn lets go", async () => {
			const world = await startWorld();
			await world.open();

			const refused = await runOnPostgres(Effect.flip(world.projectComputers.reset(world.project)));
			const keptWhileUsed = world.provider.computers();
			await world.release();
			await runOnPostgres(world.projectComputers.reset(world.project));

			expect(refused).toBeInstanceOf(ProjectComputers.ComputerInUse);
			expect(keptWhileUsed).toHaveLength(1);
			expect((await world.status()).kind).toBe("none");
			expect(world.provider.computers()).toEqual([]);
		});
	});

	describe("machines left behind", () => {
		/** The sweep for machines left behind, run once the time of every one in the workspace has come. */
		const sweepLeftBehind = async (world: World) => {
			await onDatabase((db) =>
				db
					.update(computerDestruction)
					.set({ dueAt: new Date(0) })
					.where(eq(computerDestruction.workspaceId, world.project.workspaceId)),
			);
			await runOnPostgres(world.projectComputers.destroyLeftBehind);
		};

		it("keeps the record of a computer still being made through its provider's removal, and holds the removal until it is made", async () => {
			const world = await startWorld();
			const provider = await world.enabledProvider();
			const creating = world.holdCreations();
			const opening = world.open();
			await creating.started(1);
			const recordsOfIt = () =>
				onDatabase((db) =>
					db
						.select({ creationId: computerDestruction.creationId })
						.from(computerDestruction)
						.where(eq(computerDestruction.workspaceId, world.project.workspaceId)),
				);

			await runOnPostgres(
				world.projectComputers.destroyAllMadeBy(world.project.workspaceId, provider),
			);
			const whileBeingMade = await recordsOfIt();
			const removal = await runOnPostgres(
				Effect.exit(
					transaction(
						ProjectComputers.lockProviderWithoutComputers(world.project.workspaceId, provider.id),
					),
				),
			);
			creating.release();
			const opened = await opening;

			expect(whileBeingMade).toEqual([{ creationId: expect.any(String) }]);
			expect(Exit.isFailure(removal) && String(removal.cause)).toContain("ComputerMadeMeanwhile");
			expect(opened.arrival).toBe("made");
			expect(await recordsOfIt()).toEqual([]);
		});

		it("does not destroy the computer a project opens while provider removal looks up an expired creation", async () => {
			const world = await startWorld();
			const provider = await world.enabledProvider();
			const creating = world.holdCreations();
			const opening = world.open();
			await creating.started(1);
			await onDatabase((db) =>
				db
					.update(computerDestruction)
					.set({ dueAt: new Date(0) })
					.where(eq(computerDestruction.workspaceId, world.project.workspaceId)),
			);
			const lookingUp = world.holdLabelledLookups();
			const removing = runOnPostgres(
				world.projectComputers.destroyAllMadeBy(world.project.workspaceId, provider),
			);
			await lookingUp.started(1);
			creating.release();
			const opened = await opening;
			lookingUp.release();
			await removing;

			expect(world.provider.computers().map(({ id }) => id)).toEqual([opened.computer.id]);
		});

		it("does not start a provider creation after the workspace's final deletion check", async () => {
			const world = await startWorld();
			const checkingImage = Promise.withResolvers<void>();
			const answerImage = Promise.withResolvers<void>();
			onTestFinished(() => answerImage.resolve());
			world.registry.beforeAnswer = () => {
				checkingImage.resolve();
				return answerImage.promise;
			};
			const opening = world.open().catch((error: unknown) => error);
			await checkingImage.promise;
			const { workspaceId } = world.project;
			await onDatabase((db) =>
				db.update(workspace).set({ deleting: true }).where(eq(workspace.id, workspaceId)),
			);
			const deleting = holdTransaction(
				ProjectComputers.lockWorkspaceWithoutComputers(workspaceId),
				query((db) => db.delete(workspace).where(eq(workspace.id, workspaceId))),
			);
			await deleting.held;
			world.provider.failDestroys(1);
			answerImage.resolve();
			await deleting.waitForWaiters(1);
			await deleting.release();
			const refused = await opening;

			expect(refused).toBeInstanceOf(ComputerUnavailable);
			expect(refused).toMatchObject({ provider: "project" });
			expect(world.provider.computers()).toEqual([]);
		});

		it("destroys a computer made while its project was being deleted, which couldn't be destroyed at once", async () => {
			const world = await startWorld();
			const creating = world.holdCreations();
			const opening = world.open().then(
				() => undefined,
				(error: unknown) => error,
			);
			await creating.started(1);
			await onDatabase((db) =>
				db
					.update(projectTable)
					.set({ deleting: true })
					.where(eq(projectTable.id, world.project.projectId)),
			);
			world.provider.failDestroys(1);
			creating.release();

			const refused = await opening;
			const leftRunning = world.provider.computers();
			await sweepLeftBehind(world);

			expect(userMessageOf(refused)).toBe("This project is being deleted.");
			expect(leftRunning).toHaveLength(1);
			expect(world.provider.computers()).toEqual([]);
			expect(
				await onDatabase((db) =>
					db
						.select()
						.from(computerDestruction)
						.where(eq(computerDestruction.workspaceId, world.project.workspaceId)),
				),
			).toEqual([]);
		});

		it("destroys an upgraded computer's old machine later, when its provider didn't answer at once", async () => {
			const world = await startWorld({ workKeptApart: true });
			const first = await world.open();
			await world.release();
			await world.changeImage(PYTHON);
			await world.idleForAnHour();
			world.provider.failDestroys(1);

			await runOnPostgres(world.projectComputers.upgradeIdle);
			const afterUpgrade = world.provider.computers().map(({ id }) => id);
			await sweepLeftBehind(world);

			expect(afterUpgrade).toContain(first.computer.id);
			expect(afterUpgrade).toHaveLength(2);
			expect(theOnly(world.provider.computers()).madeFrom).toBe(`python@${PYTHON_DIGEST}`);
		});

		it("destroys a computer at a provider no longer in use later, when it didn't answer at once", async () => {
			const world = await startWorld();
			const first = await world.open();
			await world.addProvider(SECOND_SERVER);
			world.provider.failDestroys(1);

			const moved = await world.open();
			const leftAtFirst = world.provider.computersAt(FIRST_SERVER).map(({ id }) => id);
			await sweepLeftBehind(world);

			expect(leftAtFirst).toEqual([first.computer.id]);
			expect(world.provider.computersAt(FIRST_SERVER)).toEqual([]);
			expect(theOnly(world.provider.computersAt(SECOND_SERVER)).id).toBe(moved.computer.id);
		});

		it("keeps the record of a computer its provider lacks the settings to destroy", async () => {
			const world = await startWorld();
			await world.open();
			await world.release();
			// As when the key no longer decrypts: the store refuses to take it away.
			await onDatabase((db) =>
				db
					.update(computerProvider)
					.set({ apiKeyEncrypted: null })
					.where(eq(computerProvider.workspaceId, world.project.workspaceId)),
			);

			const refused = await runOnPostgres(Effect.flip(world.projectComputers.reset(world.project)));

			expect(userMessageOf(refused)).toBe(
				"The computer provider lacks the settings to reach its computers. Restore its key or address, then try again.",
			);
			expect(world.provider.computers()).toHaveLength(1);
			expect(
				await onDatabase((db) =>
					db.select().from(computer).where(eq(computer.projectId, world.project.projectId)),
				),
			).toHaveLength(1);
		});
	});

	describe("signing in", () => {
		const signedInUntil = (token: string, expiresIn: Duration.Input) => ({
			credentials: [
				{
					host: "github.com",
					pathPrefix: "/acme/",
					header: "Authorization",
					value: Redacted.make(token),
				},
			],
			expiresAt: DateTime.addDuration(DateTime.nowUnsafe(), expiresIn),
		});

		it("signs in again, on a renewal, only the computers whose sign-in is near expiry", async () => {
			const world = await startWorld();
			const durable = world.project;
			const expiring = await world.addProject("expiring");
			world.signInAs(signedInUntil("Bearer durable at opening", "2 hours"), durable);
			world.signInAs(signedInUntil("Bearer expiring at opening", "5 minutes"), expiring);
			const durableComputer = await world.open(TURN, durable);
			const expiringComputer = await world.open(TURN, expiring);
			world.signInAs(signedInUntil("Bearer durable renewed", "2 hours"), durable);
			world.signInAs(signedInUntil("Bearer expiring renewed", "2 hours"), expiring);
			const refreshing = world.holdOpening(expiringComputer.computer.id);
			const refreshed = world.provider.nextNetwork(expiringComputer.computer.id);
			// The turn's scope, open until the case ends, so nothing the renewal started is cut short.
			const turnScope = Scope.makeUnsafe();
			onTestFinished(() => Effect.runPromise(Scope.close(turnScope, Exit.void)));

			await runOnPostgres(world.projectComputers.renew(TURN).pipe(Scope.provide(turnScope)));
			await refreshing.started(1);
			const runningWhileHeld = fibersRunningIn(turnScope);
			refreshing.release();
			await refreshed;

			// The expiring computer's refresh, held at its provider, and nothing for the durable one, now or later.
			expect(runningWhileHeld).toBe(1);
			const tokensGiven = (id: Computers.ComputerId) =>
				world.provider
					.computers()
					.find((held) => held.id === id)
					?.networks.map(({ credentials }) =>
						credentials.map(({ value }) => Redacted.value(value)),
					);
			expect(tokensGiven(durableComputer.computer.id)).toEqual([["Bearer durable at opening"]]);
			expect(tokensGiven(expiringComputer.computer.id)).toEqual([
				["Bearer expiring at opening"],
				["Bearer expiring renewed"],
			]);
		});

		it("gives the computer the project's sign-in when it opens, and none when the project has none", async () => {
			const world = await startWorld();
			const signedIn = await world.addProject("signed-in");
			world.signInAs(signedInUntil("Bearer at opening", "2 hours"), signedIn);

			await world.open(TURN, signedIn);
			await world.open(TURN, world.project);

			const credentialsGiven = world.provider.computers().map(({ spec, networks }) => ({
				project: spec.labels["sugabots.project"],
				tokens: networks.flatMap(({ credentials }) =>
					credentials.map(({ value }) => Redacted.value(value)),
				),
			}));
			expect(credentialsGiven).toEqual([
				{ project: signedIn.projectId, tokens: ["Bearer at opening"] },
				{ project: world.project.projectId, tokens: [] },
			]);
		});
	});
});
