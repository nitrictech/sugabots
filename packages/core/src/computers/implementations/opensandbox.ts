import {
	ConnectionConfig,
	type NetworkPolicy,
	type NetworkRule,
	type NetworkRuleAction,
	Sandbox as OpenSandbox,
	SandboxApiException,
	SandboxManager,
} from "@alibaba-group/opensandbox";
import { createLifecycleClient } from "@alibaba-group/opensandbox/internal";
import { DisplayName, userText } from "@sugabots/errors";
import { Duration, Effect, Redacted } from "effect";
import type { Ids } from "../../ids/ids.ts";
import { Computers } from "../computers.ts";

/**
 * Computers on an OpenSandbox server (github.com/alibaba/OpenSandbox), which
 * runs them as containers on Docker or Kubernetes. It is the provider for
 * local development on any OS, and for self-hosted installs.
 */

const REQUEST_TIMEOUT_SECONDS = 120;

/** How far past its own timeout a command may run before the call gives up on the server. */
const EXEC_GRACE = Duration.seconds(15);

/**
 * The user bots' commands run as, so nothing they run is root. The file API
 * names owners, so it needs a name as well as an id; `-o` lets it share its id
 * with a user the image already has, such as `node` in the Node images.
 */
const BOT_USER = { name: "bot", id: 1000, home: "/home/bot" } as const;

/** States in which the server has the sandbox but can't start it again. */
const STOPPED_STATES: ReadonlySet<string> = new Set(["Terminated", "Failed"]);

