import {
	ConnectionConfig,
	Sandbox as OpenSandbox,
	SandboxApiException,
	type SandboxInfo,
	SandboxManager,
} from "@alibaba-group/opensandbox";
import { userText } from "@sugabots/errors";
import { Duration, Effect, Redacted } from "effect";
import type { Ids } from "../../ids/ids.ts";
import { Sandboxes } from "../sandboxes.ts";

/**
 * Sandboxes on an OpenSandbox server (github.com/alibaba/OpenSandbox), which
 * runs them as containers on Docker or Kubernetes. It is the provider for
 * local development on any OS, and for self-hosted installs.
 */

const REQUEST_TIMEOUT_SECONDS = 120;

/** How far past its own timeout a command may run before the call gives up on the server. */
const EXEC_GRACE = Duration.seconds(15);

/**
 * The user agents' commands run as, so nothing they run is root. The file API
 * names owners, so it needs a name as well as an id; `-o` lets it share its id
 * with a user the image already has, such as `node` in the Node images.
 */
const AGENT_USER = { name: "agent", id: 1000, home: "/home/agent" } as const;

/**
 * Where a sandbox's metadata names the volume its work is on. Sandboxes made
 * before work had volumes have none, and their work goes with them.
 */
const WORK_VOLUME_KEY = "sugabots.work-volume";

/** States in which the server has the sandbox but can't start it again. */
const STOPPED_STATES: ReadonlySet<string> = new Set(["Terminated", "Failed"]);

