export * as Sandbox from "./sandbox.ts";

import type { SandboxIsolation, SandboxProviderPresetId } from "@sugabots/contracts";
import { Data, type Effect } from "effect";
import { fromOpenSandbox } from "./implementations/opensandbox.ts";

/**
 * A sandbox service a workspace has configured: what makes and reaches its
 * pods' machines.
 *
 * A provider only makes and reaches machines. Which pod owns one, who is using
 * it, and when it may be paused are the pod sandbox store's business, so a new
 * provider is the few methods below and nothing else.
 */
export interface Interface {
	/** The preset this is, recorded on each sandbox so only it is asked to reach one. */
	readonly provider: Provider;
	readonly isolation: Isolation;
	readonly create: (spec: Spec) => Effect.Effect<Handle, Unavailable>;
	/** The sandbox made earlier with this id, or `Missing` if the provider no longer has it. */
	readonly connect: (id: string) => Effect.Effect<Handle, Missing | Unavailable>;
	/** Whether the service answers and accepts the key, without making anything. */
	readonly check: Effect.Effect<void, Unavailable>;
}

/** What a workspace's sandbox provider row says about reaching its service. */
export interface Connection {
	preset: Provider;
	baseUrl: string;
	apiKey: string;
	image: string;
	isolation: Isolation;
	allowedHosts: AllowedHosts;
	/** So a test result is recorded against the configuration it tested. */
	configurationUpdatedAt: Date;
}

/** The provider a workspace's configuration describes. */
export function forConnection(connection: Connection): Interface {
	switch (connection.preset) {
		case "opensandbox":
			return fromOpenSandbox(connection);
	}
}

export type Provider = SandboxProviderPresetId;
export type Isolation = SandboxIsolation;

/** Where agents work, and the home of the user they work as. */
export const WORKSPACE_DIRECTORY = "/workspace";
export const AGENT_HOME_DIRECTORY = "/home/agent";
/** The user agents' commands run as, so nothing they run is root. */
export const AGENT_USER_ID = 1000;

export interface Spec {
	/** Written on the provider's record of the sandbox, to find it from the provider's side. */
	labels: Record<string, string>;
}

export type AllowedHosts = { kind: "any" } | { kind: "only"; hosts: readonly string[] };

export interface Handle {
	readonly id: string;
	/** Runs a shell command as the agent's user. A command that runs and fails is not an error. */
	readonly exec: (command: string, options: ExecOptions) => Effect.Effect<Execution, Unavailable>;
	readonly readFile: (path: string) => Effect.Effect<Uint8Array, FileFailed | Unavailable>;
	/** Writes the file, making its directories, owned by the agent's user. */
	readonly writeFile: (
		path: string,
		content: Uint8Array,
	) => Effect.Effect<void, FileFailed | Unavailable>;
	/** Lets go of whatever this process holds for the sandbox. The sandbox itself carries on. */
	readonly disconnect: Effect.Effect<void>;
}

export interface ExecOptions {
	/** Absolute directory to run in. */
	cwd: string;
	timeoutSeconds: number;
	/** At most this much of each stream is kept, from the end, since the end is where errors are. */
	maxOutputCharacters: number;
	signal?: AbortSignal;
}

export interface Execution {
	/** Null when the command did not finish: it timed out or was stopped. */
	exitCode: number | null;
	stdout: CapturedOutput;
	stderr: CapturedOutput;
}

export interface CapturedOutput {
	text: string;
	/** How much was dropped from the start to keep within the limit. */
	droppedCharacters: number;
}

/** Keeps the last `limit` characters of output as it arrives. */
export function outputTail(limit: number) {
	let text = "";
	let dropped = 0;
	return {
		append(chunk: string) {
			text += chunk;
			if (text.length > limit) {
				dropped += text.length - limit;
				text = text.slice(text.length - limit);
			}
		},
		captured: (): CapturedOutput => ({ text, droppedCharacters: dropped }),
	};
}

/** The provider could not be reached, or refused what it was asked. Worth trying again later. */
export class Unavailable extends Data.TaggedError("SandboxUnavailable")<{
	provider: Provider;
	cause: unknown;
}> {}

/** The provider no longer has this sandbox, and whatever was in it is gone. */
export class Missing extends Data.TaggedError("SandboxMissing")<{
	provider: Provider;
	sandboxId: string;
}> {}

/** A file could not be read or written, for a reason the agent can act on. */
export class FileFailed extends Data.TaggedError("SandboxFileFailed")<{
	path: string;
	reason: string;
}> {}
