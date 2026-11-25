import { execFileSync } from "node:child_process";
import { userText } from "@sugabots/errors";
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

export const localComputerEgress = unimplemented(Egress.Service, {
	providers: { for: () => fetch },
	validateProviderUrl: () => Effect.void,
});

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
 * Holds the calls of one kind that start while it is held, until `release`,
 * so a case can act while a provider is part-way through one.
 */
export interface ProviderHold {
	/** Resolves once `count` calls have started and are held. */
	readonly started: (count: number) => Promise<void>;
	readonly release: () => void;
}

interface HeldCalls extends PromiseWithResolvers<void> {
	started: number;
	onStart: Array<() => void>;
}

/** Holds calls until released, as {@link ProviderHold} describes, and makes the calls that wait on it. */
function holdCalls(onRelease: () => void) {
	const held: HeldCalls = { started: 0, onStart: [], ...Promise.withResolvers<void>() };
	const hold: ProviderHold = {
		started: (count) =>
			new Promise<void>((resolve) => {
				const check = () => {
					if (held.started >= count) resolve();
				};
				held.onStart.push(check);
				check();
			}),
		release: () => {
			onRelease();
			held.resolve();
		},
	};
	const wait = Effect.promise(() => {
		held.started += 1;
		for (const check of held.onStart) check();
		return held.promise;
	});
	return { hold, wait };
}

/** E2B Cloud, which E2B access reaches when it gives no endpoints of its own. */
const E2B_CLOUD = "e2b-cloud";

/** Which server `access` reaches: the OpenSandbox server's address, or E2B's API address. */
function endpointOf(access: Computers.ProviderAccess) {
	return access.provider === "opensandbox"
		? access.baseUrl
		: (access.endpoints?.apiUrl ?? E2B_CLOUD);
}

/**
 * A computer provider that keeps its computers in memory, for tests of what
 * is decided above a provider: leases, sleeping, upgrades. Each endpoint (see
 * {@link endpointOf}) keeps its own computers, so one reached at the wrong
 * endpoint is missing there. The provider contract is kept: opening a
 * computer that is asleep resumes it, a computer that is gone is missing, and
 * destroying one twice is fine. Its file and port calls die, but for
 * uploading a file and downloading one: one uploaded comes back as it was,
 * and any other gives what {@link serveDownloadsAt} set for its endpoint, or
 * fails as missing. Commands succeed with no output unless the case says
 * otherwise with `answerCommandsWith`.
 */