export const fromOpenSandbox = (
	connection: Sandboxes.OpenSandboxConnection,
	ids: Ids.Interface,
): Sandboxes.Provider => {
	const url = new URL(connection.baseUrl);
	const connectionConfig = () =>
		new ConnectionConfig({
			domain: url.host,
			protocol: url.protocol === "https:" ? "https" : "http",
			apiKey: Redacted.value(connection.apiKey),
			requestTimeoutSeconds: REQUEST_TIMEOUT_SECONDS,
		});
	const manager = () => SandboxManager.create({ connectionConfig: connectionConfig() });
	const unavailable = (cause: unknown) =>
		new Sandboxes.Unavailable({ provider: "opensandbox", cause });
	/** The server's 404 for a sandbox id means it no longer has that sandbox. */
	const missingOr = (id: Sandboxes.SandboxId) => (cause: unknown) =>
		isNotFound(cause)
			? new Sandboxes.Missing({ provider: "opensandbox", sandboxId: id })
			: unavailable(cause);

	return {
		// Docker keeps memory across a pause, but Kubernetes keeps only the
		// root filesystem, and the server doesn't say which it runs on.
		capabilities: { pauseKeeps: "disk" },
		check: Effect.tryPromise({
			try: () => manager().listSandboxInfos({ pageSize: 1 }),
			catch: unavailable,
		}).pipe(Effect.asVoid),
		create: (spec) =>
			Effect.tryPromise({
				try: async () => {
					const sandbox = await OpenSandbox.create({
						connectionConfig: connectionConfig(),
						image: connection.image,
						// Kept until Sugabots destroys it: a pod's sandbox outlives any one turn.
						timeoutSeconds: null,
						metadata: { ...spec.labels, [WORK_VOLUME_KEY]: workVolume(spec.workName) },
						networkPolicy: { defaultAction: "deny", egress: allowRules(spec.allowedHosts) },
						// The work outlives the container, which a host shutting down
						// stops for good. The server has no call to remove a volume, so
						// the volume stays after its last sandbox is destroyed.
						volumes: [
							{
								name: "work",
								pvc: {
									claimName: workVolume(spec.workName),
									createIfNotExists: true,
									deleteOnSandboxTermination: false,
								},
								mountPath: Sandboxes.WORKSPACE_DIRECTORY,
							},
						],
					});
					await prepareAgentUser(sandbox);
					return toSandbox(sandbox);
				},
				catch: unavailable,
			}),
		open: (id) =>
			Effect.tryPromise({
				try: async () => {
					const info = await manager().getSandboxInfo(id);
					if (STOPPED_STATES.has(info.status.state)) {
						throw new Sandboxes.Stopped({
							provider: "opensandbox",
							sandboxId: id,
							workKept: keepsWorkApart(info),
						});
					}
					const resumed = info.status.state === "Paused";
					const sandbox = resumed
						? await OpenSandbox.resume({ sandboxId: id, connectionConfig: connectionConfig() })
						: await OpenSandbox.connect({ sandboxId: id, connectionConfig: connectionConfig() });
					return { sandbox: toSandbox(sandbox), resumed };
				},
				catch: (cause) => (cause instanceof Sandboxes.Stopped ? cause : missingOr(id)(cause)),
			}),
		info: (id) =>
			Effect.tryPromise({
				try: async (): Promise<Sandboxes.Info> => {
					const info = await manager().getSandboxInfo(id);
					const state = info.status.state;
					const workKeptApart = keepsWorkApart(info);
					if (STOPPED_STATES.has(state) && !workKeptApart) {
						throw new Sandboxes.Missing({ provider: "opensandbox", sandboxId: id });
					}
					return {
						state:
							state === "Running" || state === "Pending" || state === "Resuming"
								? "running"
								: "paused",
						image: String((info.image as { uri?: string } | undefined)?.uri ?? ""),
						workKeptApart,
					};
				},
				catch: (cause) => (cause instanceof Sandboxes.Missing ? cause : missingOr(id)(cause)),
			}),
		pause: (id) =>
			Effect.tryPromise({
				try: () => manager().pauseSandbox(id),
				catch: missingOr(id),
			}),
		destroy: (id) =>
			Effect.tryPromise({
				try: () =>
					manager()
						.killSandbox(id)
						.catch((cause: unknown) => {
							// Already gone, which is what destroying asks for.
							if (!isNotFound(cause)) throw cause;
						}),
				catch: unavailable,
			}),
	};

	function toSandbox(sandbox: OpenSandbox): Sandboxes.Sandbox {
		const exec: Sandboxes.Sandbox["exec"] = (command, options) =>
			Effect.tryPromise({
				try: (signal) => run(sandbox, command, options, signal),
				catch: unavailable,
			});
		// The server's file API acts as root, so it is used only for files
		// Sugabots names; what agents read and write goes through `exec`.
		const downloadFile = (path: string) =>
			Effect.tryPromise({
				try: () => sandbox.files.readBytes(path),
				catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
			});
		const uploadFile = (path: string, content: Uint8Array) =>
			Effect.tryPromise({
				try: () =>
					sandbox.files.writeFiles([
						{
							path,
							data: content,
							// Octal digits written as a decimal number, as the API reads them.
							mode: 644,
							owner: AGENT_USER.name,
							group: AGENT_USER.name,
						},
					]),
				catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
			});
		return {
			id: Sandboxes.SandboxId(sandbox.id),
			exec,
			readFile: (path, maxBytes) => Sandboxes.readFileThroughExec(exec, path, maxBytes),
			writeFile: (path, content) =>
				Effect.flatMap(ids.random, (random) =>
					Sandboxes.writeFileThroughStaging(
						{ exec, uploadFile: (staged, bytes) => uploadFile(staged, bytes).pipe(Effect.asVoid) },
						`/tmp/sugabots-write-${random}`,
						path,
						content,
					),
				),
			downloadFile,
			uploadFile: (path, content) => uploadFile(path, content).pipe(Effect.asVoid),
			endpoint: (port) =>
				Effect.tryPromise({
					try: async () => {
						const endpoint = await sandbox.getEndpoint(port);
						const url = endpoint.endpoint.includes("://")
							? endpoint.endpoint
							: `${connection.baseUrl.startsWith("https:") ? "https" : "http"}://${endpoint.endpoint}`;
						return { url: url.replace(/\/$/, ""), headers: { ...endpoint.headers } };
					},
					catch: unavailable,
				}),
			setAllowedHosts: (hosts) =>
				Effect.tryPromise({
					try: async () => {
						const { egress = [] } = await sandbox.getEgressPolicy();
						const stale = egress.filter((rule) => !hosts.includes(rule.target));
						if (stale.length > 0) await sandbox.deleteEgressRules(stale.map((rule) => rule.target));
						if (hosts.length > 0) await sandbox.patchEgressRules(allowRules(hosts));
					},
					catch: (cause) =>
						new Sandboxes.Unavailable({
							provider: "opensandbox",
							cause,
							// What the server answers for a sandbox made without a policy,
							// which has no egress sidecar to set one in.
							...(cause instanceof SandboxApiException && cause.statusCode === 502
								? { reason: MADE_WITHOUT_NETWORK_RULES }
								: {}),
						}),
				}),
		};
	}
};

