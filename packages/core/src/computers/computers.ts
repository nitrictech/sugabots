export * as Computers from "./computers.ts";

import type { ComputerNetworkMode } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { type Brand, Context, Data, type Duration, Effect, Layer, type Redacted } from "effect";
import { Ids } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";
import { fromE2b } from "./implementations/e2b.ts";
import { fromOpenSandbox } from "./implementations/opensandbox.ts";

export interface Interface {
	/** The provider a workspace's connection describes. */
	readonly forConnection: (connection: Connection) => Provider;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Computers") {}

export const make = Effect.gen(function* () {
	const ids = yield* Ids.Service;
	return Service.of({
		forConnection: (connection) => {
			switch (connection.provider) {
				case "e2b":
					return fromE2b(connection, ids);
				case "opensandbox":
					return fromOpenSandbox(connection, ids);
			}
		},
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps;

/**
 * Makes and reaches the machines of one provider account.
 *
 * A provider knows nothing about bots, turns or leases: which computer belongs
 * to what, and when one may be paused, is decided above it.
 */
export interface Provider {
	readonly capabilities: Capabilities;
	/** What its computers reach: see {@link Reach}. */
	readonly networkMode: ComputerNetworkMode;
	/**
	 * For a provider that makes computers from a template it builds from an
	 * image, as E2B does: building the connection's template. Absent for one
	 * that takes an image as it is, as OpenSandbox does.
	 */
	readonly templates?: TemplateBuilds;
	/** Whether the service answers and accepts the key, without making anything. */
	readonly check: Effect.Effect<void, Unavailable>;
	/**
	 * A new computer, set up for bots to work in. One whose setup fails is
	 * destroyed as far as the provider allows, since nothing else has its id.
	 */
	readonly create: (spec: Spec) => Effect.Effect<Computer, Unavailable>;
	/**
	 * The computer with this id, resumed first if it was paused. `resumed` says
	 * whether it was, so the bot can be told what a pause may have stopped.
	 */
	readonly open: (id: ComputerId) => Effect.Effect<Opened, Missing | Stopped | Unavailable>;
	/**
	 * How the computer stands at the provider, without resuming it. One that
	 * stopped with its work kept apart counts as paused, since opening it
	 * carries on from its files; one that stopped without is missing.
	 */
	readonly info: (id: ComputerId) => Effect.Effect<Info, Missing | Unavailable>;
	/** Stops the computer costing compute until it is opened again. */
	readonly pause: (id: ComputerId) => Effect.Effect<void, Missing | Unavailable>;
	/**
	 * Throws the computer away with everything in it, except work kept apart
	 * from it. One that is already gone counts as destroyed.
	 */
	readonly destroy: (id: ComputerId) => Effect.Effect<void, Unavailable>;
}

export interface TemplateBuilds {
	/** Starts building the connection's template from `image`, replacing what it was built from before. */
	readonly build: (image: string) => Effect.Effect<TemplateBuild, Unavailable>;
	/** How the template stands after `build`, the last one started. */
	readonly status: (build: TemplateBuild) => Effect.Effect<TemplateStatus, Unavailable>;
}

/** A template build the provider started, by its ids there. */
export interface TemplateBuild {
	readonly templateId: string;
	readonly buildId: string;
}

export type TemplateStatus = "missing" | "building" | "ready" | "failed";

export interface Info {
	readonly state: "running" | "paused";
	/**
	 * The image or template it was made from, as the provider names it, which
	 * may be another name for it than it was made with: a tag for an image
	 * made from its digest.
	 */
	readonly image: string;
	/**
	 * Whether its {@link WORKSPACE_DIRECTORY} is kept apart from it, so a new
	 * computer made with the same {@link Spec.workName} carries on with that
	 * work. Otherwise the work goes with the computer and must be copied out.
	 */
	readonly workKeptApart: boolean;
}

export interface Capabilities {
	/**
	 * What survives a pause: `memory` keeps running programs, `disk` keeps
	 * only files, so programs have stopped by the time a computer is opened.
	 */
	readonly pauseKeeps: "memory" | "disk";
	/**
	 * How it can add credentials to the computer's requests outside the
	 * computer, so nothing in it ever holds them: `none`, by `host` alone, or
	 * by `host-and-path`. See {@link Network.credentials}.
	 */
	readonly credentials: "none" | "host" | "host-and-path";
	/**
	 * Whether it can refuse hosts by name to a computer that reaches everything
	 * else. E2B denies addresses but never names, so its open computers reach
	 * blocked hosts too. See {@link Reach}.
	 */
	readonly blocksHosts: boolean;
}

/** What a workspace's settings say about reaching its provider. */
export type Connection = E2bConnection | OpenSandboxConnection;

export interface E2bConnection {
	readonly provider: "e2b";
	readonly apiKey: Redacted.Redacted;
	/**
	 * Where the API and computers are reached. Unset, E2B Cloud. E2B Embed
	 * answers over plain HTTP at its own address, so it gives both URLs.
	 */
	readonly endpoints?: { readonly apiUrl: string; readonly sandboxUrl: string };
	/** The template computers are made from. */
	readonly template: string;
	/** What the template is built with, so every computer made from it has. */
	readonly size: Size;
	readonly networkMode: ComputerNetworkMode;
}

export interface OpenSandboxConnection {
	readonly provider: "opensandbox";
	/** The server's address, such as http://localhost:8090. */
	readonly baseUrl: string;
	readonly apiKey: Redacted.Redacted;
	/** The image computers are made from. */
	readonly image: string;
	/** The most each computer may use, set when it is made. */
	readonly size: Size;
	readonly networkMode: ComputerNetworkMode;
}

export interface Size {
	readonly cpuCount: number;
	readonly memoryGiB: number;
}

export type ComputerId = Brand.Branded<string, "ComputerId">;

export const ComputerId = (id: string) => id as ComputerId;

export interface Spec {
	/** Written on the provider's record of the computer, so it can be found from the provider's side. */
	readonly labels: Readonly<Record<string, string>>;
	readonly reach: Reach;
	/**
	 * Names the work in its {@link WORKSPACE_DIRECTORY}: lowercase letters,
	 * digits and dashes. A provider that keeps work apart from the computer
	 * gives every computer made with this name the same work.
	 */
	readonly workName: string;
}

export interface Opened {
	readonly computer: Computer;
	readonly resumed: boolean;
}

/** Where bots work. It belongs to the bots' user. */
export const WORKSPACE_DIRECTORY = "/workspace";

/**
 * Where each conversation's folder is, named by the conversation's id. Called
 * `threads`, as the computers made before keep it.
 */
export const CONVERSATIONS_DIRECTORY = `${WORKSPACE_DIRECTORY}/threads`;

/**
 * Where each bot's home is, named by the bot's id. Its name is kept as the
 * computers made before bots had their name have it, with every home in it.
 */
export const BOTS_DIRECTORY = `${WORKSPACE_DIRECTORY}/agents`;

export interface Computer {
	readonly id: ComputerId;
	/**
	 * Runs a shell command as the bots' user. A command that runs and fails
	 * is an execution with its exit code, not an error.
	 */
	readonly exec: (command: string, options: ExecOptions) => Effect.Effect<Execution, Unavailable>;
	/** Reads at most `maxBytes` from the start of a regular file, as the bots' user. */
	readonly readFile: (
		path: string,
		maxBytes: number,
	) => Effect.Effect<FileStart, FileFailed | Unavailable>;
	/** Writes the file as the bots' user, making its directories. */
	readonly writeFile: (
		path: string,
		content: Uint8Array,
	) => Effect.Effect<void, FileFailed | Unavailable>;
	/**
	 * Copies a whole file Sugabots made out of the computer, however large,
	 * through the provider's file API. That API may act as root, so the path
	 * must be one no bot chose or could guess.
	 */
	readonly downloadFile: (path: string) => Effect.Effect<Uint8Array, FileFailed | Unavailable>;
	/**
	 * Puts a file in the computer for Sugabots, owned by the bots' user, on
	 * the same terms as {@link downloadFile}.
	 */
	readonly uploadFile: (
		path: string,
		content: Uint8Array,
	) => Effect.Effect<void, FileFailed | Unavailable>;
	/**
	 * Where Sugabots reaches `port` inside the computer, over HTTP or a
	 * WebSocket. Only Sugabots should be given it: it may need no credential.
	 */
	readonly endpoint: (port: number) => Effect.Effect<Endpoint, Unavailable>;
	/**
	 * Replaces what it may connect to and the credentials added to its
	 * requests, while it runs and after a pause. Connections Sugabots makes to
	 * it are not affected.
	 */
	readonly setNetwork: (network: Network) => Effect.Effect<void, Unavailable>;
}

/** What a computer may connect to, and what is added to its requests on the way. */
export interface Network {
	readonly reach: Reach;
	/**
	 * Added to its HTTPS requests by the provider, outside the computer, as far
	 * as its {@link Capabilities.credentials} allow; empty for a provider that
	 * can't.
	 */
	readonly credentials: readonly Credential[];
	/**
	 * Set for its login shells, such as a placeholder token that tells a
	 * command-line tool it is signed in while the real one is added outside.
	 */
	readonly environment: Readonly<Record<string, string>>;
}

/**
 * What a computer may connect to, by its provider's {@link Provider.networkMode}:
 * only the `hosts` on an allowlist, or everything but its `blockedHosts`,
 * which are empty unless its {@link Capabilities.blocksHosts}. A
 * host is a domain name or a leading wildcard such as `*.example.com`, which
 * leaves the domain itself out.
 */
export type Reach =
	| { readonly kind: "allowlist"; readonly hosts: readonly string[] }
	| { readonly kind: "open"; readonly blockedHosts: readonly string[] };

/**
 * A header the provider sets on the computer's HTTPS requests to `host`, in
 * place of any the computer sent: on every path, or only those under
 * `pathPrefix` where the provider matches paths. Never on plain HTTP, and
 * never put in a body, query or path, where the computer could have it sent
 * on or stored.
 */
export interface Credential {
	/** An exact host name: a wildcard could match a host someone else serves. */
	readonly host: string;
	/** Such as `/acme/`; undefined for every path. */
	readonly pathPrefix: string | undefined;
	readonly header: string;
	readonly value: Redacted.Redacted;
}

/** Where a computer's {@link Network.environment} is written, for login shells to read. */
export const NETWORK_ENVIRONMENT_FILE = "/etc/profile.d/sugabots-network.sh";

/** {@link Network.environment} as a script for {@link NETWORK_ENVIRONMENT_FILE}. */
export function environmentScript(environment: Readonly<Record<string, string>>) {
	return Object.entries(environment)
		.map(([name, value]) => `export ${name}=${shellQuoted(value)}\n`)
		.join("");
}

export interface Endpoint {
	/** The port's root, such as `http://172.17.0.1:50699/proxy/8931`, without a trailing slash. */
	readonly url: string;
	/** Headers every request to it must carry. */
	readonly headers: Readonly<Record<string, string>>;
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
	/** Whether the start was dropped to keep within the limit. */
	readonly truncated: boolean;
}

/** The start of a file, as {@link Computer.readFile} reads it. */
export interface FileStart {
	readonly content: Uint8Array;
	/** The whole file's size, which is more than `content` when it was cut off. */
	readonly sizeBytes: number;
}

/** The provider could not be reached, refused the request, or failed doing it. */
export class Unavailable
	extends Data.TaggedError("ComputerUnavailable")<{
		provider: Connection["provider"];
		cause: unknown;
		/** What went wrong, when the provider said something people can act on. */
		reason?: UserText;
	}>
	implements UserFacing
{
	get userMessage() {
		return this.reason ?? userText`The computer provider didn't answer. Try again shortly.`;
	}
}

/** The provider no longer has the computer. */
export class Missing extends Data.TaggedError("ComputerMissing")<{
	provider: Connection["provider"];
	computerId: ComputerId;
}> {}

/**
 * The computer stopped without being paused, as when its host shut down, and
 * the provider can't start it again. `workKept` says whether its work is kept
 * apart from it, for a new computer made with the same {@link Spec.workName}.
 */
export class Stopped extends Data.TaggedError("ComputerStopped")<{
	provider: Connection["provider"];
	computerId: ComputerId;
	workKept: boolean;
}> {}

/** A refusal about the file itself, which the bot can do something about. */
export class FileFailed extends Data.TaggedError("ComputerFileFailed")<{
	path: string;
	reason: UserText;
}> {}

/** Keeps the last `limit` characters of output as it arrives. */
export function outputTail(limit: number) {
	let text = "";
	let truncated = false;
	return {
		append(chunk: string) {
			text += chunk;
			if (text.length > limit) {
				truncated = true;
				text = text.slice(-limit);
			}
		},
		captured: (): CapturedOutput => ({ text, truncated }),
	};
}

/**
 * `command`, run so that the computer keeps only the end of each stream, and
 * the command's exit code. The providers' SDKs hold every byte a command
 * prints, so without this a command printing without end would fill the
 * API's memory. Enough bytes are kept for `maxOutputCharacters` of any text,
 * so {@link outputTail} still sees when the start was dropped.
 */
export function keepingOutputEnd(command: string, maxOutputCharacters: number) {
	const bytes = (maxOutputCharacters + 1) * MAX_UTF8_BYTES_PER_CHARACTER;
	// Each stream gets its own pipe through fd 3, which the command doesn't
	// keep: a pipe it held besides its stdout and stderr would pass to what it
	// starts in the background, and the tails would wait for that to end.
	return `{ bash -c ${shellQuoted(command)} 2>&1 1>&3 3>&- | tail -c ${bytes} >&2; exit \${PIPESTATUS[0]}; } 3>&1 | tail -c ${bytes}; exit \${PIPESTATUS[0]}`;
}

const MAX_UTF8_BYTES_PER_CHARACTER = 4;

/**
 * {@link Computer.readFile} through `exec`, which runs as the bots' user, so
 * a file is read only if they may read it, and only its start leaves the
 * computer, as base 64.
 */
export function readFileThroughExec(
	exec: Computer["exec"],
	path: string,
	maxBytes: number,
): Effect.Effect<FileStart, FileFailed | Unavailable> {
	const file = shellQuoted(path);
	const script = [
		"set -o pipefail",
		`[ -e ${file} ] || exit ${READ_EXIT.missing}`,
		`[ -f ${file} ] || exit ${READ_EXIT.notRegular}`,
		`[ -r ${file} ] || exit ${READ_EXIT.unreadable}`,
		`stat -L -c %s -- ${file}`,
		`head -c ${maxBytes} -- ${file} | base64 -w 0`,
	].join("\n");
	return Effect.flatMap(
		exec(script, {
			timeout: READ_TIMEOUT,
			maxOutputCharacters: Math.ceil(maxBytes / 3) * 4 + SIZE_LINE_CHARACTERS,
		}),
		(ran) => {
			if (ran.exitCode !== 0) {
				return Effect.fail(new FileFailed({ path, reason: readRefusal(ran.exitCode) }));
			}
			const [size = "", encoded = ""] = ran.stdout.text.split("\n");
			return Effect.succeed({
				content: Buffer.from(encoded, "base64"),
				sizeBytes: Number(size),
			});
		},
	);
}

/**
 * {@link Computer.writeFile} for a provider whose file API acts as root: the
 * content is uploaded to `staged`, which must be a path no bot can guess,
 * then copied into place through `exec`, as the bots' user, so it goes
 * only where they may write.
 */
export function writeFileThroughStaging(
	computer: Pick<Computer, "exec" | "uploadFile">,
	staged: string,
	path: string,
	content: Uint8Array,
): Effect.Effect<void, FileFailed | Unavailable> {
	const copy = [
		`mkdir -p -- "$(dirname -- ${shellQuoted(path)})"`,
		`cat -- ${staged} > ${shellQuoted(path)}`,
	].join(" && ");
	return computer.uploadFile(staged, content).pipe(
		Effect.andThen(
			computer.exec(`${copy}; status=$?; rm -f -- ${staged}; exit $status`, COPY_OPTIONS),
		),
		Effect.flatMap((copied) =>
			copied.exitCode === 0
				? Effect.void
				: Effect.fail(
						new FileFailed({
							path,
							reason: userText`The path is a directory, or can't be written`,
						}),
					),
		),
	);
}

const COPY_OPTIONS = { timeout: "60 seconds", maxOutputCharacters: 2_000 } as const;

const READ_EXIT = { missing: 3, notRegular: 4, unreadable: 5 } as const;
const READ_TIMEOUT = "60 seconds";
/** Room for the size line before the content. */
const SIZE_LINE_CHARACTERS = 32;

function readRefusal(exitCode: number | null) {
	switch (exitCode) {
		case READ_EXIT.missing:
			return userText`No such file`;
		case READ_EXIT.notRegular:
			return userText`It isn't a regular file, such as a directory or a device`;
		case READ_EXIT.unreadable:
			return userText`You don't have permission to read it`;
		default:
			return userText`It couldn't be read`;
	}
}

/** `text` as one single-quoted bash word. */
export function shellQuoted(text: string) {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}
