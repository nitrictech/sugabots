export * as Sandboxes from "./sandboxes.ts";

import { type Brand, Context, Data, type Duration, Effect, Layer, type Redacted } from "effect";
import { type UserFacing, UserMessage } from "../user-message.ts";
import { fromE2b } from "./implementations/e2b.ts";
import { fromOpenSandbox } from "./implementations/opensandbox.ts";

export interface Interface {
	/** The provider a workspace's connection describes. */
	readonly forConnection: (connection: Connection) => Provider;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Sandboxes") {}

export const make = Effect.succeed<Interface>({
	forConnection: (connection) => {
		switch (connection.provider) {
			case "e2b":
				return fromE2b(connection);
			case "opensandbox":
				return fromOpenSandbox(connection);
		}
	},
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps;

/**
 * Makes and reaches the machines of one provider account.
 *
 * A provider knows nothing about pods, turns or leases: which sandbox belongs
 * to what, and when one may be paused, is decided above it.
 */
export interface Provider {
	readonly capabilities: Capabilities;
	/**
	 * For a provider that makes sandboxes from a template it builds from an
	 * image, as E2B does: building the connection's template. Absent for one
	 * that takes an image as it is, as OpenSandbox does.
	 */
	readonly templates?: TemplateBuilds;
	/** Whether the service answers and accepts the key, without making anything. */
	readonly check: Effect.Effect<void, Unavailable>;
	readonly create: (spec: Spec) => Effect.Effect<Sandbox, Unavailable>;
	/**
	 * The sandbox with this id, resumed first if it was paused. `resumed` says
	 * whether it was, so the agent can be told what a pause may have stopped.
	 */
	readonly open: (id: SandboxId) => Effect.Effect<Opened, Missing | Stopped | Unavailable>;
	/**
	 * How the sandbox stands at the provider, without resuming it. One that
	 * stopped with its work kept apart counts as paused, since opening it
	 * carries on from its files; one that stopped without is missing.
	 */
	readonly info: (id: SandboxId) => Effect.Effect<Info, Missing | Unavailable>;
	/** Stops the sandbox costing compute until it is opened again. */
	readonly pause: (id: SandboxId) => Effect.Effect<void, Missing | Unavailable>;
	/**
	 * Throws the sandbox away with everything in it, except work kept apart
	 * from it. One that is already gone counts as destroyed.
	 */
	readonly destroy: (id: SandboxId) => Effect.Effect<void, Unavailable>;
}

export interface TemplateBuilds {
	/** Starts building the connection's template from `image`, replacing what it was built from before. */
	readonly build: (image: string) => Effect.Effect<TemplateBuild, Unavailable>;
	/** How the template stands: by `build`, the last one started, or by whether it exists at all. */
	readonly status: (build: TemplateBuild | undefined) => Effect.Effect<TemplateStatus, Unavailable>;
}

/** A template build the provider started, by its ids there. */
export interface TemplateBuild {
	readonly templateId: string;
	readonly buildId: string;
}

export type TemplateStatus = "missing" | "building" | "ready" | "failed";

export interface Info {
	readonly state: "running" | "paused";
	/** The image or template it was made from, as the provider names it. */
	readonly image: string;
	/**
	 * Whether its {@link WORKSPACE_DIRECTORY} is kept apart from it, so a new
	 * sandbox made with the same {@link Spec.workName} carries on with that
	 * work. Otherwise the work goes with the sandbox and must be copied out.
	 */
	readonly workKeptApart: boolean;
}

export interface Capabilities {
	/**
	 * What survives a pause: `memory` keeps running programs, `disk` keeps
	 * only files, so programs have stopped by the time a sandbox is opened.
	 */
	readonly pauseKeeps: "memory" | "disk";
}

/** What a workspace's settings say about reaching its provider. */
export type Connection = E2bConnection | OpenSandboxConnection;

export interface E2bConnection {
	readonly provider: "e2b";
	readonly apiKey: Redacted.Redacted;
	/**
	 * Where the API and sandboxes are reached. Unset, E2B Cloud. E2B Embed
	 * answers over plain HTTP at its own address, so it gives both URLs.
	 */
	readonly endpoints?: { readonly apiUrl: string; readonly sandboxUrl: string };
	/** The template sandboxes are made from. */
	readonly template: string;
}

export interface OpenSandboxConnection {
	readonly provider: "opensandbox";
	/** The server's address, such as http://localhost:8090. */
	readonly baseUrl: string;
	readonly apiKey: Redacted.Redacted;
	/** The image sandboxes are made from. */
	readonly image: string;
}

export type SandboxId = Brand.Branded<string, "SandboxId">;

export const SandboxId = (id: string) => id as SandboxId;

export interface Spec {
	/** Written on the provider's record of the sandbox, so it can be found from the provider's side. */
	readonly labels: Readonly<Record<string, string>>;
	/** The hosts it may connect to; it is refused everything else. See {@link Sandbox.setAllowedHosts}. */
	readonly allowedHosts: readonly string[];
	/**
	 * Names the work in its {@link WORKSPACE_DIRECTORY}: lowercase letters,
	 * digits and dashes. A provider that keeps work apart from the sandbox
	 * gives every sandbox made with this name the same work.
	 */
	readonly workName: string;
}

export interface Opened {
	readonly sandbox: Sandbox;
	readonly resumed: boolean;
}

/** Where agents work. It belongs to the agents' user. */
export const WORKSPACE_DIRECTORY = "/workspace";

export interface Sandbox {
	readonly id: SandboxId;
	/**
	 * Runs a shell command as the agents' user. A command that runs and fails
	 * is an execution with its exit code, not an error.
	 */
	readonly exec: (command: string, options: ExecOptions) => Effect.Effect<Execution, Unavailable>;
	readonly readFile: (path: string) => Effect.Effect<Uint8Array, FileFailed | Unavailable>;
	/** Writes the file as the agents' user, making its directories. */
	readonly writeFile: (
		path: string,
		content: Uint8Array,
	) => Effect.Effect<void, FileFailed | Unavailable>;
	/**
	 * Lets it connect to `hosts` and nothing else, in place of what it was
	 * allowed before, while it runs and after a pause. A host is a domain name
	 * or a leading wildcard such as `*.example.com`, which leaves the domain
	 * itself out. Connections Sugabots makes to it are not affected.
	 */
	readonly setAllowedHosts: (hosts: readonly string[]) => Effect.Effect<void, Unavailable>;
}

export interface ExecOptions {
	/** Absolute directory to run in. Unset, {@link WORKSPACE_DIRECTORY}. */
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** After this the command is stopped, and its execution has no exit code. */
	readonly timeout: Duration.Input;
	/** At most this much of each stream is kept, from the end, since the end is where errors are. */
	readonly maxOutputCharacters: number;
}

export interface Execution {
	/** Null when the command did not finish: it timed out or was stopped. */
	readonly exitCode: number | null;
	readonly stdout: CapturedOutput;
	readonly stderr: CapturedOutput;
}

export interface CapturedOutput {
	readonly text: string;
	/** How much was dropped from the start to keep within the limit. */
	readonly droppedCharacters: number;
}

/** The provider could not be reached, refused the request, or failed doing it. */
export class Unavailable
	extends Data.TaggedError("SandboxUnavailable")<{
		provider: Connection["provider"];
		cause: unknown;
		/** What went wrong, when the provider said something people can act on. */
		reason?: UserMessage;
	}>
	implements UserFacing
{
	get userMessage() {
		return this.reason ?? UserMessage.of`The sandbox provider didn't answer. Try again shortly.`;
	}
}

/** The provider no longer has the sandbox. */
export class Missing extends Data.TaggedError("SandboxMissing")<{
	provider: Connection["provider"];
	sandboxId: SandboxId;
}> {}

/**
 * The sandbox stopped without being paused, as when its host shut down, and
 * the provider can't start it again. `workKept` says whether its work is kept
 * apart from it, for a new sandbox made with the same {@link Spec.workName}.
 */
export class Stopped extends Data.TaggedError("SandboxStopped")<{
	provider: Connection["provider"];
	sandboxId: SandboxId;
	workKept: boolean;
}> {}

/** A refusal about the file itself, which the agent can do something about. */
export class FileFailed extends Data.TaggedError("SandboxFileFailed")<{
	path: string;
	reason: UserMessage;
}> {}

/** Keeps the last `limit` characters of output as it arrives. */
export function outputTail(limit: number) {
	let text = "";
	let dropped = 0;
	return {
		append(chunk: string) {
			text += chunk;
			if (text.length > limit) {
				dropped += text.length - limit;
				text = text.slice(-limit);
			}
		},
		captured: (): CapturedOutput => ({ text, droppedCharacters: dropped }),
	};
}
