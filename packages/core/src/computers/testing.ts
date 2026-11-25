import { execFileSync } from "node:child_process";
import { Effect, Layer } from "effect";
import { query } from "../database/database.ts";
import { computer } from "../database/schema.ts";
import { holdTransaction } from "../database/testing.ts";
import { Ids } from "../ids/ids.ts";
import { Egress } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { ComputerSignIn } from "./computer-sign-in.ts";
import { Computers } from "./computers.ts";
import { workVolume } from "./implementations/opensandbox.ts";

/**
 * What a project's computer is signed in with and reaches the internet
 * through, for a test that never makes one, such as one that deletes a bot
 * whose default project has none: any use dies.
 */
export const noComputers = Layer.mergeAll(
	unimplemented(ComputerSignIn.Service, {}),
	unimplemented(Egress.Service, {}),
);

/**
 * Records the project's first computer, made by the provider, in a
 * transaction held open, as a turn in another process would while a deletion
 * finds none to destroy. Resolves once the record is held; `release` commits it.
 */
export async function recordingFirstComputer(input: {
	workspaceId: string;
	projectId: string;
	computerProviderId: string;
}) {
	const recording = holdTransaction(
		query((db) =>
			db.insert(computer).values({
				...input,
				providerComputerId: Computers.ComputerId("first"),
				image: "debian",
			}),
		),
	);
	await recording.held;
	return recording;
}

/**
 * Ids that remember every UUID v7 they hand out in `handedOut`. A bot's
 * computer keeps its work under its record's id, so these include the work
 * name of every computer made with them.
 */
export const recordingIds = (handedOut: Set<string>) =>
	Layer.effect(
		Ids.Service,
		Effect.map(Ids.make, (ids) =>
			Ids.Service.of({
				...ids,
				next: Effect.tap(ids.next, (id) => Effect.sync(() => handedOut.add(id))),
			}),
		),
	);

/**
 * Removes the volumes an OpenSandbox server on this machine's Docker keeps
 * the work of computers made with `workNames` on, which the server has no
 * call to remove. Names with no volume are skipped. A volume still in use
 * fails the call, since its computer was left behind.
 */
export function removeWorkVolumes(workNames: Iterable<string>) {
	const wanted = new Set(Array.from(workNames, workVolume));
	const present = execFileSync("docker", ["volume", "ls", "--quiet"], { encoding: "utf8" })
		.split("\n")
		.filter((name) => wanted.has(name));
	if (present.length > 0) execFileSync("docker", ["volume", "rm", ...present]);
}

type Network = Parameters<Computers.Computer["setNetwork"]>[0];

/** A computer as {@link inMemoryComputers} holds it, which a test reads to see what the provider was asked for. */
export interface HeldComputer {
	readonly id: Computers.ComputerId;
	readonly state: "running" | "asleep";
	/** The image or template it was made from, as the provider was asked. */
	readonly madeFrom: string;
	readonly spec: Computers.Spec;
	/** Every network it was given, oldest first. */
	readonly networks: readonly Network[];
	/** The files put in it, by path. */
	readonly uploads: ReadonlyMap<string, Uint8Array>;
}

/**
 * Holds the creations that start while it is held, until `release`, so a case
 * can act while a provider is part-way through making a computer.
 */
export interface CreationHold {
	/** Resolves once `count` creations have started and are held. */
	readonly started: (count: number) => Promise<void>;
	readonly release: () => void;
}

interface HeldCreations extends PromiseWithResolvers<void> {
	started: number;
	onStart: Array<() => void>;
}

/**
 * A computer provider that keeps its computers in memory, for tests of what
 * is decided above a provider: leases, sleeping, upgrades. The provider
 * contract is kept: opening a computer that is asleep resumes it, a computer
 * that is gone is missing, and destroying one twice is fine. Its file and
 * port calls die; commands succeed with no output unless the case says
 * otherwise with `answerCommandsWith`, and downloading a file nobody uploaded
 * gives its own path as text.
 */