export const fromOpenSandbox = (
	access: Computers.OpenSandboxAccess,
	ids: Ids.Interface,
): Computers.Provider => {
	const url = new URL(access.baseUrl);
	const connectionConfig = () =>
		new ConnectionConfig({
			domain: url.host,
			protocol: url.protocol === "https:" ? "https" : "http",
			apiKey: Redacted.value(access.apiKey),
			requestTimeoutSeconds: REQUEST_TIMEOUT_SECONDS,
		});
	const manager = () => SandboxManager.create({ connectionConfig: connectionConfig() });
	/**
	 * Replaces the sandbox's whole egress policy. The SDK's own calls only
	 * patch rules and keep the default action the sandbox was made with.
	 */
	const replacePolicy = async (sandboxId: string, policy: NetworkPolicy) => {
		const lifecycle = createLifecycleClient({
			baseUrl: connectionConfig().getBaseUrl(),
			apiKey: Redacted.value(access.apiKey),
		});
		const { error, response } = await lifecycle.PUT("/sandboxes/{sandboxId}/networkpolicy", {
			params: { path: { sandboxId } },
			body: policy,
		});
		if (error !== undefined) {
			throw new SandboxApiException({
				message: `Replacing the network policy failed with HTTP ${response.status}`,
				statusCode: response.status,
				rawBody: error,
			});
		}
	};
	const unavailable = (cause: unknown) =>
		new Computers.Unavailable({ provider: "opensandbox", cause });
	const creationFailed = (cause: unknown) =>
		cause instanceof SandboxApiException &&
		cause.statusCode !== undefined &&
		!REFUSED_KEY.has(cause.statusCode)
			? new Computers.Unavailable({
					provider: "opensandbox",
					cause,
					reason: userText`OpenSandbox couldn't create a computer using image ${DisplayName.fromRecord(access.image)}. Check the OpenSandbox server logs for the cause.`,
				})
			: unavailable(cause);
	/** The server's 404 for a sandbox id means it no longer has that sandbox. */
	const missingOr = (id: Computers.ComputerId) => (cause: unknown) =>
		isNotFound(cause)
			? new Computers.Missing({ provider: "opensandbox", computerId: id })
			: unavailable(cause);

	return {
		// Docker keeps memory across a pause, but Kubernetes keeps only the
		// root filesystem, and the server doesn't say which it runs on.
		capabilities: { sleepKeeps: "disk", credentials: "host-and-path", blocksHosts: true },
		networkMode: access.networkMode,
		check: Effect.tryPromise({
			try: () => manager().listSandboxInfos({ pageSize: 1 }),
			catch: unavailable,
		}).pipe(Effect.asVoid),
		create: (spec) =>
			Effect.tryPromise({
				try: () =>
					OpenSandbox.create({
						connectionConfig: connectionConfig(),
						image: access.image,
						resource: {
							cpu: String(access.size.cpuCount),
							memory: `${access.size.memoryGiB}Gi`,
						},
						// Kept until Sugabots destroys it: a computer outlives any one turn.
						timeoutSeconds: null,
						metadata: spec.labels,
						networkPolicy: policyOf(spec.reach),
						// What lets the egress sidecar add credentials: it intercepts the
						// sandbox's HTTPS, with a CA the sandbox trusts.
						credentialProxy: { enabled: true },
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
								mountPath: Computers.WORK_DIRECTORY,
							},
						],
					}),
				catch: creationFailed,
			}).pipe(
				Effect.flatMap((sandbox) =>
					Effect.tryPromise({
						try: async () => {
							await prepareBotUser(sandbox);
							return toComputer(sandbox);
						},
						catch: unavailable,
					}).pipe(
						// Nothing has recorded it yet, so nothing else would find it to destroy.
						Effect.onError(() => Effect.tryPromise(() => sandbox.kill()).pipe(Effect.ignore)),
					),
				),
			),
		open: (id) =>
			Effect.tryPromise({
				try: async () => {
					const info = await manager().getSandboxInfo(id);
					if (STOPPED_STATES.has(info.status.state)) {
						throw new Computers.Stopped({ provider: "opensandbox", computerId: id });
					}
					const resumed = info.status.state === "Paused";
					const sandbox = resumed
						? await OpenSandbox.resume({ sandboxId: id, connectionConfig: connectionConfig() })
						: await OpenSandbox.connect({ sandboxId: id, connectionConfig: connectionConfig() });
					return { computer: toComputer(sandbox), resumed };
				},
				catch: (cause) => (cause instanceof Computers.Stopped ? cause : missingOr(id)(cause)),
			}),
		info: (id) =>
			Effect.tryPromise({
				try: async (): Promise<Computers.Info> => {
					const info = await manager().getSandboxInfo(id);
					const state = info.status.state;
					return {
						state:
							state === "Running" || state === "Pending" || state === "Resuming"
								? "running"
								: "asleep",
						// On its own volume, which outlives the sandbox.
						workKeptApart: true,
					};
				},
				catch: missingOr(id),
			}),
		sleep: (id) =>
			Effect.tryPromise({
				try: () => manager().pauseSandbox(id),
				catch: missingOr(id),
			}),
		destroy: (id) =>
			Effect.tryPromise({
				try: (signal) =>
					manager()
						.killSandbox(id, signal)
						.catch((cause: unknown) => {
							// Already gone, which is what destroying asks for.
							if (!isNotFound(cause)) throw cause;
						}),
				catch: unavailable,
			}),
	};

	function toComputer(sandbox: OpenSandbox): Computers.Computer {
		const exec: Computers.Computer["exec"] = (command, options) =>
			Effect.tryPromise({
				try: (signal) => run(sandbox, command, options, signal),
				catch: unavailable,
			});
		// The server's file API acts as root, so it is used only for files
		// Sugabots names; what bots read and write goes through `exec`.
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
							owner: BOT_USER.name,
							group: BOT_USER.name,
						},
					]),
				catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
			});
		return {
			id: Computers.ComputerId(sandbox.id),
			exec,
			readFile: (path, maxBytes) => Computers.readFileThroughExec(exec, path, maxBytes),
			writeFile: (path, content) =>
				Effect.flatMap(ids.random, (random) =>
					Computers.writeFileThroughStaging(
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
							: `${access.baseUrl.startsWith("https:") ? "https" : "http"}://${endpoint.endpoint}`;
						return { url: url.replace(/\/$/, ""), headers: { ...endpoint.headers } };
					},
					catch: unavailable,
				}),
			setNetwork: (network) =>
				Effect.tryPromise({
					try: async () => {
						const wanted = policyOf(network.reach);
						const current = await sandbox.getEgressPolicy();
						// The vault refuses a credential for a host the sandbox may not
						// reach, so while it changes the sandbox reaches what either
						// policy lets through.
						const meanwhile = eitherOf(current, wanted);
						if (!isSamePolicy(meanwhile, current)) await replacePolicy(sandbox.id, meanwhile);
						await setCredentials(sandbox, network.credentials);
						if (!isSamePolicy(wanted, meanwhile)) await replacePolicy(sandbox.id, wanted);
					},
					catch: unavailable,
				}),
		};
	}
};

/** The Docker volume or Kubernetes claim a sandbox's work is on. */
export function workVolume(workName: string) {
	return `sugabots-work-${workName}`;
}

/**
 * Replaces the sandbox's Credential Vault with `credentials`, one binding
 * each, named by position so a refresh replaces them in place. A sandbox
 * with nothing to add has its vault removed.
 */
