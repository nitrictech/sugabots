import { basename } from "node:path";
import { localAgentKindSchema } from "@sugabots/contracts/devices";
import { Schema } from "effect";

/**
 * An agent this computer hosts and lends to the server: which installed CLI
 * runs it, and the folder it works in. Lending one is its owner's consent to
 * bots in Sugabots running it there.
 */
export const lentAgentSchema = Schema.Struct({
	id: Schema.String,
	kind: localAgentKindSchema,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	executable: Schema.String,
	workingDirectory: Schema.String,
});

export type LentAgent = typeof lentAgentSchema.Type;

/** An agent CLI found on this computer, which it can host. */
export interface InstalledAgent {
	readonly kind: LentAgent["kind"];
	readonly name: string;
	readonly executable: string;
	readonly version: string | null;
}

/** The agent CLIs this computer knows how to host, and the command each is found on the PATH as. */
const HOSTABLE: ReadonlyArray<{ kind: LentAgent["kind"]; name: string; command: string }> = [
	{ kind: "claude-code", name: "Claude Code", command: "claude" },
	{ kind: "opencode", name: "opencode", command: "opencode" },
];

/** The agent CLIs installed on this computer that it knows how to host. */
export async function findInstalledAgents(): Promise<ReadonlyArray<InstalledAgent>> {
	const found = await Promise.all(
		HOSTABLE.map(async ({ kind, name, command }) => {
			const executable = Bun.which(command);
			return executable ? { kind, name, executable, version: await versionOf(executable) } : null;
		}),
	);
	return found.filter((agent) => agent !== null);
}

async function versionOf(executable: string) {
	try {
		const run = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "ignore" });
		const output = await new Response(run.stdout).text();
		return output.trim().split(/\s+/)[0] || null;
	} catch {
		return null;
	}
}

/** A new agent hosted with `installed`, working in `workingDirectory`. */
export function lentAgent(installed: InstalledAgent, workingDirectory: string): LentAgent {
	const folder = basename(workingDirectory) || workingDirectory;
	return {
		id: crypto.randomUUID(),
		kind: installed.kind,
		name: `${installed.name} in ${folder}`,
		description: `${installed.name}, working in ${workingDirectory} on this computer.`,
		executable: installed.executable,
		workingDirectory,
	};
}