export function inMemoryComputers(
	options: { sleepKeeps?: Computers.Capabilities["sleepKeeps"]; workKeptApart?: boolean } = {},
) {
	type Held = { -readonly [Key in keyof HeldComputer]: HeldComputer[Key] } & {
		uploads: Map<string, Uint8Array>;
		networks: Network[];
		stoppedForGood: boolean;
	};
	const inventories = new Map<string, Map<Computers.ComputerId, Held>>();
	const inventoryAt = (endpoint: string) => {
		let inventory = inventories.get(endpoint);
		if (!inventory) {
			inventory = new Map();
			inventories.set(endpoint, inventory);
		}
		return inventory;
	};
	const downloads = new Map<string, Uint8Array>();
	const networkWaiters = new Map<Computers.ComputerId, Array<(network: Network) => void>>();
	let created = 0;
	let creationHold: Effect.Effect<void> | undefined;
	const openingHolds = new Map<Computers.ComputerId, Effect.Effect<void>>();
	let answerCommand = (_computerId: Computers.ComputerId) => 0;
	let destroyFailures = 0;
	const missing = (id: Computers.ComputerId) =>
		new Computers.Missing({ provider: "opensandbox", computerId: id });
	const unsupported = (call: string) => () =>
		Effect.die(new Error(`inMemoryComputers has no ${call}`));

	const computerFor = (
		id: Computers.ComputerId,
		endpoint: string,
		held: Map<Computers.ComputerId, Held>,
	): Computers.Computer => ({
		id,
		exec: () =>
			Effect.sync(() => {
				const none = { text: "", truncated: false };
				return { exitCode: answerCommand(id), stdout: none, stderr: none };
			}),
		readFile: unsupported("readFile"),
		writeFile: unsupported("writeFile"),
		downloadFile: (path) => {
			const content = held.get(id)?.uploads.get(path) ?? downloads.get(endpoint);
			return content
				? Effect.succeed(content)
				: Effect.fail(new Computers.FileFailed({ path, reason: userText`No such file` }));
		},
		uploadFile: (path, content) => Effect.sync(() => void held.get(id)?.uploads.set(path, content)),
		endpoint: unsupported("endpoint"),
		setNetwork: (network) =>
			Effect.sync(() => {
				held.get(id)?.networks.push(network);
				for (const wake of networkWaiters.get(id) ?? []) wake(network);
				networkWaiters.delete(id);
			}),
	});

	const provider = (access: Computers.ProviderAccess): Computers.Provider => {
		const endpoint = endpointOf(access);
		const held = inventoryAt(endpoint);
		return {
			capabilities: {
				sleepKeeps: options.sleepKeeps ?? "disk",
				credentials: "host-and-path",
				blocksHosts: true,
			},
			networkMode: access.networkMode,
			check: Effect.void,
			create: (spec) =>
				Effect.gen(function* () {
					if (creationHold) yield* creationHold;
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
					return computerFor(id, endpoint, held);
				}),
			open: (id) =>
				Effect.gen(function* () {
					const opening = openingHolds.get(id);
					if (opening) yield* opening;
					const found = held.get(id);
					if (!found) return yield* missing(id);
					if (found.stoppedForGood) {
						return yield* new Computers.Stopped({ provider: access.provider, computerId: id });
					}
					const resumed = found.state === "asleep";
					found.state = "running";
					return { computer: computerFor(id, endpoint, held), resumed };
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
			destroy: (id) =>
				destroyFailures > 0
					? Effect.suspend(() => {
							destroyFailures -= 1;
							return Effect.fail(
								new Computers.Unavailable({ provider: "opensandbox", cause: "refused" }),
							);
						})
					: Effect.sync(() => void held.delete(id)),
			labelled: (key, value) =>
				Effect.sync(() =>
					[...held.values()].filter((one) => one.spec.labels[key] === value).map(({ id }) => id),
				),
		};
	};

	return {
		layer: Layer.succeed(Computers.Service, { forAccess: provider }),
		/** The computers every endpoint has now, oldest first. */
		computers: (): readonly HeldComputer[] =>
			[...inventories.values()]
				.flatMap((inventory) => [...inventory.values()])
				.toSorted((a, b) => madeOrder(a.id) - madeOrder(b.id)),
		/** The computers the endpoint `endpoint` has now, oldest first. */
		computersAt: (endpoint: string): readonly HeldComputer[] => [...inventoryAt(endpoint).values()],
		/** Every file downloaded from a computer at `endpoint` from now on, unless uploaded to it, has `content`. */
		serveDownloadsAt: (endpoint: string, content: Uint8Array) => {
			downloads.set(endpoint, content);
		},
		/** The computer stops without being put to sleep, as when its host shuts down, and can't be opened. */
		stopForGood: (id: Computers.ComputerId) => {
			for (const inventory of inventories.values()) {
				const found = inventory.get(id);
				if (found) found.stoppedForGood = true;
			}
		},
		/** Holds every creation from now on until released. */
		holdCreations: (): ProviderHold => {
			const { hold, wait } = holdCalls(() => {
				if (creationHold === wait) creationHold = undefined;
			});
			creationHold = wait;
			return hold;
		},
		/** Holds every opening of the computer `id` from now on until released. */
		holdOpening: (id: Computers.ComputerId): ProviderHold => {
			const { hold, wait } = holdCalls(() => {
				if (openingHolds.get(id) === wait) openingHolds.delete(id);
			});
			openingHolds.set(id, wait);
			return hold;
		},
		/** The next `count` calls to destroy a computer fail, as when the provider doesn't answer. */
		failDestroys: (count: number) => {
			destroyFailures = count;
		},
		/** The provider loses the computer, as when its operator deletes it. */
		lose: (id: Computers.ComputerId) => {
			for (const inventory of inventories.values()) inventory.delete(id);
		},
		/** How many computers the provider has made, at every endpoint, those it no longer has included. */
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

/** The order {@link inMemoryComputers} made the computer `id` in, from its id. */
function madeOrder(id: Computers.ComputerId) {
	return Number(id.slice("in-memory-".length));
}
