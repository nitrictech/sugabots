import { execFileSync } from "node:child_process";
import { ConnectionConfig, SandboxManager } from "@alibaba-group/opensandbox";
import { COMPUTER_OPENSANDBOX_DEFAULT_SIZE } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SystemWorkAuthentication } from "../authentication/system-work.ts";
import { computer, member, membership, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Ids } from "../ids/ids.ts";
import { scheduledWorkOperations } from "../operations/scheduled-work.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { seedProject } from "../workspaces/projects/seed.test-support.ts";
import { ComputerProviderStore } from "./computer-provider-store.ts";
import { ComputerSignIn } from "./computer-sign-in.ts";
import { Computers } from "./computers.ts";
import { ProjectComputers } from "./project-computers.ts";
import { recordingIds, removeWorkVolumes } from "./testing.ts";

/**
 * What a project's computer needs of a real OpenSandbox server: containers
 * that stop, volumes that keep work, and a shell to measure and copy in. The
 * rest of what is decided above a provider is in `project-computers.test.ts`,
 * over an in-memory provider. These need a server
 * (`docker compose --profile computers up -d`, with OPENSANDBOX_URL, a
 * localhost address, and OPENSANDBOX_API_KEY set) and run on its local
 * Docker, which they stop containers through, as a host shutting down would.
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;
const IMAGE = "debian:bookworm-slim";
const HOLDER: ProjectComputers.Holder = { kind: "turn", id: "turn-under-test" };

describe.skipIf(!configured)("bots' computers, against Postgres and OpenSandbox", () => {
	const access: Computers.OpenSandboxAccess = {
		provider: "opensandbox",
		baseUrl: env.OPENSANDBOX_URL ?? "",
		apiKey: Redacted.make(env.OPENSANDBOX_API_KEY ?? ""),
		image: IMAGE,
		size: COMPUTER_OPENSANDBOX_DEFAULT_SIZE,
		networkMode: "allowed-hosts-only",
	};
	// The same server by another name, which the second provider is at.
	const secondProviderUrl = access.baseUrl.replace("localhost", "127.0.0.1");
	let projectComputers: ProjectComputers.Interface;
	let providers: ComputerProviderStore.Interface;
	let direct: Computers.Provider;
	let theProject: ProjectComputers.Project;
	let ownerId: string;
	const workNamesMade = new Set<string>();

	/**
	 * OpenSandbox as the project's computers reach it, except that computers at
	 * the second provider keep their work on volumes of their own, as at a
	 * server of its own. Both providers here are one server, whose volumes the
	 * work would share, which would make a copy between them unnecessary.
	 */
	const separateVolumesAtSecondProvider = Layer.effect(
		Computers.Service,
		Effect.map(Computers.Service, (computers) =>
			Computers.Service.of({
				forAccess: (forAccess) => {
					const provider = computers.forAccess(forAccess);
					if (forAccess.provider !== "opensandbox" || forAccess.baseUrl !== secondProviderUrl) {
						return provider;
					}
					return {
						...provider,
						create: (spec) => {
							const workName = `${spec.workName}-second`;
							workNamesMade.add(workName);
							return provider.create({ ...spec, workName });
						},
					};
				},
			}),
		),
	).pipe(Layer.provide(Computers.layer));

	beforeAll(async () => {
		expect(
			secondProviderUrl,
			"OPENSANDBOX_URL must be a localhost address, so the second provider can be the same server by another name",
		).not.toBe(access.baseUrl);
		[projectComputers, providers] = await runOnPostgres(
			Effect.all([ProjectComputers.Service, ComputerProviderStore.Service]).pipe(
				Effect.provide(
					Layer.merge(
						ProjectComputers.layerNoDeps.pipe(
							Layer.provide([separateVolumesAtSecondProvider, ComputerProviderStore.layer]),
						),
						ComputerProviderStore.layer,
					),
				),
				Effect.provide([
					ComputerSignIn.none,
					// Docker Hub is asked what the images' tags name, as in production.
					unimplemented(Egress.Service, { providers: { for: () => fetch } }),
					recordingIds(workNamesMade),
				]),
			),
		);
		direct = await Effect.runPromise(
			Effect.map(Computers.Service, (computers) => computers.forAccess(access)).pipe(
				Effect.provide(Computers.layer.pipe(Layer.provide(Ids.layer))),
			),
		);
	});

	// Found by the workspace's label rather than its records, so a computer no
	// record names any more, such as a deleted workspace's, is destroyed too.
	afterEach(async () => {
		const server = SandboxManager.create({
			connectionConfig: new ConnectionConfig({
				domain: access.baseUrl,
				apiKey: Redacted.value(access.apiKey),
			}),
		});
		const { items } = await server.listSandboxInfos({
			metadata: { "sugabots.workspace": theProject.workspaceId },
		});
		for (const { id } of items) {
			await Effect.runPromise(direct.destroy(Computers.ComputerId(id)));
		}
		// Its records go too, which the idle sweeps would otherwise act on in later cases.
		await onDatabase((db) => db.delete(workspace).where(eq(workspace.id, theProject.workspaceId)));
	}, SLOW);

	afterAll(async () => {
		await closeDatabase();
		removeWorkVolumes(workNamesMade);
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
				.insert(member)
				.values({ name: "Sam", email: `computer-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		ownerId = owner.id;
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId: space.id, memberId: owner.id }),
		);
		const made = await onDatabase((db) =>
			seedProject(db, { workspaceId: space.id, name: "Launch", slug: "launch" }),
		);
		theProject = { workspaceId: space.id, projectId: made.id };
		await addProvider();
	});

	/** An OpenSandbox provider for the project's workspace at `serverUrl`, enabled, which disables any other. */
	const addProvider = (serverUrl = access.baseUrl) =>
		runOnPostgres(
			providers.create(theProject.workspaceId, {
				createdById: ownerId,
				provider: {
					settings: { builtIn: "opensandbox", serverUrl, image: IMAGE },
					enabled: true,
					apiKey: Redacted.value(access.apiKey),
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

	/** Some work: a note, and a folder its `.gitignore` leaves out. */
	const writeWork = (computer: Computers.Computer) =>
		exec(
			computer,
			"mkdir -p chats/t1/app/node_modules && echo kept > chats/t1/app/notes.md && echo ignored > chats/t1/app/node_modules/big.js && echo node_modules > chats/t1/app/.gitignore",
		);
	/** What of {@link writeWork}'s work the computer has. */
	const readWork = async (computer: Computers.Computer) => {
		const found = await exec(
			computer,
			"cat chats/t1/app/notes.md; test -e chats/t1/app/node_modules/big.js && echo ignored-present || echo ignored-absent",
		);
		return {
			note: found.stdout.text.split("\n")[0],
			ignoredFolderKept: found.stdout.text.includes("ignored-present"),
		};
	};

	const stateOfComputer = async () => {
		const status = await runOnPostgres(
			projectComputers.status(theProject, await enabledProvider()),
		);
		return status.kind === "present" ? status.state : status.kind;
	};

	const sleepIdle = Effect.gen(function* () {
		const auth = yield* SystemWorkAuthentication.Service;
		for (const computerId of yield* auth.idleComputerIds) {
			const principal = yield* auth.computerSleep(computerId);
			yield* scheduledWorkOperations["projectComputer.sleepIfIdle"]
				.run(principal, { computerId }, { kind: "request", request: crypto.randomUUID() })
				.pipe(Effect.provideService(ProjectComputers.Service, projectComputers));
		}
	}).pipe(Effect.provide(SystemWorkAuthentication.layer));

	/** Makes the project's computer look unused for longer than the idle window. */
	const idleForAnHour = () =>
		onDatabase((db) =>
			db
				.update(computer)
				.set({ lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) })
				.where(eq(computer.projectId, theProject.projectId)),
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
			expect(await readWork(back.computer)).toEqual({ note: "kept", ignoredFolderKept: true });
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);

	const measuredDisk = () => runOnPostgres(projectComputers.diskOf(theProject));

	it(
		"measures a running computer's disk, and what each bot's home, the chats' folders and /tmp take of it",
		async () => {
			const botId = crypto.randomUUID();
			const { computer: opened } = await open();
			await exec(
				opened,
				[
					`mkdir -p bots/${botId} chats/t1`,
					`head -c 3000000 /dev/zero > bots/${botId}/cache`,
					"head -c 2000000 /dev/zero > chats/t1/clone",
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
			expect(sized("chats")?.bytes).toBeGreaterThanOrEqual(2_000_000);
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
		"leaves a sleeping computer asleep, with its last measurement",
		async () => {
			await open();
			await runOnPostgres(projectComputers.measureDisks);
			const before = await measuredDisk();
			await runOnPostgres(projectComputers.release(HOLDER));
			await idleForAnHour();
			await runOnPostgres(sleepIdle);
			await onDatabase((db) =>
				db
					.update(computer)
					.set({ diskMeasuredAt: new Date(Date.now() - 60 * 60 * 1000) })
					.where(eq(computer.projectId, theProject.projectId)),
			);

			await runOnPostgres(projectComputers.measureDisks);

			expect(await stateOfComputer()).toBe("asleep");
			expect((await measuredDisk())?.usedBytes).toBe(before?.usedBytes);
		},
		SLOW,
	);

	it(
		"upgrades to a new image on the same work volume, keeping all of the work",
		async () => {
			const first = await open();
			await writeWork(first.computer);
			await runOnPostgres(projectComputers.release(HOLDER));
			const provider = await enabledProvider();
			await runOnPostgres(
				providers.update(theProject.workspaceId, provider.id, {
					settings: {
						builtIn: "opensandbox",
						serverUrl: access.baseUrl,
						image: "python:3.13-slim",
					},
				}),
			);

			await runOnPostgres(projectComputers.upgrade(theProject, await enabledProvider()));
			const upgraded = await open();

			expect(upgraded.computer.id).not.toBe(first.computer.id);
			expect(upgraded.arrival).toBe("running");
			expect(await readWork(upgraded.computer)).toEqual({ note: "kept", ignoredFolderKept: true });
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);

	it(
		"upgrades to another provider with the work copied across, less what .gitignore leaves out",
		async () => {
			const first = await open();
			await writeWork(first.computer);
			await runOnPostgres(projectComputers.release(HOLDER));
			await addProvider(secondProviderUrl);

			await runOnPostgres(projectComputers.upgrade(theProject, await enabledProvider()));
			const upgraded = await open();

			expect(upgraded.computer.id).not.toBe(first.computer.id);
			expect(upgraded.arrival).toBe("running");
			expect(await readWork(upgraded.computer)).toEqual({ note: "kept", ignoredFolderKept: false });
			expect(await missing(first.computer.id)).toBe(true);
		},
		SLOW,
	);
});
