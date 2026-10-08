import {
	CommandExitError,
	type ConnectionOpts,
	Sandbox as E2bSandbox,
	FileNotFoundError,
	SandboxNotFoundError,
	Template,
	TimeoutError,
} from "e2b";
import { Duration, Effect, Redacted } from "effect";
import type { Ids } from "../../ids/ids.ts";
import { UserMessage } from "../../user-message.ts";
import { Sandboxes } from "../sandboxes.ts";

/**
 * Sandboxes on E2B (e2b.dev): E2B Cloud, or E2B Embed at its own address.
 *
 * Each sandbox is a Firecracker microVM. A pause keeps its memory, so running
 * programs carry on when it is opened again.
 */

/**
 * The user E2B's templates run commands as. Agents work as this user, never
 * as root.
 */
const AGENT_USER = "user";

/**
 * How long a sandbox may go without being opened before E2B pauses it
 * itself. Sugabots pauses idle sandboxes sooner; this is the backstop for
 * when it doesn't.
 */
const IDLE_BACKSTOP = Duration.minutes(30);

const MIB_PER_GIB = 1024;

/** How far past its own timeout a command may run before the call gives up on E2B. */
const EXEC_GRACE = Duration.seconds(15);

export const fromE2b = (
	connection: Sandboxes.E2bConnection,
	ids: Ids.Interface,
): Sandboxes.Provider => {
	const options = (): ConnectionOpts => ({
		apiKey: Redacted.value(connection.apiKey),
		...connection.endpoints,
	});
	const unavailable = (cause: unknown) =>
		new Sandboxes.Unavailable({
			provider: "e2b",
			cause,
			...(isMissingTemplate(cause) ? { reason: MISSING_TEMPLATE } : {}),
		});
	const missingOr = (id: Sandboxes.SandboxId) => (cause: unknown) =>
		cause instanceof SandboxNotFoundError
			? new Sandboxes.Missing({ provider: "e2b", sandboxId: id })
			: unavailable(cause);

	return {
		capabilities: { pauseKeeps: "memory" },
		templates: {
			build: (image) =>
				Effect.tryPromise({
					try: async (): Promise<Sandboxes.TemplateBuild> => {
						const { templateId, buildId } = await Template.buildInBackground(
							Template().fromImage(image).runCmd([WITHOUT_SUDO, TMP_ON_DISK], { user: "root" }),
							connection.template,
							{
								...options(),
								cpuCount: connection.size.cpuCount,
								memoryMB: connection.size.memoryGiB * MIB_PER_GIB,
							},
						);
						return { templateId, buildId };
					},
					catch: unavailable,
				}),
			status: (build) =>
				Effect.tryPromise({
					try: async (): Promise<Sandboxes.TemplateStatus> => {
						const { status } = await Template.getBuildStatus(build, options());
						return status === "ready" ? "ready" : status === "error" ? "failed" : "building";
					},
					catch: unavailable,
				}),
		},
		check: Effect.tryPromise({
			try: () => E2bSandbox.list({ ...options(), limit: 1 }).nextItems(),
			catch: unavailable,
		}).pipe(Effect.asVoid),
		create: (spec) =>
			Effect.tryPromise({
				try: async () => {
					const sandbox = await E2bSandbox.create(connection.template, {
						...options(),
						metadata: { ...spec.labels },
						timeoutMs: Duration.toMillis(IDLE_BACKSTOP),
						lifecycle: { onTimeout: "pause" },
						// E2B serves a sandbox's ports to anyone with its address unless
						// told otherwise; private, they need the sandbox's traffic token.
						// Set only here: updating the network leaves it as it is.
						network: { ...allowOnly(spec.allowedHosts), allowPublicTraffic: false },
					});
					await sandbox.commands.run(
						`mkdir -p ${Sandboxes.WORKSPACE_DIRECTORY} && chown ${AGENT_USER}: ${Sandboxes.WORKSPACE_DIRECTORY}`,
						{ user: "root" },
					);
					return toSandbox(sandbox);
				},
				catch: unavailable,
			}),
		open: (id) =>
			Effect.tryPromise({
				try: async () => {
					const info = await E2bSandbox.getInfo(id, options());
					// Connecting resumes a paused sandbox, and moves its backstop on.
					const sandbox = await E2bSandbox.connect(id, {
						...options(),
						timeoutMs: Duration.toMillis(IDLE_BACKSTOP),
					});
					return { sandbox: toSandbox(sandbox), resumed: info.state === "paused" };
				},
				catch: missingOr(id),
			}),
		info: (id) =>
			Effect.tryPromise({
				try: async (): Promise<Sandboxes.Info> => {
					const info = await E2bSandbox.getInfo(id, options());
					// Work stays on the sandbox's disk, so moving it means copying it.
					return { state: info.state, image: info.name ?? info.templateId, workKeptApart: false };
				},
				catch: missingOr(id),
			}),
		pause: (id) =>
			Effect.tryPromise({
				try: () => E2bSandbox.pause(id, options()),
				catch: missingOr(id),
			}).pipe(Effect.asVoid),
		destroy: (id) =>
			Effect.tryPromise({
				// False when E2B no longer had it, which is what destroying asks for.
				try: () => E2bSandbox.kill(id, options()),
				catch: unavailable,
			}).pipe(Effect.asVoid),
	};

	function toSandbox(sandbox: E2bSandbox): Sandboxes.Sandbox {
		const exec: Sandboxes.Sandbox["exec"] = (command, execOptions) =>
			Effect.tryPromise({
				try: (signal) => run(sandbox, command, execOptions, signal),
				catch: unavailable,
			});
		// E2B's file API writes as root wherever it's asked, only handing the
		// file to the user it is given, so it is used only for files Sugabots
		// names; what agents write goes through `exec`.
		const uploadFile = (path: string, content: Uint8Array) =>
			Effect.tryPromise({
				try: () => sandbox.files.write(path, toArrayBuffer(content), { user: AGENT_USER }),
				catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
			}).pipe(Effect.asVoid);
		return {
			id: Sandboxes.SandboxId(sandbox.sandboxId),
			exec,
			readFile: (path, maxBytes) => Sandboxes.readFileThroughExec(exec, path, maxBytes),
			writeFile: (path, content) =>
				Effect.flatMap(ids.random, (random) =>
					Sandboxes.writeFileThroughStaging(
						{ exec, uploadFile },
						`/tmp/sugabots-write-${random}`,
						path,
						content,
					),
				),
			downloadFile: (path) =>
				Effect.tryPromise({
					try: () => sandbox.files.read(path, { format: "bytes", user: AGENT_USER }),
					catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
				}),
			uploadFile,
			endpoint: (port) =>
				Effect.sync((): Sandboxes.Endpoint => {
					const traffic: Record<string, string> = sandbox.trafficAccessToken
						? { "e2b-traffic-access-token": sandbox.trafficAccessToken }
						: {};
					// E2B Embed has no wildcard domain for sandboxes' hosts, so its
					// proxy routes on headers instead.
					return connection.endpoints
						? {
								url: connection.endpoints.sandboxUrl.replace(/\/$/, ""),
								headers: {
									...traffic,
									"E2b-Sandbox-Id": sandbox.sandboxId,
									"E2b-Sandbox-Port": String(port),
								},
							}
						: { url: `https://${sandbox.getHost(port)}`, headers: traffic };
				}),
			setAllowedHosts: (hosts) =>
				Effect.tryPromise({
					try: () => sandbox.updateNetwork(allowOnly(hosts)),
					catch: unavailable,
				}),
		};
	}
};

