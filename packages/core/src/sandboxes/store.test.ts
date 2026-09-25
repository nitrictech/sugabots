import { handleFromName } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chatStore } from "../conversations/chats/store.ts";
import { turnStore } from "../conversations/turns/store.ts";
import { createEventBus } from "../database/events/bus.ts";
import { eventPublisher } from "../database/events/publish.ts";
import { memoryEventStore } from "../database/events/store.ts";
import {
	agent,
	job,
	pod,
	podMember,
	podSandbox,
	sandboxLease,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../database/testing.ts";
import { Sandbox } from "./sandbox.ts";
import { type LeaseScope, podSandboxStore } from "./store.ts";

/** A provider that keeps its sandboxes in memory, and can be made to lose one. */
function fakeProvider() {
	const sandboxes = new Set<string>();
	const created: string[] = [];
	const destroyed: string[] = [];
	const paused = new Set<string>();
	const allowListsSet: Array<{ id: string; hosts: readonly string[] }> = [];
	const gitCredentialsSet: Array<Sandbox.GitCredentials | undefined> = [];
	const handle = (id: string): Sandbox.Handle => ({
		id,
		exec: () =>
			Effect.succeed({
				exitCode: 0,
				stdout: { text: "", droppedCharacters: 0 },
				stderr: { text: "", droppedCharacters: 0 },
			}),
		readFile: () => Effect.succeed(new Uint8Array()),
		writeFile: () => Effect.void,
		setGitCredentials: (credentials) =>
			Effect.sync(() => {
				gitCredentialsSet.push(credentials);
			}),
		setAllowedHosts: (hosts) =>
			Effect.sync(() => {
				allowListsSet.push({ id, hosts });
			}),
		disconnect: Effect.void,
	});
	const provider: Sandbox.Interface = {
		provider: "opensandbox",
		isolation: "gvisor",
		check: Effect.void,
		pauseKeeps: "filesystem",
		destroy: (id) =>
			sandboxes.delete(id)
				? Effect.sync(() => {
						destroyed.push(id);
					})
				: Effect.fail(new Sandbox.Missing({ provider: "opensandbox", sandboxId: id })),
		pause: (id) =>
			sandboxes.has(id)
				? Effect.sync(() => {
						paused.add(id);
					})
				: Effect.fail(new Sandbox.Missing({ provider: "opensandbox", sandboxId: id })),
		resume: (id) =>
			sandboxes.has(id)
				? Effect.sync(() => {
						paused.delete(id);
						return handle(id);
					})
				: Effect.fail(new Sandbox.Missing({ provider: "opensandbox", sandboxId: id })),
		create: () =>
			Effect.sync(() => {
				const id = crypto.randomUUID();
				sandboxes.add(id);
				created.push(id);
				return handle(id);
			}),
		connect: (id) =>
			sandboxes.has(id)
				? Effect.succeed(handle(id))
				: Effect.fail(new Sandbox.Missing({ provider: "opensandbox", sandboxId: id })),
	};
	return {
		provider,
		created,
		destroyed,
		paused,
		allowListsSet,
		gitCredentialsSet,
		lose: (id: string) => sandboxes.delete(id),
	};
}

describe.skipIf(!process.env.DATABASE_URL)("pod sandboxes, against Postgres", () => {
	const publishEvents = eventPublisher(createEventBus({ store: memoryEventStore() }));
	const chats = onPostgres(chatStore(publishEvents));
	const turns = onPostgres(turnStore(publishEvents));
	let fake: ReturnType<typeof fakeProvider>;
	let store: ReturnType<typeof podSandboxStore>;
	let scope: LeaseScope;
	/** The workspace's provider as a turn would find it: undefined when switched off. */
	let configured: Sandbox.Connection | undefined;

	const connection = (isolation: Sandbox.Isolation = "gvisor"): Sandbox.Connection => ({
		preset: "opensandbox",
		baseUrl: "http://127.0.0.1:8090",
		apiKey: "key",
		image: "node:22-bookworm",
		isolation,
		allowedHosts: { kind: "any" },
		configurationUpdatedAt: new Date(),
	});

	const storeFor = (allowsUnisolated: boolean) =>
		podSandboxStore({
			providers: {
				resolve: () => Effect.succeed(configured),
				connection: () => Effect.succeed(configured),
			},
			allowsUnisolated,
			publishEvents,
			providerFor: () => fake.provider,
		});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		fake = fakeProvider();
		configured = connection();
		store = storeFor(false);
		scope = await podWithTurn();
	});

	/** A pod whose agent has a turn in progress, which is what a lease belongs to. */
	async function podWithTurn(): Promise<LeaseScope> {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Sandboxes ${suffix}`, slug: `sandboxes-${suffix}` })
				.returning(),
		);
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `sandboxes-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !member) throw new Error("fixture");
		await onDatabase((db) =>
			db
				.insert(workspaceMember)
				.values({ workspaceId: space.id, userId: member.id, role: "admin" }),
		);
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: space.id,
					kind: "shared",
					name: "Room",
					slug: `room-${suffix}`,
					createdById: member.id,
				})
				.returning(),
		);
		if (!room) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId: space.id, podId: room.id, userId: member.id }),
		);
		const [host] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId: space.id,
					podId: room.id,
					name: `Builder ${suffix}`,
					handle: handleFromName(`Builder ${suffix}`),
					hue: 1,
					face: "bar",
					model: "m",
					sandboxEnabled: true,
					createdById: member.id,
				})
				.returning({ id: agent.id }),
		);
		if (!host) throw new Error("fixture");
		const opened = await chats.getOrCreate({
			workspaceId: space.id,
			podId: room.id,
			hostAgentId: host.id,
			userId: member.id,
		});
		await chats.sendMain({
			chatId: opened.id,
			userId: member.id,
			messageId: crypto.randomUUID(),
			content: "Run the tests.",
		});
		const [queued] = await onDatabase((db) =>
			db
				.select()
				.from(job)
				.where(and(eq(job.threadId, opened.mainThreadId), eq(job.status, "queued"))),
		);
		if (!queued || !("agentId" in queued.payload && "triggerMessageId" in queued.payload))
			throw new Error("no turn queued");
		await onDatabase((db) =>
			db.update(job).set({ status: "running", attempts: 1 }).where(eq(job.id, queued.id)),
		);
		const prepared = await turns.prepare({
			id: queued.id,
			threadId: opened.mainThreadId,
			payload: queued.payload,
			dedupeKey: queued.dedupeKey,
			attempts: 1,
		});
		return { workspaceId: space.id, podId: room.id, turnId: prepared.turnId };
	}

	const lease = (leaseScope: LeaseScope = scope) => runOnPostgres(store.lease(leaseScope));
	const failedLease = () => runOnPostgres(Effect.flip(store.lease(scope)));

	it("makes the pod's sandbox on first use and reaches the same one after", async () => {
		const first = await lease();
		await runOnPostgres(store.release(first.leaseId));
		const second = await lease();

		expect(fake.created).toHaveLength(1);
		expect(second.sandbox.id).toBe(first.sandbox.id);
	});

	it("makes one sandbox when two turns in the pod need it at once", async () => {
		const [one, other] = await Promise.all([lease(), lease()]);

		expect(fake.created).toHaveLength(1);
		expect(other.sandbox.id).toBe(one.sandbox.id);
	});

	it("gives each pod its own sandbox", async () => {
		const elsewhere = await podWithTurn();
		const here = await lease();
		const there = await lease(elsewhere);

		expect(there.sandbox.id).not.toBe(here.sandbox.id);
	});

	it("reports a sandbox the provider lost, and does not make a new one", async () => {
		const first = await lease();
		await runOnPostgres(store.release(first.leaseId));
		fake.lose(first.sandbox.id);

		expect(await failedLease()).toMatchObject({ _tag: "SandboxLost", podId: scope.podId });
		expect(await failedLease()).toMatchObject({ _tag: "SandboxLost" });
		expect(fake.created).toHaveLength(1);
		const [row] = await onDatabase((db) =>
			db.select().from(podSandbox).where(eq(podSandbox.podId, scope.podId)),
		);
		expect(row?.status).toBe("missing");
	});

	it("refuses a lease while the workspace's provider is switched off", async () => {
		configured = undefined;

		expect(await runOnPostgres(store.offered(scope.workspaceId))).toBe(false);
		expect(await failedLease()).toMatchObject({ _tag: "SandboxProviderUnavailable" });
		expect(fake.created).toHaveLength(0);
	});

	it("offers unisolated sandboxes only where the installation allows them", async () => {
		configured = connection("container");

		expect(await runOnPostgres(store.offered(scope.workspaceId))).toBe(false);
		expect(await runOnPostgres(storeFor(true).offered(scope.workspaceId))).toBe(true);
	});

	it("reports whether the pod's sandbox is in use, and by whom", async () => {
		expect(await runOnPostgres(store.status(scope.podId))).toMatchObject({ state: "none" });

		const held = await lease();
		const inUse = await runOnPostgres(store.status(scope.podId));
		expect(inUse.state).toBe("in_use");
		expect(inUse.usedBy).toHaveLength(1);
		expect(inUse.usedBy[0]?.handle).toMatch(/^builder-/);

		await runOnPostgres(store.release(held.leaseId));
		expect(await runOnPostgres(store.status(scope.podId))).toMatchObject({
			state: "idle",
			usedBy: [],
		});
	});

	/** Makes the pod's sandbox and lets it go, as a turn that used it would. */
	async function usedOnce() {
		const held = await lease();
		await runOnPostgres(store.release(held.leaseId));
		return held.sandbox.id;
	}

	it("pauses a sandbox nobody has used for the idle time, and wakes it for the next lease", async () => {
		const id = await usedOnce();
		expect(await runOnPostgres(store.pauseIdle(3_600))).toBe(0);

		await runOnPostgres(store.pauseIdle(0));
		expect(fake.paused.has(id)).toBe(true);
		expect(await runOnPostgres(store.status(scope.podId))).toMatchObject({ state: "paused" });

		const woken = await lease();
		expect(woken.sandbox.id).toBe(id);
		expect(woken.resumedAfterPause).toBe("filesystem");
		expect(fake.paused.has(id)).toBe(false);
		expect(await runOnPostgres(store.status(scope.podId))).toMatchObject({ state: "in_use" });
	});

	it("leaves a sandbox alone while a turn holds a lease on it", async () => {
		const id = await usedOnce();
		await lease();

		expect(await runOnPostgres(store.pauseIdle(0))).toBe(0);
		expect(fake.paused.has(id)).toBe(false);
	});

	it("does not say a sandbox was resumed when it was never paused", async () => {
		await usedOnce();

		expect((await lease()).resumedAfterPause).toBeUndefined();
	});

	it("gives running sandboxes a changed allow list", async () => {
		const id = await usedOnce();
		configured = { ...connection(), allowedHosts: { kind: "only", hosts: ["example.com"] } };

		expect(await runOnPostgres(store.applyAllowedHosts(scope.workspaceId))).toEqual({
			applied: 1,
			notApplied: 0,
		});
		expect(fake.allowListsSet).toContainEqual({ id, hosts: ["example.com"] });
	});

	it("leaves a change to anywhere for new sandboxes", async () => {
		await usedOnce();
		configured = { ...connection(), allowedHosts: { kind: "any" } };

		expect(await runOnPostgres(store.applyAllowedHosts(scope.workspaceId))).toEqual({
			applied: 0,
			notApplied: 1,
		});
		expect(fake.allowListsSet).toHaveLength(0);
	});

	it("gives a paused sandbox the current allow list when it wakes", async () => {
		const id = await usedOnce();
		await runOnPostgres(store.pauseIdle(0));
		configured = { ...connection(), allowedHosts: { kind: "only", hosts: ["pypi.org"] } };

		await lease();
		expect(fake.allowListsSet).toContainEqual({ id, hosts: ["pypi.org"] });
	});

	it("throws a sandbox away, so the pod's next lease makes a new one", async () => {
		const first = await usedOnce();

		expect(await runOnPostgres(store.discard(scope.podId))).toBe(true);
		expect(fake.destroyed).toEqual([first]);
		expect(await runOnPostgres(store.status(scope.podId))).toMatchObject({ state: "none" });

		const next = await lease();
		expect(next.sandbox.id).not.toBe(first);
	});

	it("starts again after a lost sandbox", async () => {
		const first = await usedOnce();
		fake.lose(first);
		await failedLease();

		expect(await runOnPostgres(store.discard(scope.podId))).toBe(true);
		expect((await lease()).sandbox.id).not.toBe(first);
	});

	it("gives the sandbox the pod's git credentials on every lease", async () => {
		const git = {
			host: "github.com",
			username: "x-access-token",
			token: "t",
			repositories: ["acme/app"],
		};
		const withGit = podSandboxStore({
			providers: {
				resolve: () => Effect.succeed(configured),
				connection: () => Effect.succeed(configured),
			},
			allowsUnisolated: false,
			publishEvents,
			providerFor: () => fake.provider,
			gitCredentialsFor: () => Effect.succeed(git),
		});
		const first = await runOnPostgres(withGit.lease(scope));
		await runOnPostgres(withGit.release(first.leaseId));
		await runOnPostgres(withGit.lease(scope));

		expect(fake.gitCredentialsSet).toEqual([git, git]);
	});

	it("ends the lease on release and notes when the sandbox was last in use", async () => {
		const held = await lease();
		await runOnPostgres(store.release(held.leaseId));

		const leases = await onDatabase((db) =>
			db.select().from(sandboxLease).where(eq(sandboxLease.id, held.leaseId)),
		);
		const [row] = await onDatabase((db) =>
			db.select().from(podSandbox).where(eq(podSandbox.podId, scope.podId)),
		);
		expect(leases).toHaveLength(0);
		expect(row?.lastLeaseEndedAt).toBeInstanceOf(Date);
	});

	it("pushes a lease's expiry out when it is renewed", async () => {
		const held = await lease();
		await onDatabase((db) =>
			db
				.update(sandboxLease)
				.set({ expiresAt: new Date(Date.now() + 1_000) })
				.where(eq(sandboxLease.id, held.leaseId)),
		);
		await runOnPostgres(store.renew(held.leaseId));

		const [renewed] = await onDatabase((db) =>
			db.select().from(sandboxLease).where(eq(sandboxLease.id, held.leaseId)),
		);
		expect(renewed?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
	});
});
