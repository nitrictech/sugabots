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
}): Promise<{ release: () => Promise<void> }> {
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
	return { release: recording.release };
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
