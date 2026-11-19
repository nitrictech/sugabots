import { execFileSync } from "node:child_process";
import { ConnectionConfig, SandboxManager } from "@alibaba-group/opensandbox";
import { COMPUTER_OPENSANDBOX_DEFAULT_SIZE } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { DateTime, type Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	computer,
	computerLease,
	project as projectTable,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Ids } from "../ids/ids.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { ComputerCredentials } from "./computer-credentials.ts";
import { ComputerProviderRepository } from "./computer-provider-repository.ts";
import { Computers } from "./computers.ts";
import { ProjectComputers } from "./project-computers.ts";
import { recordingIds, removeWorkVolumes } from "./testing.ts";

/**
 * A project's one computer, against Postgres and a real OpenSandbox server
 * (`docker compose --profile computers up -d`, with OPENSANDBOX_URL and
 * OPENSANDBOX_API_KEY set). OpenSandbox runs on the local Docker, which the
 * tests stop containers through, as a host shutting down would.
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;
const IMAGE = "debian:bookworm-slim";
const HOLDER: ProjectComputers.Holder = { kind: "turn", id: "turn-under-test" };

describe.skipIf(!configured)("bots' computers, against Postgres and OpenSandbox", () => {
	const connection: Computers.OpenSandboxConnection = {
		provider: "opensandbox",
		baseUrl: env.OPENSANDBOX_URL ?? "",
		apiKey: Redacted.make(env.OPENSANDBOX_API_KEY ?? ""),
		image: IMAGE,
		size: COMPUTER_OPENSANDBOX_DEFAULT_SIZE,
		networkMode: "allowlist",
	};
	let projectComputers: ProjectComputers.Interface;
	// What the project's computer is signed in with, and how often it was asked.
	let signedIn: ComputerCredentials.SignedIn = ComputerCredentials.NOT_SIGNED_IN;
	let signIns = 0;
	let registryAnswers = true;
	let providers: ComputerProviderRepository.Interface;
	let direct: Computers.Provider;
	let theProject: ProjectComputers.Project;
	let ownerId: string;
	const idsHandedOut = new Set<string>();

	beforeAll(async () => {
		[projectComputers, providers] = await runOnPostgres(
			Effect.all([ProjectComputers.Service, ComputerProviderRepository.Service]).pipe(
				Effect.provide(Layer.merge(ProjectComputers.layer, ComputerProviderRepository.layer)),
				Effect.provide([
					Layer.succeed(ComputerCredentials.Service, {
						forProject: () =>
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
					recordingIds(idsHandedOut),
				]),
			),
		);
		direct = await Effect.runPromise(
			Effect.map(Computers.Service, (computers) => computers.forConnection(connection)).pipe(
				Effect.provide(Computers.layer.pipe(Layer.provide(Ids.layer))),
			),
		);
	});

	// Found by the workspace's label rather than its records, so a computer no
	// record names any more, such as a deleted workspace's, is destroyed too.
	afterEach(async () => {
		const server = SandboxManager.create({
			connectionConfig: new ConnectionConfig({
				domain: connection.baseUrl,
				apiKey: Redacted.value(connection.apiKey),
			}),
		});
		const { items } = await server.listSandboxInfos({
			metadata: { "sugabots.workspace": theProject.workspaceId },
		});
		for (const { id } of items) {
			await Effect.runPromise(direct.destroy(Computers.ComputerId(id)));
		}
	}, SLOW);

	afterAll(async () => {
		await closeDatabase();
		removeWorkVolumes(idsHandedOut);
	}, SLOW);

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Computer ${suffix}`, slug: `computer-${suffix}` })
				.returning(),
		);
		const [owner] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `computer-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		ownerId = owner.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: owner.id }),
		);
		const [made] = await onDatabase((db) =>
			db
				.insert(projectTable)
				.values({ workspaceId: space.id, name: "Launch", slug: "launch" })
				.returning(),
		);
		if (!made) throw new Error("fixture");
		theProject = { workspaceId: space.id, projectId: made.id };
		signedIn = ComputerCredentials.NOT_SIGNED_IN;
		await addProvider();
	});

	/** An OpenSandbox provider for the project's workspace, enabled, which disables any other. */
	const addProvider = () =>
		runOnPostgres(
			providers.create(theProject.workspaceId, {
				createdById: ownerId,
				provider: {
					settings: { preset: "opensandbox", serverUrl: connection.baseUrl, image: IMAGE },
					enabled: true,
					apiKey: Redacted.value(connection.apiKey),
				},
			}),
		);

	const enabledProvider = async () => {
		const provider = await runOnPostgres(providers.enabled(theProject.workspaceId));
		if (!provider) throw new Error("no enabled provider");
		return provider;
	};

	const open = async () =>
		runOnPostgres(projectComputers.open(theProject, await enabledProvider(), HOLDER));

	const missing = async (id: Computers.ComputerId) =>
		(await Effect.runPromiseExit(direct.open(id))).toString().includes("ComputerMissing");

	const exec = async (computer: Computers.Computer, command: string) =>
		Effect.runPromise(
			computer.exec(command, { timeout: "30 seconds", maxOutputCharacters: 2_000 }),
		);

	/** Some work, with a folder `.gitignore` leaves out. */
	const writeWork = (computer: Computers.Computer) =>
		exec(
			computer,
			"mkdir -p threads/t1/app/node_modules && echo kept > threads/t1/app/notes.md && echo ignored > threads/t1/app/node_modules/big.js && echo node_modules > threads/t1/app/.gitignore",
		);
	const readWork = async (computer: Computers.Computer) => {
		const listed = await exec(
			computer,
			"cat threads/t1/app/notes.md threads/t1/app/node_modules/big.js 2>&1",
		);
		return listed.stdout.text;
	};

	it(
		"signs the project's computer in when it opens, and again when a renewal finds that near expiry",
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
			const signedInAs = async (computer: Computers.Computer) =>
				(await exec(computer, "bash -lc 'echo $SIGNED_IN_AS'")).stdout.text.trim();
			signedIn = signedInUntil("2 hours", "first");

			const { computer: opened } = await open();
			const asked = signIns;
			await runOnPostgres(projectComputers.renew(HOLDER));
			const notYetDue = signIns - asked;
			signedIn = signedInUntil("5 minutes", "second");
			await open();
			signedIn = signedInUntil("2 hours", "third");
			await runOnPostgres(projectComputers.renew(HOLDER));

			expect(notYetDue).toBe(0);
			expect(await signedInAs(opened)).toBe("third");
		},
		SLOW,
	);

	it(
		"makes the project's computer on first use, and opens the same one after",
		async () => {
			const first = await open();
			const second = await open();

			expect(first.arrival).toBe("made");
			expect(second.arrival).toBe("running");
			expect(second.computer.id).toBe(first.computer.id);
		},
		SLOW,
	);

	it(
		"makes one computer when two turns open it at once",
		async () => {
			const [one, other] = await Promise.all([open(), open()]);

			expect(one.computer.id).toBe(other.computer.id);
		},
		SLOW,
	);

	it(
		"says a paused computer came back without its programs",
		async () => {
			const first = await open();
			await Effect.runPromise(direct.pause(first.computer.id));

			expect((await open()).arrival).toBe("rebooted");
		},
		SLOW,
	);

	it(
		"brings a computer that stopped for good back with its work",
		async () => {
			const first = await open();
			await writeWork(first.computer);
			await runOnPostgres(projectComputers.release(HOLDER));
			// OpenSandbox names the container after its own word for a computer.
			execFileSync("docker", ["stop", `sandbox-${first.computer.id}`]);

			const back = await open();

			expect(back.arrival).toBe("rebooted");
			expect(back.computer.id).not.toBe(first.computer.id);
			expect(await readWork(back.computer)).toContain("kept");
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"replaces a computer the provider lost",
		async () => {
			const first = await open();
			await Effect.runPromise(direct.destroy(first.computer.id));
			const replaced = await open();

			expect(replaced.arrival).toBe("replaced");
			expect(replaced.computer.id).not.toBe(first.computer.id);
		},
		SLOW,
	);

	it(
		"moves the project to a newly enabled provider, destroying its computer at the old one",
		async () => {
			const first = await open();
			await addProvider();
			const moved = await open();

			expect(moved.arrival).toBe("replaced");
			expect(moved.computer.id).not.toBe(first.computer.id);
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"destroys and forgets every computer a provider made",
		async () => {
			const first = await open();
			const provider = await enabledProvider();

			await runOnPostgres(projectComputers.destroyAllMadeBy(theProject.workspaceId, provider));

			expect(
				await runOnPostgres(projectComputers.anyMadeBy(theProject.workspaceId, provider.id)),
			).toBe(false);
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"lets a workspace with computers be deleted",
		async () => {
			await open();

			await onDatabase((db) =>
				db.delete(workspace).where(eq(workspace.id, theProject.workspaceId)),
			);

			const left = await onDatabase((db) =>
				db.select().from(computer).where(eq(computer.workspaceId, theProject.workspaceId)),
			);
			expect(left).toHaveLength(0);
		},
		SLOW,
	);

	/** Makes the project's computer look unused for longer than the idle window. */
	const idleForAnHour = () =>
		onDatabase((db) =>
			db
				.update(computer)
				.set({ lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) })
				.where(eq(computer.projectId, theProject.projectId)),
		);
	const pausedAt = async () =>
		(
			await onDatabase((db) =>
				db
					.select({ pausedAt: computer.pausedAt })
					.from(computer)
					.where(eq(computer.projectId, theProject.projectId)),
			)
		)[0]?.pausedAt;

	it(
		"never pauses a computer a turn holds",
		async () => {
			await open();
			await idleForAnHour();

			await runOnPostgres(projectComputers.pauseIdle);

			expect(await pausedAt()).toBeNull();
		},
		SLOW,
	);

	it(
		"pauses a computer once its turns have let go and it has sat idle, and resumes it on next use",
		async () => {
			const first = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();

			await runOnPostgres(projectComputers.pauseIdle);

			expect(await pausedAt()).toBeInstanceOf(Date);
			const reopened = await open();
			expect(reopened.computer.id).toBe(first.computer.id);
			expect(reopened.arrival).toBe("rebooted");
			expect(await pausedAt()).toBeNull();
		},
		SLOW,
	);

	const measuredDisk = () => runOnPostgres(projectComputers.diskOf(theProject));

	it(
		"measures a running computer's disk, and what each bot's home, the conversations' folders and /tmp take of it",
		async () => {
			const botId = crypto.randomUUID();
			const { computer: opened } = await open();
			await exec(
				opened,
				[
					`mkdir -p bots/${botId} threads/t1`,
					`head -c 3000000 /dev/zero > bots/${botId}/cache`,
					"head -c 2000000 /dev/zero > threads/t1/clone",
					"head -c 1000000 /dev/zero > /tmp/download",
				].join(" && "),
			);

			await runOnPostgres(projectComputers.measureDisks);

			const disk = await measuredDisk();
			expect(disk?.usedBytes).toBeGreaterThan(0);
			expect(disk?.totalBytes).toBeGreaterThanOrEqual(disk?.usedBytes ?? 0);
			const sized = (kind: string) => disk?.folders?.find((folder) => folder.kind === kind);
			expect(sized("home")).toMatchObject({ botId, bytes: expect.any(Number) });
			expect(sized("home")?.bytes).toBeGreaterThanOrEqual(3_000_000);
			expect(sized("threads")?.bytes).toBeGreaterThanOrEqual(2_000_000);
			expect(sized("temporary")?.bytes).toBeGreaterThanOrEqual(1_000_000);
		},
		SLOW,
	);

	it(
		"measures a computer again while it's in use, and stops once nobody has used it since",
		async () => {
			const measuredAgo = (minutes: number) =>
				onDatabase((db) =>
					db
						.update(computer)
						.set({ diskMeasuredAt: new Date(Date.now() - minutes * 60 * 1000) })
						.where(eq(computer.projectId, theProject.projectId)),
				);
			// open() holds a lease until release(HOLDER): the computer is in use.
			await open();
			await runOnPostgres(projectComputers.measureDisks);
			await measuredAgo(60);

			await runOnPostgres(projectComputers.measureDisks);
			const whileInUse = (await measuredDisk())?.measuredAt;

			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			await measuredAgo(30);
			const beforeIdleSweep = (await measuredDisk())?.measuredAt;
			await runOnPostgres(projectComputers.measureDisks);

			expect(whileInUse?.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
			expect((await measuredDisk())?.measuredAt).toEqual(beforeIdleSweep);
		},
		SLOW,
	);

	it(
		"leaves a paused computer paused, with its last measurement",
		async () => {
			await open();
			await runOnPostgres(projectComputers.measureDisks);
			const before = await measuredDisk();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			await runOnPostgres(projectComputers.pauseIdle);
			await onDatabase((db) =>
				db
					.update(computer)
					.set({ diskMeasuredAt: new Date(Date.now() - 60 * 60 * 1000) })
					.where(eq(computer.projectId, theProject.projectId)),
			);

			await runOnPostgres(projectComputers.measureDisks);

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
				db.update(computerLease).set({ expiresAt: new Date(Date.now() - 1000) }),
			);
			await idleForAnHour();

			await runOnPostgres(projectComputers.pauseIdle);

			expect(await pausedAt()).toBeInstanceOf(Date);
		},
		SLOW,
	);

	/** Changes the provider's image, as a workspace admin would, or as a release moves its tag. */
	const changeImage = async (image: string) =>
		runOnPostgres(
			providers.update(theProject.workspaceId, (await enabledProvider()).id, {
				settings: { preset: "opensandbox", serverUrl: connection.baseUrl, image },
			}),
		);
	const recorded = async () =>
		(
			await onDatabase((db) =>
				db
					.select({ providerComputerId: computer.providerComputerId, image: computer.image })
					.from(computer)
					.where(eq(computer.projectId, theProject.projectId)),
			)
		)[0];

	it(
		"makes the computer from the digest its image's tag names, not what the host last pulled",
		async () => {
			await open();

			expect((await recorded())?.image).toMatch(/^debian@sha256:[0-9a-f]{64}$/);
		},
		SLOW,
	);

	it(
		"upgrades a computer nobody has used for a while to the provider's image, keeping its work, and leaves it paused",
		async () => {
			const first = await open();
			await writeWork(first.computer);
			await runOnPostgres(projectComputers.release(HOLDER));
			await changeImage("python:3.13-slim");
			await idleForAnHour();

			await runOnPostgres(projectComputers.upgradeIdle);

			const after = await recorded();
			expect(after?.image).toMatch(/^python@sha256:/);
			expect(after?.providerComputerId).not.toBe(first.computer.id);
			expect(await pausedAt()).toBeInstanceOf(Date);
			expect(await missing(first.computer.id)).toBe(true);
			const reopened = await open();
			expect(reopened.arrival).toBe("rebooted");
			expect(await readWork(reopened.computer)).toMatch(/kept[\s\S]*ignored/);
		},
		SLOW,
	);

	it(
		"leaves a computer on its image while a turn uses it",
		async () => {
			const first = await open();
			await changeImage("python:3.13-slim");
			await idleForAnHour();

			await runOnPostgres(projectComputers.upgradeIdle);

			expect((await recorded())?.providerComputerId).toBe(first.computer.id);
		},
		SLOW,
	);

	it(
		"when the registry won't say what a tag names, keeps a computer on it and upgrades only to another image",
		async () => {
			// Named in full, they are the same images to Docker, but new to the
			// service, which remembers what registries said of the short names.
			const debian = "docker.io/library/debian:bookworm-slim";
			const python = "docker.io/library/python:3.13-slim";
			registryAnswers = false;
			try {
				await changeImage(debian);
				const first = await open();
				await runOnPostgres(projectComputers.release(HOLDER));
				await idleForAnHour();

				await runOnPostgres(projectComputers.upgradeIdle);
				const status = await runOnPostgres(
					projectComputers.status(theProject, await enabledProvider()),
				);
				const onItsTag = await recorded();
				await changeImage(python);
				await idleForAnHour();
				await runOnPostgres(projectComputers.upgradeIdle);

				expect(onItsTag).toEqual({ providerComputerId: first.computer.id, image: debian });
				expect(status.kind === "present" && status.upgradeAvailable).toBe(false);
				expect((await recorded())?.image).toBe(python);
			} finally {
				registryAnswers = true;
			}
		},
		SLOW,
	);

	it(
		"reports the project's computer, and when the provider would make it from another image",
		async () => {
			expect(
				(await runOnPostgres(projectComputers.status(theProject, await enabledProvider()))).kind,
			).toBe("none");
			await open();
			const provider = await enabledProvider();
			const now = await runOnPostgres(projectComputers.status(theProject, provider));
			await runOnPostgres(
				providers.update(theProject.workspaceId, provider.id, {
					settings: {
						preset: "opensandbox",
						serverUrl: connection.baseUrl,
						image: "python:3.13-slim",
					},
				}),
			);
			const later = await runOnPostgres(
				projectComputers.status(theProject, await enabledProvider()),
			);

			expect(now).toMatchObject({ kind: "present", state: "running", turnsUsing: 1 });
			expect(now.kind === "present" && now.image).toMatch(/^debian@sha256:/);
			expect(now.kind === "present" && now.upgradeAvailable).toBe(false);
			expect(later.kind === "present" && later.upgradeAvailable).toBe(true);
		},
		SLOW,
	);

	it(
		"won't reset a computer a turn is using, and resets it once the turn lets go",
		async () => {
			const first = await open();

			const refused = await runOnPostgres(Effect.exit(projectComputers.reset(theProject)));
			await runOnPostgres(projectComputers.release(HOLDER));
			await runOnPostgres(projectComputers.reset(theProject));

			expect(refused.toString()).toContain("ComputerInUse");
			expect((await runOnPostgres(projectComputers.status(theProject, undefined))).kind).toBe(
				"none",
			);
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"upgrades to a new image keeping all of the work",
		async () => {
			const first = await open();
			await writeWork(first.computer);
			await runOnPostgres(projectComputers.release(HOLDER));
			const provider = await enabledProvider();
			await runOnPostgres(
				providers.update(theProject.workspaceId, provider.id, {
					settings: {
						preset: "opensandbox",
						serverUrl: connection.baseUrl,
						image: "python:3.13-slim",
					},
				}),
			);

			await runOnPostgres(projectComputers.upgrade(theProject, await enabledProvider()));
			const upgraded = await open();

			expect(upgraded.computer.id).not.toBe(first.computer.id);
			expect(upgraded.arrival).toBe("running");
			expect(await readWork(upgraded.computer)).toMatch(/kept[\s\S]*ignored/);
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"finishes an upgrade whose caller goes away part-way, leaving no computer behind",
		async () => {
			const first = await open();
			await runOnPostgres(projectComputers.release(HOLDER));
			const provider = await enabledProvider();

			// Long enough to be making the new computer, too short for it to be ready.
			await runOnPostgres(
				Effect.gen(function* () {
					const upgrading = yield* Effect.forkChild(projectComputers.upgrade(theProject, provider));
					yield* Effect.sleep("500 millis");
					yield* Fiber.interrupt(upgrading);
				}),
			);
			const reopened = await open();

			expect(reopened.computer.id).not.toBe(first.computer.id);
			expect(reopened.arrival).toBe("running");
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);

	it(
		// Both providers here are the one server, which keeps the work on one
		// volume, so this shows the move rather than what the copy leaves out.
		"upgrades to another provider with the work copied across",
		async () => {
			const first = await open();
			await writeWork(first.computer);
			await runOnPostgres(projectComputers.release(HOLDER));
			await addProvider();

			await runOnPostgres(projectComputers.upgrade(theProject, await enabledProvider()));
			const upgraded = await open();

			expect(upgraded.computer.id).not.toBe(first.computer.id);
			expect(upgraded.arrival).toBe("running");
			expect(await readWork(upgraded.computer)).toContain("kept");
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);
});
