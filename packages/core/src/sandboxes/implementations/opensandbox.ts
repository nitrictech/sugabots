import {
	ConnectionConfig,
	type NetworkPolicy,
	Sandbox as OpenSandbox,
	SandboxApiException,
	SandboxManager,
} from "@alibaba-group/opensandbox";
import { Effect } from "effect";
import { Sandbox } from "../sandbox.ts";

/**
 * Sandboxes on an OpenSandbox server (github.com/opensandbox-group/OpenSandbox).
 *
 * The server runs each sandbox with an egress sidecar that enforces its
 * allowlist, so the policy is set when the sandbox is made and holds whatever
 * the agent runs. Isolation is whatever runtime the server was configured
 * with, which it cannot report, so the workspace's admin declares it.
 */

const REQUEST_TIMEOUT_SECONDS = 120;
/** How far past its own timeout a command may run before the call gives up on the server. */
const EXEC_GRACE_SECONDS = 15;

export const fromOpenSandbox = (connection: Sandbox.Connection): Sandbox.Interface => {
	const url = new URL(connection.baseUrl);
	const connectionConfig = () =>
		new ConnectionConfig({
			domain: url.host,
			protocol: url.protocol === "https:" ? "https" : "http",
			apiKey: connection.apiKey,
			requestTimeoutSeconds: REQUEST_TIMEOUT_SECONDS,
		});
	const unavailable = (cause: unknown) =>
		new Sandbox.Unavailable({ provider: "opensandbox", cause });
	/** The server's 404 for a sandbox id means it no longer has that sandbox. */
	const missingOr = (cause: unknown, id: string) =>
		cause instanceof SandboxApiException && cause.statusCode === 404
			? new Sandbox.Missing({ provider: "opensandbox", sandboxId: id })
			: unavailable(cause);

	return {
		provider: "opensandbox",
		isolation: connection.isolation,
		create: (spec) =>
			Effect.tryPromise({
				try: async () => {
					const sandbox = await OpenSandbox.create({
						connectionConfig: connectionConfig(),
						image: connection.image,
						// Kept until Sugabots removes it: a pod's sandbox outlives any one turn.
						timeoutSeconds: null,
						metadata: spec.labels,
						// The egress sidecar that enforces the list is also what adds git
						// credentials, so a sandbox made to reach anywhere can't be given them.
						...(connection.allowedHosts.kind === "only"
							? {
									networkPolicy: networkPolicy(connection.allowedHosts.hosts),
									credentialProxy: { enabled: true },
								}
							: {}),
					});
					await prepareAgentUser(sandbox);
					return sandbox;
				},
				catch: unavailable,
			}).pipe(Effect.map(toHandle)),
		connect: (id) =>
			Effect.tryPromise({
				try: () => OpenSandbox.connect({ sandboxId: id, connectionConfig: connectionConfig() }),
				catch: (cause) => missingOr(cause, id),
			}).pipe(Effect.map(toHandle)),
		// Docker pauses keep memory, but a Kubernetes pause keeps only the root
		// filesystem, and the server doesn't say which it runs.
		pauseKeeps: "filesystem",
		pause: (id) =>
			Effect.tryPromise({
				try: () => SandboxManager.create({ connectionConfig: connectionConfig() }).pauseSandbox(id),
				catch: (cause) => missingOr(cause, id),
			}),
		destroy: (id) =>
			Effect.tryPromise({
				try: () => SandboxManager.create({ connectionConfig: connectionConfig() }).killSandbox(id),
				catch: (cause) => missingOr(cause, id),
			}),
		resume: (id) =>
			Effect.tryPromise({
				try: () => OpenSandbox.resume({ sandboxId: id, connectionConfig: connectionConfig() }),
				catch: (cause) => missingOr(cause, id),
			}).pipe(Effect.map(toHandle)),
		check: Effect.tryPromise({
			try: () =>
				SandboxManager.create({ connectionConfig: connectionConfig() }).listSandboxInfos({
					pageSize: 1,
				}),
			catch: unavailable,
		}).pipe(Effect.asVoid),
	};

	function toHandle(sandbox: OpenSandbox): Sandbox.Handle {
		return {
			id: sandbox.id,
			exec: (command, options) =>
				Effect.tryPromise({
					try: async () => {
						const stdout = Sandbox.outputTail(options.maxOutputCharacters);
						const stderr = Sandbox.outputTail(options.maxOutputCharacters);
						const execution = await sandbox.commands.run(
							command,
							{
								workingDirectory: options.cwd,
								timeoutSeconds: options.timeoutSeconds,
								uid: Sandbox.AGENT_USER_ID,
								gid: Sandbox.AGENT_USER_ID,
								envs: { HOME: Sandbox.AGENT_HOME_DIRECTORY },
							},
							// Output arrives a line at a time with its line break taken off.
							{
								onStdout: (message) => stdout.append(`${message.text}\n`),
								onStderr: (message) => stderr.append(`${message.text}\n`),
							},
							AbortSignal.any([
								...(options.signal ? [options.signal] : []),
								AbortSignal.timeout((options.timeoutSeconds + EXEC_GRACE_SECONDS) * 1_000),
							]),
						);
						return {
							// Negative when the server stopped the command at its timeout.
							exitCode:
								execution.exitCode === undefined ||
								execution.exitCode === null ||
								execution.exitCode < 0
									? null
									: execution.exitCode,
							stdout: stdout.captured(),
							stderr: stderr.captured(),
						} satisfies Sandbox.Execution;
					},
					catch: unavailable,
				}),
			readFile: (path) =>
				Effect.tryPromise({
					try: () => sandbox.files.readBytes(path),
					catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
				}),
			writeFile: (path, content) =>
				Effect.tryPromise({
					try: () =>
						sandbox.files.writeFiles([
							{
								path,
								data: content,
								// Octal digits written as a decimal number, as the API reads them.
								mode: 644,
								owner: AGENT_USER_NAME,
								group: AGENT_USER_NAME,
							},
						]),
					catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
				}),
			setAllowedHosts: (hosts) =>
				Effect.tryPromise({
					try: async () => {
						const current = await sandbox.getEgressPolicy();
						const wanted = new Set(hosts);
						const stale = (current.egress ?? [])
							.map((rule) => rule.target)
							.filter((target) => !wanted.has(target));
						// Rules are merged by target, so a replacement is a delete and a patch.
						if (stale.length > 0) await sandbox.deleteEgressRules(stale);
						if (hosts.length > 0) {
							await sandbox.patchEgressRules(hosts.map((target) => ({ action: "allow", target })));
						}
					},
					catch: unavailable,
				}),
			setGitCredentials: (credentials) =>
				Effect.tryPromise({
					try: async () => {
						await sandbox.credentialVault.delete().catch((cause: unknown) => {
							if (!(cause instanceof SandboxApiException && cause.statusCode === 404)) throw cause;
						});
						if (!credentials || credentials.repositories.length === 0) return;
						await sandbox.credentialVault.create(gitVault(credentials));
					},
					catch: unavailable,
				}),
			disconnect: Effect.promise(() => sandbox.close()),
		};
	}
};

