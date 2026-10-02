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

/** How far past its own timeout a command may run before the call gives up on E2B. */
const EXEC_GRACE = Duration.seconds(15);

export const fromE2b = (connection: Sandboxes.E2bConnection): Sandboxes.Provider => {
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
							Template().fromImage(image),
							connection.template,
							options(),
						);
						return { templateId, buildId };
					},
					catch: unavailable,
				}),
			status: (build) =>
				Effect.tryPromise({
					try: async (): Promise<Sandboxes.TemplateStatus> => {
						if (!build)
							return (await Template.exists(connection.template, options())) ? "ready" : "missing";
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
		return {
			id: Sandboxes.SandboxId(sandbox.sandboxId),
			exec: (command, execOptions) =>
				Effect.tryPromise({
					try: (signal) => run(sandbox, command, execOptions, signal),
					catch: unavailable,
				}),
			readFile: (path) =>
				Effect.tryPromise({
					try: () => sandbox.files.read(path, { format: "bytes", user: AGENT_USER }),
					catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
				}),
			writeFile: (path, content) =>
				Effect.tryPromise({
					try: () => sandbox.files.write(path, toArrayBuffer(content), { user: AGENT_USER }),
					catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
				}).pipe(Effect.asVoid),
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
		await sandbox.commands.run(command, {
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
