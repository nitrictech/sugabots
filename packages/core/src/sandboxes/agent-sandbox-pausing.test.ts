import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../database/database.ts";
import { agent, sandbox, user, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { AgentSandboxes } from "./agent-sandboxes.ts";
import { SandboxCredentials } from "./sandbox-credentials.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

/**
 * Whether the idle sweep can still pause a bot's computer after it was woken
 * by something that didn't finish, against Postgres and an in-memory provider
 * whose resumes and pauses a case can hold part-way. Skips without a database.
 */
const HOLDER: AgentSandboxes.Holder = { kind: "turn", id: "turn-under-test" };

describe.skipIf(!process.env.DATABASE_URL)("pausing bots' computers, against Postgres", () => {
	// Every sandbox the provider has, and whether it runs.
	const atProvider = new Map<string, "running" | "paused">();
	let nextId = 0;
	let resuming: Held | undefined;
	let pausing: Held | undefined;
	// Called after each query the service runs, so a case can tell when one has.
	let afterQuery: (() => void) | undefined;

	const fakeSandbox = (id: Sandboxes.SandboxId): Sandboxes.Sandbox => ({
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
	const fakeProvider: Sandboxes.Provider = {
		capabilities: { pauseKeeps: "disk", credentials: "host-and-path", blocksHosts: true },
		networkMode: "open",
		check: Effect.void,
		create: () =>
			Effect.sync(() => {
				const id = Sandboxes.SandboxId(`fake-${++nextId}`);
				atProvider.set(id, "running");
				return fakeSandbox(id);
			}),
		open: (id) =>
			Effect.promise(async () => {
				const resumed = atProvider.get(id) === "paused";
				if (resumed) {
					await resuming?.wait();
					atProvider.set(id, "running");
				}
				return { sandbox: fakeSandbox(id), resumed };
			}),
		info: (id) =>
			Effect.succeed({
				state: atProvider.get(id) ?? "running",
				image: "debian",
				workKeptApart: false,
			}),
		pause: (id) =>
			Effect.promise(async () => {
				await pausing?.wait();
				atProvider.set(id, "paused");
			}),
		destroy: (id) => Effect.sync(() => void atProvider.delete(id)),
	};

	let agentSandboxes: AgentSandboxes.Interface;
	let providers: SandboxProviderRepository.Interface;
	let theBot: AgentSandboxes.Agent;

	beforeAll(async () => {
		[agentSandboxes, providers] = await runOnPostgres(
			Effect.all([AgentSandboxes.Service, SandboxProviderRepository.Service]).pipe(
				Effect.provide(
					Layer.merge(
						AgentSandboxes.layerNoDeps.pipe(
							Layer.provide([
								Layer.succeed(Sandboxes.Service, { forConnection: () => fakeProvider }),
								SandboxProviderRepository.layer,
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
						SandboxProviderRepository.layer,
					),
				),
				Effect.provide([SandboxCredentials.none, unimplemented(Egress.Service, {})]),
			),
		);
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
		const [bot] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId: space.id,
					name: "Builder",
					handle: "builder",
					color: "sky",
					face: "pill",
					usesSandbox: true,
				})
				.returning(),
		);
		if (!bot) throw new Error("fixture");
		theBot = { workspaceId: space.id, agentId: bot.id };
		await runOnPostgres(
			providers.create(theBot.workspaceId, {
				createdById: owner.id,
				provider: {
					// The fake stands in for whatever the settings name.
					settings: { preset: "opensandbox", serverUrl: "http://sandboxes.test", image: "debian" },
					enabled: true,
					apiKey: "key",
				},
			}),
		);
	});

	const enabledProvider = async () => {
		const provider = await runOnPostgres(providers.enabled(theBot.workspaceId));
		if (!provider) throw new Error("no enabled provider");
		return provider;
	};
	const open = async () =>
		runOnPostgres(agentSandboxes.open(theBot, await enabledProvider(), HOLDER));
	const idleForAnHour = () =>
		onDatabase((db) =>
			db
				.update(sandbox)
				.set({ lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) })
				.where(eq(sandbox.agentId, theBot.agentId)),
		);
	/** Whether the provider and the bot's record agree the sandbox is paused. */
	const pausedEverywhere = async (id: Sandboxes.SandboxId) => {
		const [row] = await onDatabase((db) =>
			db.select().from(sandbox).where(eq(sandbox.agentId, theBot.agentId)),
		);
		return { atProvider: atProvider.get(id), recordedPaused: row?.pausedAt != null };
	};
	const PAUSED_EVERYWHERE = { atProvider: "paused", recordedPaused: true };
	/** A turn used the sandbox, let it go, and the idle sweep paused it. */
	const usedThenPaused = async () => {
		const { sandbox: opened } = await open();
		await runOnPostgres(agentSandboxes.release(HOLDER));
		await idleForAnHour();
		await runOnPostgres(agentSandboxes.pauseIdle);
		expect(await pausedEverywhere(opened.id)).toEqual(PAUSED_EVERYWHERE);
		return opened.id;
	};

	it("pauses again a sandbox whose turn was stopped while it was resuming", async () => {
		const id = await usedThenPaused();
		const resume = held();
		resuming = resume;
		const provider = await enabledProvider();

		await runOnPostgres(
			Effect.gen(function* () {
				const opening = yield* Effect.forkChild(agentSandboxes.open(theBot, provider, HOLDER));
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
		await runOnPostgres(agentSandboxes.pauseIdle);

		expect(await pausedEverywhere(id)).toEqual(PAUSED_EVERYWHERE);
	});

	it("pauses again a sandbox an upgrade resumed to copy its work, then failed", async () => {
		const id = await usedThenPaused();

		const failed = await runOnPostgres(
			Effect.exit(agentSandboxes.upgrade(theBot, await enabledProvider())),
		);
		await idleForAnHour();
		await runOnPostgres(agentSandboxes.pauseIdle);

		expect(failed.toString()).toContain("UpgradeFailed");
		expect(await pausedEverywhere(id)).toEqual(PAUSED_EVERYWHERE);
	});

	it("doesn't resume a sandbox to bring its network up to date as the sweep pauses it", async () => {
		const { sandbox: opened } = await open();
		await runOnPostgres(agentSandboxes.release(HOLDER));
		await idleForAnHour();
		const pause = held();
		pausing = pause;

		await runOnPostgres(
			Effect.gen(function* () {
				const sweeping = yield* Effect.forkChild(agentSandboxes.pauseIdle);
				yield* Effect.promise(() => pause.hasStarted);
				// An allowed host changes once the sweep holds the bot: the update's
				// first query finds the sandbox running, then it waits its turn for
				// the bot. Nothing else queries while the sweep is held.
				const found = Promise.withResolvers<void>();
				afterQuery = found.resolve;
				const updating = yield* Effect.forkChild(
					agentSandboxes.applyNetwork({ workspaceId: theBot.workspaceId, agentId: theBot.agentId }),
				);
				yield* Effect.promise(() => found.promise);
				yield* Effect.sync(pause.finish);
				yield* Fiber.join(sweeping);
				yield* Fiber.join(updating);
			}),
		);

		expect(await pausedEverywhere(opened.id)).toEqual(PAUSED_EVERYWHERE);
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