/**
 * OpenSandbox's file API names a file's owner rather than numbering it, so the
 * agents' user needs a name. `-o` lets it share its id with a user the image
 * already has, such as `node` in the Node images.
 */
const AGENT_USER_NAME = "agent";

/**
 * Makes the agents' user and the directories they work in. The image's own
 * default user is often root, which agents never are.
 */
async function prepareAgentUser(sandbox: OpenSandbox) {
	const id = Sandbox.AGENT_USER_ID;
	const name = AGENT_USER_NAME;
	const directories = `${Sandbox.WORKSPACE_DIRECTORY} ${Sandbox.AGENT_HOME_DIRECTORY}`;
	const prepared = await sandbox.commands.run(
		[
			`getent group ${name} >/dev/null || groupadd -o -g ${id} ${name}`,
			`id -u ${name} >/dev/null 2>&1 || useradd -o -u ${id} -g ${id} -M -d ${Sandbox.AGENT_HOME_DIRECTORY} -s /bin/bash ${name}`,
			`mkdir -p ${directories}`,
			`chown ${id}:${id} ${directories}`,
		].join(" && "),
	);
	if (prepared.exitCode !== 0) {
		throw new Error(
			`Could not prepare the agent's directories: ${prepared.logs.stderr.map((line) => line.text).join("")}`,
		);
	}
}

const GIT_CREDENTIAL = "git";

/**
 * Basic auth on the two requests a clone or fetch makes, for the listed
 * repositories only. A push starts with the same `info/refs` request but then
 * posts to `git-receive-pack`, which gets nothing, so GitHub refuses it.
 */
function gitVault(credentials: Sandbox.GitCredentials) {
	return {
		credentials: [
			{
				name: GIT_CREDENTIAL,
				source: {
					value: Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64"),
				},
			},
		],
		bindings: [
			{
				name: "git-fetch",
				match: {
					schemes: ["https" as const],
					hosts: [credentials.host],
					methods: ["GET", "POST"],
					paths: credentials.repositories.flatMap((repository) => [
						`/${repository}.git/info/refs`,
						`/${repository}.git/git-upload-pack`,
					]),
				},
				auth: { type: "basic" as const, credential: GIT_CREDENTIAL },
			},
		],
	};
}

/** Everything refused except the listed hosts. */
function networkPolicy(hosts: readonly string[]): NetworkPolicy {
	return {
		defaultAction: "deny",
		egress: hosts.map((target) => ({ action: "allow", target })),
	};
}

/** A refusal about the file itself, which the agent can do something about. */
function fileFailure(path: string, cause: unknown): Sandbox.FileFailed | undefined {
	if (!(cause instanceof SandboxApiException)) return undefined;
	if (cause.statusCode === 404) return new Sandbox.FileFailed({ path, reason: "No such file" });
	if (cause.statusCode === 400 || cause.statusCode === 403) {
		return new Sandbox.FileFailed({ path, reason: cause.error.message ?? cause.message });
	}
	return undefined;
}