async function setCredentials(sandbox: OpenSandbox, credentials: readonly Computers.Credential[]) {
	const vault = sandbox.credentialVault;
	const current = await vault.get().catch((cause: unknown) => {
		if (isNotFound(cause)) return undefined;
		throw cause;
	});
	if (credentials.length === 0) {
		if (current) await vault.delete();
		return;
	}
	const named = credentials.map((credential, index) => ({
		name: `credential-${index}`,
		credential,
	}));
	const entries = named.map(({ name, credential }) => ({
		name,
		source: { value: Redacted.value(credential.value) },
	}));
	const bindings = named.map(({ name, credential }) => ({
		name,
		match: {
			schemes: ["https" as const],
			hosts: [credential.host],
			// A trailing * matches the path and everything under it; without
			// one, a path matches only itself.
			...(credential.pathPrefix ? { paths: [`${credential.pathPrefix}*`] } : {}),
		},
		auth: {
			type: "customHeaders" as const,
			headers: [{ name: credential.header, credential: name }],
		},
	}));
	if (!current) {
		await vault.create({ credentials: entries, bindings });
		return;
	}
	const wanted = new Set(named.map(({ name }) => name));
	const has = (names: readonly { name: string }[]) => new Set(names.map(({ name }) => name));
	const [hadCredentials, hadBindings] = [has(current.credentials), has(current.bindings)];
	await vault.patch({
		expectedRevision: current.revision,
		credentials: {
			add: entries.filter(({ name }) => !hadCredentials.has(name)),
			replace: entries.filter(({ name }) => hadCredentials.has(name)),
			delete: [...hadCredentials].filter((name) => !wanted.has(name)),
		},
		bindings: {
			add: bindings.filter(({ name }) => !hadBindings.has(name)),
			replace: bindings.filter(({ name }) => hadBindings.has(name)),
			delete: [...hadBindings].filter((name) => !wanted.has(name)),
		},
	});
}

function policyOf(reach: Computers.Reach): NetworkPolicy {
	return reach.kind === "allowed-hosts-only"
		? { defaultAction: "deny", egress: rulesFor("allow", reach.hosts) }
		: { defaultAction: "allow", egress: rulesFor("deny", reach.blockedHosts) };
}

/**
 * A policy that lets through whatever `a` or `b` does: an open one denies
 * only what every open policy denies and no other policy allows.
 */
function eitherOf(a: NetworkPolicy, b: NetworkPolicy): NetworkPolicy {
	const closed = [a, b].filter((policy) => !isOpen(policy));
	const allowed = new Set(closed.flatMap(targetsOf));
	const open = [a, b].filter(isOpen);
	if (open.length === 0) return { defaultAction: "deny", egress: rulesFor("allow", [...allowed]) };
	const deniedByAll = open
		.map((policy) => new Set(targetsOf(policy)))
		.reduce((denied, next) => denied.intersection(next));
	return {
		defaultAction: "allow",
		egress: rulesFor(
			"deny",
			[...deniedByAll].filter((target) => !allowed.has(target)),
		),
	};
}

/** An unset default action is the server's default, deny. */
function isOpen(policy: NetworkPolicy) {
	return policy.defaultAction === "allow";
}

/** What the policy's rules name: the hosts a closed policy allows, or an open policy denies. */
function targetsOf(policy: NetworkPolicy) {
	return (policy.egress ?? []).map((rule) => rule.target);
}

function isSamePolicy(a: NetworkPolicy, b: NetworkPolicy) {
	const sorted = (policy: NetworkPolicy) => targetsOf(policy).toSorted();
	return isOpen(a) === isOpen(b) && sorted(a).join() === sorted(b).join();
}

function rulesFor(action: NetworkRuleAction, hosts: readonly string[]): NetworkRule[] {
	return hosts.map((host) => ({ action, target: host }));
}

async function run(
	sandbox: OpenSandbox,
	command: string,
	options: Computers.ExecOptions,
	signal: AbortSignal,
): Promise<Computers.Execution> {
	const stdout = Computers.outputTail(options.maxOutputCharacters);
	const stderr = Computers.outputTail(options.maxOutputCharacters);
	const timeout = Duration.fromInputUnsafe(options.timeout);
	const execution = await sandbox.commands.run(
		Computers.keepingOutputEnd(command, options.maxOutputCharacters),
		{
			workingDirectory: options.cwd ?? Computers.WORK_DIRECTORY,
			timeoutSeconds: Math.ceil(Duration.toSeconds(timeout)),
			uid: BOT_USER.id,
			gid: BOT_USER.id,
			envs: { HOME: BOT_USER.home, ...options.env },
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
 * Makes the bots' user and the directories it works in. The image's own
 * default user is often root, which bots never are.
 */
async function prepareBotUser(sandbox: OpenSandbox) {
	const { name, id, home } = BOT_USER;
	const directories = `${Computers.WORK_DIRECTORY} ${home}`;
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
		throw new Error(`Could not prepare the bots' user: ${stderr}`);
	}
}

/** What the server answers for a missing or wrong API key, which is the key's fault, not the image's. */
const REFUSED_KEY = new Set([401, 403]);

function isNotFound(cause: unknown) {
	return cause instanceof SandboxApiException && cause.statusCode === 404;
}

/** A refusal about the file itself, which the bot can do something about. */
function fileFailure(path: string, cause: unknown): Computers.FileFailed | undefined {
	if (!(cause instanceof SandboxApiException)) return undefined;
	if (cause.statusCode === 404) {
		return new Computers.FileFailed({ path, reason: userText`No such file` });
	}
	if (cause.statusCode === 400 || cause.statusCode === 403) {
		return new Computers.FileFailed({
			path,
			reason: userText`The path is a directory, or can't be written`,
		});
	}
	return undefined;
}
