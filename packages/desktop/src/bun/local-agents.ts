import { basename } from "node:path";
import { Schema } from "effect";

/**
 * An agent this computer hosts and lends to the server: which installed CLI
 * runs it, and the folder it works in. Lending one is its owner's consent to
 * bots in Sugabots running it there.
 */
export const lentAgentSchema = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literal("claude-code"),
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

/**
 * The agent CLIs installed on this computer that it knows how to host:
 * Claude Code, found on the PATH as `claude`.
 */
export async function findInstalledAgents(): Promise<ReadonlyArray<InstalledAgent>> {
	const executable = Bun.which("claude");
	if (!executable) return [];
	return [
		{ kind: "claude-code", name: "Claude Code", executable, version: await versionOf(executable) },
	];
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
