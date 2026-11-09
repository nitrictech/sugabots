import { execFileSync } from "node:child_process";
import { SANDBOX_OPENSANDBOX_DEFAULT_SIZE } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { DateTime, type Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	pod,
	sandbox,
	sandboxLease,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Ids } from "../ids/ids.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { PodSandboxes } from "./pod-sandboxes.ts";
import { SandboxCredentials } from "./sandbox-credentials.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

/**
 * A pod's one sandbox, against Postgres and a real OpenSandbox server
 * (`docker compose --profile sandboxes up -d`, with OPENSANDBOX_URL and
 * OPENSANDBOX_API_KEY set). OpenSandbox runs on the local Docker, which the
 * tests stop containers through, as a host shutting down would.
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;
const IMAGE = "debian:bookworm-slim";
const HOLDER: PodSandboxes.Holder = { kind: "turn", id: "turn-under-test" };

describe.skipIf(!configured)("pod sandboxes, against Postgres and OpenSandbox", () => {
	const connection: Sandboxes.OpenSandboxConnection = {
		provider: "opensandbox",
		baseUrl: env.OPENSANDBOX_URL ?? "",
		apiKey: Redacted.make(env.OPENSANDBOX_API_KEY ?? ""),
		image: IMAGE,
		size: SANDBOX_OPENSANDBOX_DEFAULT_SIZE,
		networkMode: "allowlist",
	};
	let podSandboxes: PodSandboxes.Interface;
	// What the pod's sandbox is signed in with, and how often it was asked.
	let signedIn: SandboxCredentials.SignedIn = SandboxCredentials.NOT_SIGNED_IN;
	let signIns = 0;
	let registryAnswers = true;
	let providers: SandboxProviderRepository.Interface;
	let direct: Sandboxes.Provider;
	let thePod: PodSandboxes.Pod;
	let ownerId: string;
	const made: Sandboxes.SandboxId[] = [];

	beforeAll(async () => {
		[podSandboxes, providers] = await runOnPostgres(
			Effect.all([PodSandboxes.Service, SandboxProviderRepository.Service]).pipe(
				Effect.provide(Layer.merge(PodSandboxes.layer, SandboxProviderRepository.layer)),
				Effect.provide([
					Layer.succeed(SandboxCredentials.Service, {
						forPod: () =>
							Effect.sync(() => {
								signIns += 1;
								return signedIn;
							}),
					}),
					// Docker Hub is asked what the images' tags name, as in production,
					// unless a test makes it unreachable, as a private registry is.
					unimplemented(Egress.Service, {
						providers: {
							for: () =>
								((...request: Parameters<typeof fetch>) =>
									registryAnswers
										? fetch(...request)
										: Promise.reject(new Error("registry unreachable"))) as typeof fetch,
						},
					}),
				]),
			),
		);
		direct = await Effect.runPromise(
			Effect.map(Sandboxes.Service, (sandboxes) => sandboxes.forConnection(connection)).pipe(
				Effect.provide(Sandboxes.layer.pipe(Layer.provide(Ids.layer))),
			),
		);
	});

	afterAll(async () => {
		for (const id of made) await Effect.runPromise(direct.destroy(id));
		await closeDatabase();
	}, SLOW);

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Sandbox ${suffix}`, slug: `sandbox-${suffix}` })
				.returning(),
		);
		const [owner] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `sandbox-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		ownerId = owner.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: owner.id }),
		);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: space.id,
					ownerId: owner.id,
					kind: "shared",
					name: "Builders",
					slug: `builders-${suffix}`,
					createdById: owner.id,
				})
				.returning(),
		);
		if (!shared) throw new Error("fixture");
		thePod = { workspaceId: space.id, podId: shared.id };
		signedIn = SandboxCredentials.NOT_SIGNED_IN;
		await addProvider();
	});

	/** An OpenSandbox provider for the pod's workspace, enabled, which disables any other. */
	const addProvider = () =>
		runOnPostgres(
			providers.create(thePod.workspaceId, {
				createdById: ownerId,
				provider: {
					settings: { preset: "opensandbox", serverUrl: connection.baseUrl, image: IMAGE },
					enabled: true,
					apiKey: Redacted.value(connection.apiKey),
				},
			}),
		);

	const enabledProvider = async () => {
		const provider = await runOnPostgres(providers.enabled(thePod.workspaceId));
		if (!provider) throw new Error("no enabled provider");
		return provider;
	};

	const open = async () => {
		const opened = await runOnPostgres(podSandboxes.open(thePod, await enabledProvider(), HOLDER));
		if (!made.includes(opened.sandbox.id)) made.push(opened.sandbox.id);
		return opened;
	};

	const missing = async (id: Sandboxes.SandboxId) =>
		(await Effect.runPromiseExit(direct.open(id))).toString().includes("SandboxMissing");

	const exec = async (sandbox: Sandboxes.Sandbox, command: string) =>
		Effect.runPromise(sandbox.exec(command, { timeout: "30 seconds", maxOutputCharacters: 2_000 }));

	/** Some work, with a folder `.gitignore` leaves out. */
	const writeWork = (sandbox: Sandboxes.Sandbox) =>
		exec(
			sandbox,
			"mkdir -p threads/t1/app/node_modules && echo kept > threads/t1/app/notes.md && echo ignored > threads/t1/app/node_modules/big.js && echo node_modules > threads/t1/app/.gitignore",
		);
	const readWork = async (sandbox: Sandboxes.Sandbox) => {
		const listed = await exec(
			sandbox,
			"cat threads/t1/app/notes.md threads/t1/app/node_modules/big.js 2>&1",
		);
		return listed.stdout.text;
	};

	it(
		"signs the pod's sandbox in when it opens, and again when a renewal finds that near expiry",
		async () => {
			const signedInUntil = (expiresIn: Duration.Input, version: string) => ({
				credentials: [
					{
						host: "github.com",
						pathPrefix: "/acme/",
						header: "Authorization",
						value: Redacted.make(`Bearer ${version}`),
					},
				],
				environment: { SIGNED_IN_AS: version },
				expiresAt: DateTime.addDuration(DateTime.nowUnsafe(), expiresIn),
			});
			const signedInAs = async (sandbox: Sandboxes.Sandbox) =>
				(await exec(sandbox, "bash -lc 'echo $SIGNED_IN_AS'")).stdout.text.trim();
			signedIn = signedInUntil("2 hours", "first");

			const { sandbox: opened } = await open();
			const asked = signIns;
			await runOnPostgres(podSandboxes.renew(HOLDER));
			const notYetDue = signIns - asked;
			signedIn = signedInUntil("5 minutes", "second");
			await open();
			signedIn = signedInUntil("2 hours", "third");
			await runOnPostgres(podSandboxes.renew(HOLDER));

			expect(notYetDue).toBe(0);
			expect(await signedInAs(opened)).toBe("third");
		},
		SLOW,
	);

	it(
		"makes the pod's sandbox on first use, and opens the same one after",
		async () => {
			const first = await open();
			const second = await open();

			expect(first.arrival).toBe("made");
			expect(second.arrival).toBe("running");
			expect(second.sandbox.id).toBe(first.sandbox.id);
		},
		SLOW,
	);

	it(
		"makes one sandbox when two turns open it at once",
		async () => {
			const [one, other] = await Promise.all([open(), open()]);

			expect(one.sandbox.id).toBe(other.sandbox.id);
		},
		SLOW,
	);

	it(
		"says a paused sandbox came back without its programs",
		async () => {
			const first = await open();
			await Effect.runPromise(direct.pause(first.sandbox.id));

			expect((await open()).arrival).toBe("rebooted");
		},
		SLOW,
	);

	it(
		"brings a sandbox that stopped for good back with its work",
		async () => {
			const first = await open();
			await writeWork(first.sandbox);
			await runOnPostgres(podSandboxes.release(HOLDER));
			execFileSync("docker", ["stop", `sandbox-${first.sandbox.id}`]);

			const back = await open();

			expect(back.arrival).toBe("rebooted");
			expect(back.sandbox.id).not.toBe(first.sandbox.id);
			expect(await readWork(back.sandbox)).toContain("kept");
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"replaces a sandbox the provider lost",
		async () => {
			const first = await open();
			await Effect.runPromise(direct.destroy(first.sandbox.id));
			const replaced = await open();

			expect(replaced.arrival).toBe("replaced");
			expect(replaced.sandbox.id).not.toBe(first.sandbox.id);
		},
		SLOW,
	);

	it(
		"moves the pod to a newly enabled provider, destroying its sandbox at the old one",
		async () => {
			const first = await open();
			await addProvider();
			const moved = await open();

			expect(moved.arrival).toBe("replaced");
			expect(moved.sandbox.id).not.toBe(first.sandbox.id);
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"destroys and forgets every sandbox a provider made",
		async () => {
			const first = await open();
			const provider = await enabledProvider();

			await runOnPostgres(podSandboxes.destroyAllMadeBy(thePod.workspaceId, provider));

			expect(await runOnPostgres(podSandboxes.anyMadeBy(thePod.workspaceId, provider.id))).toBe(
				false,
			);
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"lets a workspace with sandboxes be deleted",
		async () => {
			await open();

			await onDatabase((db) => db.delete(workspace).where(eq(workspace.id, thePod.workspaceId)));

			const left = await onDatabase((db) =>
				db.select().from(sandbox).where(eq(sandbox.workspaceId, thePod.workspaceId)),
			);
			expect(left).toHaveLength(0);
		},
		SLOW,
	);

	/** Makes the pod's sandbox look unused for longer than the idle window. */
	const idleForAnHour = () =>
		onDatabase((db) =>
			db
				.update(sandbox)
				.set({ lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) })
				.where(eq(sandbox.podId, thePod.podId)),
		);
	const pausedAt = async () =>
		(
			await onDatabase((db) =>
				db
					.select({ pausedAt: sandbox.pausedAt })
					.from(sandbox)
					.where(eq(sandbox.podId, thePod.podId)),
			)
		)[0]?.pausedAt;

	it(
		"never pauses a sandbox a turn holds",
		async () => {
			await open();
			await idleForAnHour();

			await runOnPostgres(podSandboxes.pauseIdle);

			expect(await pausedAt()).toBeNull();
		},
		SLOW,
	);

	it(
		"pauses a sandbox once its turns have let go and it has sat idle, and resumes it on next use",
		async () => {
			const first = await open();
			await runOnPostgres(podSandboxes.release(HOLDER));
			await idleForAnHour();

			await runOnPostgres(podSandboxes.pauseIdle);

			expect(await pausedAt()).toBeInstanceOf(Date);
			const reopened = await open();
			expect(reopened.sandbox.id).toBe(first.sandbox.id);
			expect(reopened.arrival).toBe("rebooted");
			expect(await pausedAt()).toBeNull();
		},
		SLOW,
	);

	const measuredDisk = () => runOnPostgres(podSandboxes.diskOf(thePod));

	it(
		"measures a running sandbox's disk, and what each bot's home, the threads and /tmp take of it",
		async () => {
			const agentId = crypto.randomUUID();
			const { sandbox: opened } = await open();
			await exec(
				opened,
				[
					`mkdir -p agents/${agentId} threads/t1`,
					`head -c 3000000 /dev/zero > agents/${agentId}/cache`,
					"head -c 2000000 /dev/zero > threads/t1/clone",
					"head -c 1000000 /dev/zero > /tmp/download",
				].join(" && "),
			);

			await runOnPostgres(podSandboxes.measureDisks);

			const disk = await measuredDisk();
			expect(disk?.usedBytes).toBeGreaterThan(0);
			expect(disk?.totalBytes).toBeGreaterThanOrEqual(disk?.usedBytes ?? 0);
			const sized = (kind: string) => disk?.folders?.find((folder) => folder.kind === kind);
			expect(sized("home")).toMatchObject({ agentId, bytes: expect.any(Number) });
			expect(sized("home")?.bytes).toBeGreaterThanOrEqual(3_000_000);
			expect(sized("threads")?.bytes).toBeGreaterThanOrEqual(2_000_000);
			expect(sized("temporary")?.bytes).toBeGreaterThanOrEqual(1_000_000);
		},
		SLOW,
	);

	it(
		"measures a sandbox again while it's in use, and stops once nobody has used it since",
		async () => {
			const measuredAgo = (minutes: number) =>
				onDatabase((db) =>
					db
						.update(sandbox)
						.set({ diskMeasuredAt: new Date(Date.now() - minutes * 60 * 1000) })
						.where(eq(sandbox.podId, thePod.podId)),
				);
			// open() holds a lease until release(HOLDER): the sandbox is in use.
			await open();
			await runOnPostgres(podSandboxes.measureDisks);
			await measuredAgo(60);

			await runOnPostgres(podSandboxes.measureDisks);
			const whileInUse = (await measuredDisk())?.measuredAt;

			await runOnPostgres(podSandboxes.release(HOLDER));
			await idleForAnHour();
			await measuredAgo(30);
			const beforeIdleSweep = (await measuredDisk())?.measuredAt;
			await runOnPostgres(podSandboxes.measureDisks);

			expect(whileInUse?.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
			expect((await measuredDisk())?.measuredAt).toEqual(beforeIdleSweep);
		},
		SLOW,
	);

	it(
		"leaves a paused sandbox paused, with its last measurement",
		async () => {
			await open();
			await runOnPostgres(podSandboxes.measureDisks);
			const before = await measuredDisk();
			await runOnPostgres(podSandboxes.release(HOLDER));
			await idleForAnHour();
			await runOnPostgres(podSandboxes.pauseIdle);
			await onDatabase((db) =>
				db
					.update(sandbox)
					.set({ diskMeasuredAt: new Date(Date.now() - 60 * 60 * 1000) })
					.where(eq(sandbox.podId, thePod.podId)),
			);

			await runOnPostgres(podSandboxes.measureDisks);

			expect(await pausedAt()).toBeInstanceOf(Date);
			expect((await measuredDisk())?.usedBytes).toBe(before?.usedBytes);
		},
		SLOW,
	);

	it(
		"treats a lease that wasn't renewed as let go",
		async () => {
			await open();
			await onDatabase((db) =>
				db.update(sandboxLease).set({ expiresAt: new Date(Date.now() - 1000) }),
			);
			await idleForAnHour();

			await runOnPostgres(podSandboxes.pauseIdle);

			expect(await pausedAt()).toBeInstanceOf(Date);
		},
		SLOW,
	);

	/** Changes the provider's image, as a workspace admin would, or as a release moves its tag. */
	const changeImage = async (image: string) =>
		runOnPostgres(
			providers.update(thePod.workspaceId, (await enabledProvider()).id, {
				settings: { preset: "opensandbox", serverUrl: connection.baseUrl, image },
			}),
		);
	const recorded = async () =>
		(
			await onDatabase((db) =>
				db
					.select({ providerSandboxId: sandbox.providerSandboxId, image: sandbox.image })
					.from(sandbox)
					.where(eq(sandbox.podId, thePod.podId)),
			)
		)[0];

	it(
		"makes the sandbox from the digest its image's tag names, not what the host last pulled",
		async () => {
			await open();

			expect((await recorded())?.image).toMatch(/^debian@sha256:[0-9a-f]{64}$/);
		},
		SLOW,
	);

	it(
		"upgrades a sandbox nobody has used for a while to the provider's image, keeping its work, and leaves it paused",
		async () => {
			const first = await open();
			await writeWork(first.sandbox);
			await runOnPostgres(podSandboxes.release(HOLDER));
			await changeImage("python:3.13-slim");
			await idleForAnHour();

			await runOnPostgres(podSandboxes.upgradeIdle);

			const after = await recorded();
			expect(after?.image).toMatch(/^python@sha256:/);
			expect(after?.providerSandboxId).not.toBe(first.sandbox.id);
			expect(await pausedAt()).toBeInstanceOf(Date);
			expect(await missing(first.sandbox.id)).toBe(true);
			const reopened = await open();
			expect(reopened.arrival).toBe("rebooted");
			expect(await readWork(reopened.sandbox)).toMatch(/kept[\s\S]*ignored/);
		},
		SLOW,
	);

	it(
		"leaves a sandbox on its image while a turn uses it",
		async () => {
			const first = await open();
			await changeImage("python:3.13-slim");
			await idleForAnHour();

			await runOnPostgres(podSandboxes.upgradeIdle);

			expect((await recorded())?.providerSandboxId).toBe(first.sandbox.id);
		},
		SLOW,
	);

	it(
		"when the registry won't say what a tag names, keeps a sandbox on it and upgrades only to another image",
		async () => {
			// Named in full, they are the same images to Docker, but new to the
			// service, which remembers what registries said of the short names.
			const debian = "docker.io/library/debian:bookworm-slim";
			const python = "docker.io/library/python:3.13-slim";
			registryAnswers = false;
			try {
				await changeImage(debian);
				const first = await open();
				await runOnPostgres(podSandboxes.release(HOLDER));
				await idleForAnHour();

				await runOnPostgres(podSandboxes.upgradeIdle);
				const status = await runOnPostgres(podSandboxes.status(thePod, await enabledProvider()));
				const onItsTag = await recorded();
				await changeImage(python);
				await idleForAnHour();
				await runOnPostgres(podSandboxes.upgradeIdle);

				expect(onItsTag).toEqual({ providerSandboxId: first.sandbox.id, image: debian });
				expect(status.kind === "present" && status.upgradeAvailable).toBe(false);
				expect((await recorded())?.image).toBe(python);
			} finally {
				registryAnswers = true;
			}
		},
		SLOW,
	);

	it(
		"reports the pod's sandbox, and when the provider would make it from another image",
		async () => {
			expect((await runOnPostgres(podSandboxes.status(thePod, await enabledProvider()))).kind).toBe(
				"none",
			);
			await open();
			const provider = await enabledProvider();
			const now = await runOnPostgres(podSandboxes.status(thePod, provider));
			await runOnPostgres(
				providers.update(thePod.workspaceId, provider.id, {
					settings: {
						preset: "opensandbox",
						serverUrl: connection.baseUrl,
						image: "python:3.13-slim",
					},
				}),
			);
			const later = await runOnPostgres(podSandboxes.status(thePod, await enabledProvider()));

			expect(now).toMatchObject({ kind: "present", state: "running", turnsUsing: 1 });
			expect(now.kind === "present" && now.image).toMatch(/^debian@sha256:/);
			expect(now.kind === "present" && now.upgradeAvailable).toBe(false);
			expect(later.kind === "present" && later.upgradeAvailable).toBe(true);
		},
		SLOW,
	);

	it(
		"won't reset a sandbox a turn is using, and resets it once the turn lets go",
		async () => {
			const first = await open();

			const refused = await runOnPostgres(Effect.exit(podSandboxes.reset(thePod)));
			await runOnPostgres(podSandboxes.release(HOLDER));
			await runOnPostgres(podSandboxes.reset(thePod));

			expect(refused.toString()).toContain("SandboxInUse");
			expect((await runOnPostgres(podSandboxes.status(thePod, undefined))).kind).toBe("none");
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"upgrades to a new image keeping all of the work",
		async () => {
			const first = await open();
			await writeWork(first.sandbox);
			await runOnPostgres(podSandboxes.release(HOLDER));
			const provider = await enabledProvider();
			await runOnPostgres(
				providers.update(thePod.workspaceId, provider.id, {
					settings: {
						preset: "opensandbox",
						serverUrl: connection.baseUrl,
						image: "python:3.13-slim",
					},
				}),
			);

			await runOnPostgres(podSandboxes.upgrade(thePod, await enabledProvider()));
			const upgraded = await open();

			expect(upgraded.sandbox.id).not.toBe(first.sandbox.id);
			expect(upgraded.arrival).toBe("running");
			expect(await readWork(upgraded.sandbox)).toMatch(/kept[\s\S]*ignored/);
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"finishes an upgrade whose caller goes away part-way, leaving no sandbox behind",
		async () => {
			const first = await open();
			await runOnPostgres(podSandboxes.release(HOLDER));
			const provider = await enabledProvider();

			// Long enough to be making the new sandbox, too short for it to be ready.
			await runOnPostgres(
				Effect.gen(function* () {
					const upgrading = yield* Effect.forkChild(podSandboxes.upgrade(thePod, provider));
					yield* Effect.sleep("500 millis");
					yield* Fiber.interrupt(upgrading);
				}),
			);
			const reopened = await open();

			expect(reopened.sandbox.id).not.toBe(first.sandbox.id);
			expect(reopened.arrival).toBe("running");
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);

	it(
		// Both providers here are the one server, which keeps the work on one
		// volume, so this shows the move rather than what the copy leaves out.
		"upgrades to another provider with the work copied across",
		async () => {
			const first = await open();
			await writeWork(first.sandbox);
			await runOnPostgres(podSandboxes.release(HOLDER));
			await addProvider();

			await runOnPostgres(podSandboxes.upgrade(thePod, await enabledProvider()));
			const upgraded = await open();

			expect(upgraded.sandbox.id).not.toBe(first.sandbox.id);
			expect(upgraded.arrival).toBe("running");
			expect(await readWork(upgraded.sandbox)).toContain("kept");
			expect(await missing(first.sandbox.id)).toBe(true);
		},
		SLOW,
	);
});