async function run(
	sandbox: E2bSandbox,
	command: string,
	options: Sandboxes.ExecOptions,
	signal: AbortSignal,
): Promise<Sandboxes.Execution> {
	const stdout = Sandboxes.outputTail(options.maxOutputCharacters);
	const stderr = Sandboxes.outputTail(options.maxOutputCharacters);
	const timeout = Duration.fromInputUnsafe(options.timeout);
	const finished = (exitCode: number | null): Sandboxes.Execution => ({
		exitCode,
		stdout: stdout.captured(),
		stderr: stderr.captured(),
	});
	try {
		await sandbox.commands.run(Sandboxes.keepingOutputEnd(command, options.maxOutputCharacters), {
			cwd: options.cwd ?? Sandboxes.WORKSPACE_DIRECTORY,
			user: AGENT_USER,
			envs: { ...options.env },
			timeoutMs: Duration.toMillis(timeout),
			requestTimeoutMs: Duration.toMillis(Duration.sum(timeout, EXEC_GRACE)),
			signal,
			onStdout: (data) => stdout.append(data),
			onStderr: (data) => stderr.append(data),
		});
		return finished(0);
	} catch (cause) {
		if (cause instanceof CommandExitError) return finished(cause.exitCode);
		if (cause instanceof TimeoutError) return finished(null);
		throw cause;
	}
}

/** E2B's rules for refusing every connection but those to `hosts`: what's allowed wins over what's denied. */
function allowOnly(hosts: readonly string[]) {
	return { allowOut: [...hosts], denyOut: [ALL_ADDRESSES] };
}

const ALL_ADDRESSES = "0.0.0.0/0";

/**
 * Takes away the passwordless sudo E2B gives its user, since agents are never
 * root: its line in sudoers, and sudo's setuid bit, since E2B puts the user
 * back in the sudo group whenever a sandbox starts.
 */
const WITHOUT_SUDO = `sed -i '/^${AGENT_USER} .*NOPASSWD/d' /etc/sudoers && chmod u-s /usr/bin/sudo`;

/**
 * Keeps `/tmp` on disk. Debian 13's systemd mounts it as tmpfs sized at half
 * the sandbox's memory, and tmpfs pages can only leave memory for swap, so a
 * repository cloned or installed there starves every program in the sandbox.
 */
const TMP_ON_DISK = "ln -sf /dev/null /etc/systemd/system/tmp.mount";

/** A refusal about the file itself, which the agent can do something about. */
function fileFailure(path: string, cause: unknown): Sandboxes.FileFailed | undefined {
	if (cause instanceof FileNotFoundError) {
		return new Sandboxes.FileFailed({ path, reason: UserMessage.of`No such file` });
	}
	return undefined;
}

/** E2B takes an ArrayBuffer, so a view into a larger buffer is copied to its own. */
function toArrayBuffer(content: Uint8Array): ArrayBuffer {
	return content.slice().buffer as ArrayBuffer;
}

const MISSING_TEMPLATE = UserMessage.of`The workspace's E2B template isn't ready. A workspace admin can prepare it under Sandboxes in the workspace's settings.`;

/** E2B's answer to making a sandbox from a template it doesn't have. */
function isMissingTemplate(cause: unknown) {
	return cause instanceof Error && /template .* not found/i.test(cause.message);
}
