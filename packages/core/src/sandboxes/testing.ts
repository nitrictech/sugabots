import { execFileSync } from "node:child_process";
import { Effect, Layer } from "effect";
import { Ids } from "../ids/ids.ts";
import { workVolume } from "./implementations/opensandbox.ts";

/**
 * Ids that remember every UUID v7 they hand out in `handedOut`. A pod's
 * sandbox keeps its work under its record's id, so these include the work
 * name of every pod sandbox made with them.
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
 * the work of sandboxes made with `workNames` on, which the server has no
 * call to remove. Names with no volume are skipped. A volume still in use
 * fails the call, since its sandbox was left behind.
 */
export function removeWorkVolumes(workNames: Iterable<string>) {
	const wanted = new Set(Array.from(workNames, workVolume));
	const present = execFileSync("docker", ["volume", "ls", "--quiet"], { encoding: "utf8" })
		.split("\n")
		.filter((name) => wanted.has(name));
	if (present.length > 0) execFileSync("docker", ["volume", "rm", ...present]);
}
