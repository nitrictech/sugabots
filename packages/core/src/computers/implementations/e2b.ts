import { userText } from "@sugabots/errors";
import {
	CommandExitError,
	ConnectionConfig,
	type ConnectionOpts,
	Sandbox as E2bSandbox,
	FileNotFoundError,
	SandboxNotFoundError,
	Template,
	TimeoutError,
} from "e2b";
import { Duration, Effect, Redacted } from "effect";
import type { Ids } from "../../ids/ids.ts";
import {
	type Egress,
	type EgressHttpClient,
	EgressRefused,
	workspaceUrlRefusal,
} from "../../providers/network/egress.ts";
import { Computers } from "../computers.ts";

/**
 * Computers on E2B (e2b.dev): E2B Cloud, or E2B Embed at its own address.
 *
 * Each sandbox is a Firecracker microVM. A pause keeps its memory, so running
 * programs carry on when it is opened again.
 */

/**
 * The user E2B's templates run commands as. Bots work as this user, never
 * as root.
 */
const BOT_USER = "user";

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
	access: Computers.E2bAccess,
	ids: Ids.Interface,
	egress: Pick<Egress.Interface, "providers" | "validateProviderUrl">,
): Computers.Provider => {
	const connectionConfig = new ConnectionConfig(access.endpoints);
	const apiFetch: EgressHttpClient = (input, init) =>
		egress.providers.for({ baseUrl: connectionConfig.apiUrl })(input, init);
	const computerOrigin = connectionConfig.sandboxUrl && new URL(connectionConfig.sandboxUrl).origin;
	const envdFetch: EgressHttpClient = computerOrigin
		? (input, init) => egress.providers.for({ baseUrl: computerOrigin })(input, init)
		: Computers.fetchComputerEndpoint(egress);
	const options = (): ConnectionOpts => ({
		apiKey: Redacted.value(access.apiKey),
		...access.endpoints,
		apiFetch,
		envdFetch,
	});
	const unavailable = (cause: unknown) =>
		new Computers.Unavailable({
			provider: "e2b",
			cause,
			...(cause instanceof EgressRefused && { reason: workspaceUrlRefusal(cause) }),
			...(isMissingTemplate(cause) ? { reason: MISSING_TEMPLATE } : {}),
		});
	const missingOr = (id: Computers.ComputerId) => (cause: unknown) =>
		cause instanceof SandboxNotFoundError
			? new Computers.Missing({ provider: "e2b", computerId: id })
			: unavailable(cause);

	return {
		capabilities: {
			sleepKeeps: "memory",
			// E2B Cloud adds headers by host. E2B Embed, at its own endpoints,
			// leaves resolving them to E2B's enterprise orchestrator.
			credentials: access.endpoints ? "none" : "host",
			blocksHosts: false,
		},
		networkMode: access.networkMode,
		templates: {
			build: (image) =>
				Effect.tryPromise({
					try: async (): Promise<Computers.TemplateBuild> => {
						const { templateId, buildId } = await Template.buildInBackground(
							Template().fromImage(image).runCmd([WITHOUT_SUDO, TMP_ON_DISK], { user: "root" }),
							access.template,
							{
								...options(),
								cpuCount: access.size.cpuCount,
								memoryMB: access.size.memoryGiB * MIB_PER_GIB,
							},
						);
						return { templateId, buildId };
					},
					catch: unavailable,
				}),
			status: (build) =>
				Effect.tryPromise({
					try: async (): Promise<Computers.TemplateStatus> => {
						const { status } = await Template.getBuildStatus(build, options());
						return status === "ready" ? "ready" : status === "error" ? "failed" : "building";
					},
					catch: unavailable,
				}),
		},
		check: Effect.forEach(
			[
				connectionConfig.apiUrl,
				...(connectionConfig.sandboxUrl ? [connectionConfig.sandboxUrl] : []),
			],
			egress.validateProviderUrl,
			{ discard: true },
		).pipe(
			Effect.mapError(unavailable),
			Effect.andThen(
				Effect.tryPromise({
					try: () => E2bSandbox.list({ ...options(), limit: 1 }).nextItems(),
					catch: unavailable,
				}),
			),
			Effect.asVoid,
		),
		create: (spec) =>
			Effect.tryPromise({
				try: () =>
					E2bSandbox.create(access.template, {
						...options(),
						metadata: { ...spec.labels },
						timeoutMs: Duration.toMillis(IDLE_BACKSTOP),
						lifecycle: { onTimeout: "pause" },
						// E2B serves a sandbox's ports to anyone with its address unless
						// told otherwise; private, they need the sandbox's traffic token.
						// Set only here: updating the network leaves it as it is.
						network: { ...networkRulesOf(spec.reach), allowPublicTraffic: false },
					}),
				catch: unavailable,
			}).pipe(
				Effect.flatMap((sandbox) =>
					Effect.tryPromise({
						try: async () => {
							await sandbox.commands.run(
								`mkdir -p ${Computers.WORK_DIRECTORY} && chown ${BOT_USER}: ${Computers.WORK_DIRECTORY}`,
								{ user: "root" },
							);
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
					const info = await E2bSandbox.getInfo(id, options());
					// Connecting resumes a sleeping sandbox, and moves its backstop on.
					const sandbox = await E2bSandbox.connect(id, {
						...options(),
						timeoutMs: Duration.toMillis(IDLE_BACKSTOP),
					});
					return { computer: toComputer(sandbox), resumed: info.state === "paused" };
				},
				catch: missingOr(id),
			}),
		info: (id) =>
			Effect.tryPromise({
				try: async (): Promise<Computers.Info> => {
					const info = await E2bSandbox.getInfo(id, options());
					// Work stays on the sandbox's disk, so moving it means copying it.
					return { state: info.state === "paused" ? "asleep" : "running", workKeptApart: false };
				},
				catch: missingOr(id),
			}),
		sleep: (id) =>
			Effect.tryPromise({
				try: () => E2bSandbox.pause(id, options()),
				catch: missingOr(id),
			}).pipe(Effect.asVoid),
		destroy: (id) =>
			Effect.tryPromise({
				// False when E2B no longer had it, which is what destroying asks for.
				try: (signal) => E2bSandbox.kill(id, { ...options(), signal }),
				catch: unavailable,
			}).pipe(Effect.asVoid),
		labelled: (key, value) =>
			Effect.tryPromise({
				try: async () => {
					const pages = E2bSandbox.list({
						...options(),
						query: { metadata: { [key]: value }, state: ["running", "paused"] },
					});
					const found: Computers.ComputerId[] = [];
					while (pages.hasNext) {
						for (const info of await pages.nextItems()) {
							found.push(Computers.ComputerId(info.sandboxId));
						}
					}
					return found;
				},
				catch: unavailable,
			}),
	};

	function toComputer(sandbox: E2bSandbox): Computers.Computer {
		const exec: Computers.Computer["exec"] = (command, execOptions) =>
			Effect.tryPromise({
				try: (signal) => run(sandbox, command, execOptions, signal),
				catch: unavailable,
			});
		// E2B's file API writes as root wherever it's asked, only handing the
		// file to the user it is given, so it is used only for files Sugabots
		// names; what bots write goes through `exec`.
		const uploadFile = (path: string, content: Uint8Array) =>
			Effect.tryPromise({
				try: () => sandbox.files.write(path, toArrayBuffer(content), { user: BOT_USER }),
				catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
			}).pipe(Effect.asVoid);
		return {
			id: Computers.ComputerId(sandbox.sandboxId),
			exec,
			readFile: (path, maxBytes) => Computers.readFileThroughExec(exec, path, maxBytes),
			writeFile: (path, content) =>
				Effect.flatMap(ids.random, (random) =>
					Computers.writeFileThroughStaging(
						{ exec, uploadFile },
						`/tmp/sugabots-write-${random}`,
						path,
						content,
					),
				),
			downloadFile: (path) =>
				Effect.tryPromise({
					try: () => sandbox.files.read(path, { format: "bytes", user: BOT_USER }),
					catch: (cause) => fileFailure(path, cause) ?? unavailable(cause),
				}),
			uploadFile,
			endpoint: (port) =>
				Effect.sync(() => {
					const traffic: Record<string, string> = sandbox.trafficAccessToken
						? { "e2b-traffic-access-token": sandbox.trafficAccessToken }
						: {};
					// E2B Embed has no wildcard domain for sandboxes' hosts, so its
					// proxy routes on headers instead.
					return access.endpoints
						? {
								url: access.endpoints.sandboxUrl.replace(/\/$/, ""),
								headers: {
									...traffic,
									"E2b-Sandbox-Id": sandbox.sandboxId,
									"E2b-Sandbox-Port": String(port),
								},
							}
						: { url: `https://${sandbox.getHost(port)}`, headers: traffic };
				}).pipe(
					Effect.flatMap((endpoint) =>
						Computers.checkedEndpoint(egress, endpoint).pipe(Effect.mapError(unavailable)),
					),
				),
			setNetwork: (network) =>
				Effect.tryPromise({
					try: async () => {
						// One update replaces both the hosts and the rules, so they are
						// always set together.
						await sandbox.updateNetwork({
							...networkRulesOf(network.reach),
							rules: credentialRules(network.credentials),
						});
					},
					catch: unavailable,
				}),
		};
	}
};

async function run(
	sandbox: E2bSandbox,
	command: string,
	options: Computers.ExecOptions,
	signal: AbortSignal,
): Promise<Computers.Execution> {
	const stdout = Computers.outputTail(options.maxOutputCharacters);
	const stderr = Computers.outputTail(options.maxOutputCharacters);
	const timeout = Duration.fromInputUnsafe(options.timeout);
	const finished = (exitCode: number | null): Computers.Execution => ({
		exitCode,
		stdout: stdout.captured(),
		stderr: stderr.captured(),
	});
	try {
		await sandbox.commands.run(Computers.keepingOutputEnd(command, options.maxOutputCharacters), {
			cwd: options.cwd ?? Computers.WORK_DIRECTORY,
			user: BOT_USER,
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

/**
 * E2B's header rules for `credentials`, by host. E2B matches hosts only, so
 * credentials have no `pathPrefix` by the time they get here.
 */
function credentialRules(credentials: readonly Computers.Credential[]) {
	const headersByHost = new Map<string, Record<string, string>>();
	for (const { host, header, value } of credentials) {
		headersByHost.set(host, { ...headersByHost.get(host), [header]: Redacted.value(value) });
	}
	return Object.fromEntries(
		[...headersByHost].map(([host, headers]) => [host, [{ transform: { headers } }]]),
	);
}

/**
 * E2B's rules for what the sandbox may connect to. Allowed hosts only, it refuses
 * every address but the hosts', since what's allowed wins over what's denied.
 * Open, it has no rules: E2B denies addresses but never names, so it can't
 * keep blocked hosts out.
 */
function networkRulesOf(reach: Computers.Reach) {
	if (reach.kind === "allowed-hosts-only")
		return { allowOut: [...reach.hosts], denyOut: [ALL_ADDRESSES] };
	if (reach.blockedHosts.length > 0) throw new Error("E2B can't refuse hosts by name");
	return {};
}

const ALL_ADDRESSES = "0.0.0.0/0";

/**
 * Takes away the passwordless sudo E2B gives its user, since bots are never
 * root: its line in sudoers, and sudo's setuid bit, since E2B puts the user
 * back in the sudo group whenever a sandbox starts.
 */
const WITHOUT_SUDO = `sed -i '/^${BOT_USER} .*NOPASSWD/d' /etc/sudoers && chmod u-s /usr/bin/sudo`;

/**
 * Keeps `/tmp` on disk. Debian 13's systemd mounts it as tmpfs sized at half
 * the sandbox's memory, and tmpfs pages can only leave memory for swap, so a
 * repository cloned or installed there starves every program in the sandbox.
 */
const TMP_ON_DISK = "ln -sf /dev/null /etc/systemd/system/tmp.mount";

/** A refusal about the file itself, which the bot can do something about. */
function fileFailure(path: string, cause: unknown): Computers.FileFailed | undefined {
	if (cause instanceof FileNotFoundError) {
		return new Computers.FileFailed({ path, reason: userText`No such file` });
	}
	return undefined;
}

/** E2B takes an ArrayBuffer, so a view into a larger buffer is copied to its own. */
function toArrayBuffer(content: Uint8Array): ArrayBuffer {
	return content.slice().buffer as ArrayBuffer;
}

const MISSING_TEMPLATE = userText`The workspace's E2B template isn't ready. A workspace admin can prepare it under Computers in the workspace's settings.`;

/** E2B's answer to making a sandbox from a template it doesn't have. */
function isMissingTemplate(cause: unknown) {
	return cause instanceof Error && /template .* not found/i.test(cause.message);
}