export function inMemoryComputers(
	options: { sleepKeeps?: Computers.Capabilities["sleepKeeps"]; workKeptApart?: boolean } = {},
) {
	type Held = { -readonly [Key in keyof HeldComputer]: HeldComputer[Key] } & {
		uploads: Map<string, Uint8Array>;
		networks: Network[];
		stoppedForGood: boolean;
	};
	const held = new Map<Computers.ComputerId, Held>();
	const networkWaiters = new Map<Computers.ComputerId, Array<(network: Network) => void>>();
	let created = 0;
	let creations: HeldCreations | undefined;
	let answerCommand = (_computerId: Computers.ComputerId) => 0;
	const missing = (id: Computers.ComputerId) =>
		new Computers.Missing({ provider: "opensandbox", computerId: id });
	const unsupported = (call: string) => () =>
		Effect.die(new Error(`inMemoryComputers has no ${call}`));

	const computerFor = (id: Computers.ComputerId): Computers.Computer => ({
		id,
		exec: () =>
			Effect.sync(() => {
				const none = { text: "", truncated: false };
				return { exitCode: answerCommand(id), stdout: none, stderr: none };
			}),
		readFile: unsupported("readFile"),
		writeFile: unsupported("writeFile"),
		downloadFile: (path) =>
			Effect.sync(() => held.get(id)?.uploads.get(path) ?? new TextEncoder().encode(path)),
		uploadFile: (path, content) => Effect.sync(() => void held.get(id)?.uploads.set(path, content)),
		endpoint: unsupported("endpoint"),
		setNetwork: (network) =>
			Effect.sync(() => {
				held.get(id)?.networks.push(network);
				for (const wake of networkWaiters.get(id) ?? []) wake(network);
				networkWaiters.delete(id);
			}),
	});

	const provider = (access: Computers.ProviderAccess): Computers.Provider => ({
		capabilities: {
			sleepKeeps: options.sleepKeeps ?? "disk",
			credentials: "host-and-path",
			blocksHosts: true,
		},
		networkMode: access.networkMode,
		check: Effect.void,
		create: (spec) =>
			Effect.gen(function* () {
				if (creations) {
					const current = creations;
					yield* Effect.promise(() => {
						current.started += 1;
						for (const check of current.onStart) check();
						return current.promise;
					});
				}
				created += 1;
				const id = Computers.ComputerId(`in-memory-${created}`);
				held.set(id, {
					id,
					state: "running",
					madeFrom: access.provider === "e2b" ? access.template : access.image,
					spec,
					networks: [],
					uploads: new Map(),
					stoppedForGood: false,
				});
				return computerFor(id);
			}),
		open: (id) =>
			Effect.gen(function* () {
				const found = held.get(id);
				if (!found) return yield* missing(id);
				if (found.stoppedForGood) {
					return yield* new Computers.Stopped({ provider: access.provider, computerId: id });
				}
				const resumed = found.state === "asleep";
				found.state = "running";
				return { computer: computerFor(id), resumed };
			}),
		info: (id) =>
			Effect.gen(function* () {
				const found = held.get(id);
				if (!found) return yield* missing(id);
				return { state: found.state, workKeptApart: options.workKeptApart ?? false };
			}),
		sleep: (id) =>
			Effect.gen(function* () {
				const found = held.get(id);
				if (!found) return yield* missing(id);
				found.state = "asleep";
			}),
		destroy: (id) => Effect.sync(() => void held.delete(id)),
	});

	return {
		layer: Layer.succeed(Computers.Service, { forAccess: provider }),
		/** The computers the provider has now, oldest first. */
		computers: (): readonly HeldComputer[] => [...held.values()],
		/** The computer stops without being put to sleep, as when its host shuts down, and can't be opened. */
		stopForGood: (id: Computers.ComputerId) => {
			const found = held.get(id);
			if (found) found.stoppedForGood = true;
		},
		/** Holds every creation from now on until released. */
		holdCreations: (): CreationHold => {
			const current: HeldCreations = { started: 0, onStart: [], ...Promise.withResolvers<void>() };
			creations = current;
			return {
				started: (count) =>
					new Promise<void>((resolve) => {
						const check = () => {
							if (current.started >= count) resolve();
						};
						current.onStart.push(check);
						check();
					}),
				release: () => {
					creations = undefined;
					current.resolve();
				},
			};
		},
		/** The provider loses the computer, as when its operator deletes it. */
		lose: (id: Computers.ComputerId) => void held.delete(id),
		/** How many computers the provider has made, those it no longer has included. */
		made: () => created,
		/** The exit code of each command run in the computer with this id from now on; success by default. */
		answerCommandsWith: (answer: (computerId: Computers.ComputerId) => number) => {
			answerCommand = answer;
		},
		/** Resolves with the next network the computer is given. */
		nextNetwork: (id: Computers.ComputerId) =>
			new Promise<Network>((resolve) => {
				networkWaiters.set(id, [...(networkWaiters.get(id) ?? []), resolve]);
			}),
	};
}
