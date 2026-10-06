import { Duration, Effect, Redacted } from "effect";
import { UserMessage } from "../../user-message.ts";
import { Sandboxes } from "../sandboxes.ts";

/**
 * Sandboxes on Cloudflare, through the Worker in `packages/cloudflare-sandbox`
 * that a workspace deploys to its own account: Cloudflare's sandboxes are
 * Durable Objects, which only a Worker can reach.
 *
 * Each sandbox is a container in its own VM. Cloudflare can't pause one, so
 * the Worker snapshots its disk and stops it, and opening starts a new
 * container from the snapshot: files survive a pause, programs don't.
 */

/** How far past its own timeout a command may run before the call gives up on the Worker. */
const EXEC_GRACE = Duration.seconds(15);

/** How long the Worker has to answer anything else, including making a sandbox. */
const REQUEST_TIMEOUT = Duration.minutes(3);

export const fromCloudflare = (connection: Sandboxes.CloudflareConnection): Sandboxes.Provider => {
	const base = `${connection.workerUrl.replace(/\/$/, "")}/v1`;
	const authorization = { authorization: `Bearer ${Redacted.value(connection.apiKey)}` };

	/** The Worker's answer, failing on anything but `ok`, a 404 or a 410, which callers read. */
	const call = (path: string, init: RequestInit = {}, signal?: AbortSignal) =>
		Effect.tryPromise({
			try: async (abort) => {
				const response = await fetch(`${base}${path}`, {
					...init,
					headers: { ...authorization, ...init.headers },
					signal: AbortSignal.any([
						abort,
						signal ?? AbortSignal.timeout(Duration.toMillis(REQUEST_TIMEOUT)),
					]),
				});
				if (response.ok || response.status === 404 || response.status === 410) return response;
				throw new WorkerRefused(response.status, await response.text());
			},
			catch: unavailable,
		});
	const json = (body: unknown): RequestInit => ({
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const missing = (id: Sandboxes.SandboxId) =>
		new Sandboxes.Missing({ provider: "cloudflare", sandboxId: id });

	return {
		capabilities: { pauseKeeps: "disk" },
		check: call("/health").pipe(Effect.asVoid),
		image: Effect.gen(function* () {
			const { image } = yield* answer<{ image: string }>(yield* call("/image"));
			return image;
		}),
		create: (spec) =>
			Effect.gen(function* () {
				const response = yield* call(
					"/sandboxes",
					json({ labels: spec.labels, allowedHosts: spec.allowedHosts }),
				);
				const { id } = yield* answer<{ id: string }>(response);
				return toSandbox(Sandboxes.SandboxId(id));
			}),
		open: (id) =>
			Effect.gen(function* () {
				const response = yield* call(`/sandboxes/${id}/open`, { method: "POST" });
				if (response.status === 404) return yield* missing(id);
				if (response.status === 410) {
					return yield* new Sandboxes.Stopped({
						provider: "cloudflare",
						sandboxId: id,
						workKept: false,
					});
				}
				const { resumed } = yield* answer<{ resumed: boolean }>(response);
				return { sandbox: toSandbox(id), resumed };
			}),
		info: (id) =>
			Effect.gen(function* () {
				const response = yield* call(`/sandboxes/${id}`);
				// One that stopped without a pause lost its disk, so nothing of it is left.
				if (response.status === 404 || response.status === 410) return yield* missing(id);
				const { state, image } = yield* answer<{ state: "running" | "paused"; image: string }>(
					response,
				);
				return { state, image, workKeptApart: false };
			}),
		pause: (id) =>
			Effect.gen(function* () {
				const response = yield* call(`/sandboxes/${id}/pause`, { method: "POST" });
				if (response.status === 404) return yield* missing(id);
			}),
		// A sandbox the Worker no longer has is destroyed already.
		destroy: (id) => call(`/sandboxes/${id}`, { method: "DELETE" }).pipe(Effect.asVoid),
	};

	function toSandbox(id: Sandboxes.SandboxId): Sandboxes.Sandbox {
		const at = `/sandboxes/${id}`;
		const files = (path: string) => `${at}/files?${new URLSearchParams({ path })}`;
		/** The Worker's refusal of a file, as one the agent can do something about. */
		const refusalOf = <A>(
			path: string,
			effect: Effect.Effect<A, Sandboxes.FileFailed | Sandboxes.Unavailable>,
		) =>
			effect.pipe(
				Effect.catchTag("SandboxUnavailable", (failure) =>
					Effect.fail(fileFailure(path, failure) ?? failure),
				),
			);
		const exec: Sandboxes.Sandbox["exec"] = (command, options) =>
			Effect.gen(function* () {
				const timeout = Duration.fromInputUnsafe(options.timeout);
				const response = yield* call(
					`${at}/exec`,
					json({
						command: Sandboxes.keepingOutputEnd(command, options.maxOutputCharacters),
						cwd: options.cwd,
						env: options.env,
						timeoutMs: Duration.toMillis(timeout),
						maxOutputCharacters: options.maxOutputCharacters,
					}),
					AbortSignal.timeout(Duration.toMillis(Duration.sum(timeout, EXEC_GRACE))),
				);
				const ran = yield* answer<WorkerExecution>(response);
				return {
					exitCode: ran.exitCode,
					stdout: capturedOf(ran.stdout),
					stderr: capturedOf(ran.stderr),
				};
			});
		const writeFile = (path: string, content: Uint8Array) =>
			refusalOf(path, call(files(path), { method: "PUT", body: content }).pipe(Effect.asVoid));
		return {
			id,
			exec,
			readFile: (path, maxBytes) => Sandboxes.readFileThroughExec(exec, path, maxBytes),
			writeFile,
			uploadFile: writeFile,
			downloadFile: (path) =>
				refusalOf(
					path,
					Effect.gen(function* () {
						const response = yield* call(files(path));
						if (response.status === 404) {
							return yield* new Sandboxes.FileFailed({ path, reason: NO_SUCH_FILE });
						}
						return yield* Effect.tryPromise({
							try: async () => new Uint8Array(await response.arrayBuffer()),
							catch: unavailable,
						});
					}),
				),
			endpoint: (port) =>
				Effect.succeed({ url: `${base}${at}/ports/${port}`, headers: authorization }),
			setAllowedHosts: (hosts) =>
				Effect.gen(function* () {
					const response = yield* call(`${at}/allowed-hosts`, {
						...json({ hosts }),
						method: "PUT",
					});
					if (response.status === 404) {
						return yield* unavailable(new WorkerRefused(404, "No such sandbox"));
					}
				}),
		};
	}
};

/** A command's run as the Worker answers it. */
interface WorkerExecution {
	readonly exitCode: number | null;
	readonly stdout: WorkerOutput;
	readonly stderr: WorkerOutput;
}

interface WorkerOutput {
	readonly text: string;
	readonly droppedCharacters: number;
}

function capturedOf(output: WorkerOutput): Sandboxes.CapturedOutput {
	return { text: output.text, truncated: output.droppedCharacters > 0 };
}

/** The Worker answered with an error status. */
class WorkerRefused extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`The sandbox Worker answered ${status}: ${body}`);
		this.status = status;
		this.body = body;
	}
}

function unavailable(cause: unknown) {
	return new Sandboxes.Unavailable({
		provider: "cloudflare",
		cause,
		...(cause instanceof WorkerRefused && cause.status === 401 ? { reason: WRONG_KEY } : {}),
	});
}

function answer<A>(response: Response) {
	return Effect.tryPromise({ try: () => response.json() as Promise<A>, catch: unavailable });
}

/** A refusal about the file itself, which the agent can do something about. */
function fileFailure(path: string, failure: Sandboxes.Unavailable) {
	const cause = failure.cause;
	if (!(cause instanceof WorkerRefused)) return undefined;
	if (cause.status === 400 || cause.status === 403) {
		return new Sandboxes.FileFailed({ path, reason: NOT_WRITABLE });
	}
	return undefined;
}

const NO_SUCH_FILE = UserMessage.of`No such file`;
const NOT_WRITABLE = UserMessage.of`The path is a directory, or can't be written`;
const WRONG_KEY = UserMessage.of`The sandbox Worker refused the API key. Check it matches the Worker's API_KEY secret.`;