/** The Docker volume or Kubernetes claim a sandbox's work is on. */
function workVolume(workName: string) {
	return `sugabots-work-${workName}`;
}

function keepsWorkApart(info: SandboxInfo) {
	return info.metadata?.[WORK_VOLUME_KEY] !== undefined;
}

function allowRules(hosts: readonly string[]) {
	return hosts.map((host) => ({ action: "allow" as const, target: host }));
}

const MADE_WITHOUT_NETWORK_RULES = userText`The pod's sandbox was made before sandboxes had network rules, so it can't be kept to them. Upgrade it under Sandbox in the pod's settings: its work is kept.`;

async function run(
	sandbox: OpenSandbox,
	command: string,
	options: Sandboxes.ExecOptions,
	signal: AbortSignal,
): Promise<Sandboxes.Execution> {
	const stdout = Sandboxes.outputTail(options.maxOutputCharacters);
	const stderr = Sandboxes.outputTail(options.maxOutputCharacters);
	const timeout = Duration.fromInputUnsafe(options.timeout);
	const execution = await sandbox.commands.run(
		Sandboxes.keepingOutputEnd(command, options.maxOutputCharacters),
		{
			workingDirectory: options.cwd ?? Sandboxes.WORKSPACE_DIRECTORY,
			timeoutSeconds: Math.ceil(Duration.toSeconds(timeout)),
			uid: AGENT_USER.id,
			gid: AGENT_USER.id,
			envs: { HOME: AGENT_USER.home, ...options.env },
		},
		// Output arrives a line at a time with its line break taken off.
		{
			onStdout: (message) => stdout.append(`${message.text}\n`),
			onStderr: (message) => stderr.append(`${message.text}\n`),
		},
		AbortSignal.any([
			signal,
			AbortSignal.timeout(Duration.toMillis(Duration.sum(timeout, EXEC_GRACE))),
		]),
	);
	const exitCode = execution.exitCode;
	return {
		// Negative when the server stopped the command at its timeout.
		exitCode: exitCode === undefined || exitCode === null || exitCode < 0 ? null : exitCode,
		stdout: stdout.captured(),
		stderr: stderr.captured(),
	};
}

/**
 * Makes the agents' user and the directories it works in. The image's own
 * default user is often root, which agents never are.
 */
async function prepareAgentUser(sandbox: OpenSandbox) {
	const { name, id, home } = AGENT_USER;
	const directories = `${Sandboxes.WORKSPACE_DIRECTORY} ${home}`;
	const prepared = await sandbox.commands.run(
		[
			`getent group ${name} >/dev/null || groupadd -o -g ${id} ${name}`,
			`id -u ${name} >/dev/null 2>&1 || useradd -o -u ${id} -g ${id} -M -d ${home} -s /bin/bash ${name}`,
			`mkdir -p ${directories}`,
			`chown ${id}:${id} ${directories}`,
		].join(" && "),
	);
	if (prepared.exitCode !== 0) {
		const stderr = prepared.logs.stderr.map((line) => line.text).join("\n");
		throw new Error(`Could not prepare the agents' user: ${stderr}`);
	}
}

function isNotFound(cause: unknown) {
	return cause instanceof SandboxApiException && cause.statusCode === 404;
}

/** A refusal about the file itself, which the agent can do something about. */
function fileFailure(path: string, cause: unknown): Sandboxes.FileFailed | undefined {
	if (!(cause instanceof SandboxApiException)) return undefined;
	if (cause.statusCode === 404) {
		return new Sandboxes.FileFailed({ path, reason: userText`No such file` });
	}
	if (cause.statusCode === 400 || cause.statusCode === 403) {
		return new Sandboxes.FileFailed({
			path,
			reason: userText`The path is a directory, or can't be written`,
		});
	}
	return undefined;
}
