import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import type { OutboundProps } from "./outbound.ts";

/**
 * One sandbox: a Durable Object and the container it runs. The object keeps
 * what Sugabots made the sandbox with, and the snapshot a pause left, so the
 * sandbox outlasts its container.
 *
 * Cloudflare has no pause. Pausing snapshots the container's disk and stops
 * it; opening starts a new container from the snapshot, so files survive and
 * programs don't. A container that stops any other way, such as on its
 * inactivity timeout, loses its disk, and the sandbox is stopped for good.
 */

/** Where agents work, and where commands run unless told otherwise. */
const WORKSPACE = "/workspace";

/** The user agents' commands run as, so nothing they run is root. */
const AGENT = { name: "agent", id: 1000, home: "/home/agent" } as const;

/**
 * How long a sandbox may go without a request before it pauses itself.
 * Sugabots pauses idle sandboxes sooner; this is the backstop for when it
 * doesn't.
 */
const IDLE_BACKSTOP_MS = 30 * 60 * 1000;

/**
 * Cloudflare stops a container after this long without activity, losing its
 * disk, so it is longer than the backstop, which snapshots first.
 */
const CONTAINER_INACTIVITY_MS = IDLE_BACKSTOP_MS + 15 * 60 * 1000;

/** A desktop with a browser needs the memory of a larger instance than a shell does. */
const INSTANCE = "standard-2";

/**
 * The certificate authority Cloudflare signs a sandbox's intercepted HTTPS
 * with, which tools inside have to trust.
 */
const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** Exit codes the file scripts use for what the agent can do something about. */
const NO_SUCH_FILE = 44;
const IS_DIRECTORY = 45;

/** What Sugabots made the sandbox with. */
interface Made {
	/** The image its first container was started from. */
	readonly image: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly allowedHosts: readonly string[];
	/** What the last pause left, until opening starts a container from it. */
	readonly snapshot?: string;
}

export type Info =
	| { readonly kind: "missing" }
	| { readonly kind: "stopped" }
	| { readonly kind: "present"; readonly state: "running" | "paused"; readonly image: string };

export type Opened =
	| { readonly kind: "missing" }
	| { readonly kind: "stopped" }
	| { readonly kind: "opened"; readonly resumed: boolean };

export interface CapturedOutput {
	readonly text: string;
	readonly droppedCharacters: number;
}

export class Sandbox extends DurableObject<Env> {
	readonly #container: Container;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const container = ctx.container;
		if (!container) throw new Error("The Worker is deployed without its container");
		this.#container = container;
		// Each instance of the object sets its own; it isn't kept with the container.
		if (container.running) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(CONTAINER_INACTIVITY_MS));
		}
	}

	/** The image a sandbox made now would start from. */
	image(): string {
		return this.#image();
	}

	async create(spec: { labels: Record<string, string>; allowedHosts: string[] }): Promise<void> {
		const made: Made = { image: this.#image(), ...spec };
		this.#save(made);
		await this.#start({ image: made.image });
		await this.#touch();
	}

	async info(): Promise<Info> {
		const made = this.#made();
		if (!made) return { kind: "missing" };
		if (this.#container.running) return { kind: "present", state: "running", image: made.image };
		if (made.snapshot) return { kind: "present", state: "paused", image: made.image };
		return { kind: "stopped" };
	}

	async open(): Promise<Opened> {
		const made = this.#made();
		if (!made) return { kind: "missing" };
		await this.#touch();
		if (this.#container.running) return { kind: "opened", resumed: false };
		if (!made.snapshot) return { kind: "stopped" };
		try {
			await this.#start({ containerSnapshot: { id: made.snapshot } });
		} catch (cause) {
			// Snapshots expire after 30 days, and the disk with them.
			console.error({ event: "sandbox.restore.failed", error: describe(cause) });
			this.#save({ ...made, snapshot: undefined });
			return { kind: "stopped" };
		}
		// Forgotten once running, so a container that later stops without a
		// pause counts as stopped, not as the older disk.
		this.#save({ ...made, snapshot: undefined });
		return { kind: "opened", resumed: true };
	}

	async pause(): Promise<"paused" | "missing"> {
		const made = this.#made();
		if (!made) return "missing";
		if (!this.#container.running) return "paused";
		const snapshot = await this.#container.snapshotContainer({});
		this.#save({ ...made, snapshot: snapshot.id });
		await this.#container.destroy();
		await this.ctx.storage.deleteAlarm();
		return "paused";
	}

	async destroy(): Promise<void> {
		if (this.#container.running) await this.#container.destroy();
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	/** What the sandbox may connect to, for the outbound check on each request. */
	allowedHosts(): readonly string[] {
		return this.#made()?.allowedHosts ?? [];
	}

	setAllowedHosts(hosts: string[]): "set" | "missing" {
		const made = this.#made();
		if (!made) return "missing";
		this.#save({ ...made, allowedHosts: hosts });
		return "set";
	}

	/** The pause Sugabots didn't make, after the sandbox sat idle for the backstop. */
	override async alarm(): Promise<void> {
		await this.pause();
	}

	/** Commands, files and ports: requests whose bodies stream, or that can be cancelled. */
	override async fetch(request: Request): Promise<Response> {
		if (!this.#made()) return new Response("No such sandbox", { status: 404 });
		if (!this.#container.running) return new Response("The sandbox isn't running", { status: 409 });
		await this.#touch();
		const url = new URL(request.url);
		const [resource, ...rest] = url.pathname.split("/").slice(4);
		if (resource === "exec" && request.method === "POST") return this.#exec(request);
		if (resource === "files" && request.method === "GET") return this.#readFile(url);
		if (resource === "files" && request.method === "PUT") return this.#writeFile(url, request);
		if (resource === "ports") return this.#forward(request, url, rest);
		return new Response("Not found", { status: 404 });
	}

	async #exec(request: Request): Promise<Response> {
		const { command, cwd, env, timeoutMs, maxOutputCharacters } = (await request.json()) as {
			command: string;
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs: number;
			maxOutputCharacters: number;
		};
		const stdout = outputTail(maxOutputCharacters);
		const stderr = outputTail(maxOutputCharacters);
		const process = await this.#container.exec(["bash", "-lc", command], {
			cwd: cwd ?? WORKSPACE,
			env: { HOME: AGENT.home, USER: AGENT.name, LOGNAME: AGENT.name, ...env },
			user: AGENT.name,
		});
		const finished = Promise.all([
			read(process.stdout, stdout),
			read(process.stderr, stderr),
			process.exitCode,
		]).then(([, , exitCode]): number | null => exitCode);
		let timer: number | null = null;
		const stopped = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), timeoutMs);
			request.signal.addEventListener("abort", () => resolve(null));
		});
		// Killed, its streams can fail after the answer has gone.
		const exitCode = await Promise.race([finished.catch(() => null), stopped]);
		clearTimeout(timer);
		// Its children can hold its output open after it is killed, so the
		// answer doesn't wait for them.
		if (exitCode === null) await this.#killTree(process.pid);
		return Response.json({ exitCode, stdout: stdout.captured(), stderr: stderr.captured() });
	}

	async #readFile(url: URL): Promise<Response> {
		const path = url.searchParams.get("path") ?? "";
		const script = `[ -e "$1" ] || exit ${NO_SUCH_FILE}; [ -d "$1" ] && exit ${IS_DIRECTORY}; exec cat -- "$1"`;
		const process = await this.#container.exec(["sh", "-c", script, "sh", path], {
			cwd: WORKSPACE,
			user: AGENT.name,
		});
		const { exitCode, stdout, stderr } = await process.output();
		if (exitCode === 0) return new Response(stdout);
		return fileRefused(exitCode, stderr);
	}

	async #writeFile(url: URL, request: Request): Promise<Response> {
		const path = url.searchParams.get("path") ?? "";
		const script = `mkdir -p -- "$(dirname -- "$1")" || exit 1; [ -d "$1" ] && exit ${IS_DIRECTORY}; exec cat > "$1"`;
		const process = await this.#container.exec(["sh", "-c", script, "sh", path], {
			cwd: WORKSPACE,
			user: AGENT.name,
			stdin: request.body ?? new Response("").body ?? undefined,
		});
		const { exitCode, stderr } = await process.output();
		if (exitCode === 0) return new Response(null, { status: 204 });
		return fileRefused(exitCode, stderr);
	}

	async #forward(request: Request, url: URL, [port, ...path]: string[]): Promise<Response> {
		const target = new URL(`http://localhost/${path.join("/")}${url.search}`);
		const headers = new Headers(request.headers);
		// Sugabots' key is for this Worker, not for what runs in the sandbox,
		// and the host is the Worker's.
		headers.delete("authorization");
		headers.delete("host");
		try {
			return await this.#container
				.getTcpPort(Number(port))
				.fetch(new Request(target, { method: request.method, headers, body: request.body }));
		} catch (cause) {
			console.error({ event: "sandbox.forward.failed", port, error: describe(cause) });
			return new Response(`Nothing answered on port ${port}`, { status: 502 });
		}
	}

	async #start(source: { image: string } | { containerSnapshot: { id: string } }): Promise<void> {
		this.#container.start({
			...source,
			// The image has no long-running command, and a container stops when its first process exits.
			entrypoint: ["sleep", "infinity"],
			enableInternet: false,
			instance: INSTANCE,
		});
		const outbound = (
			this.ctx.exports as unknown as {
				Outbound: (options: { props: OutboundProps }) => Fetcher;
			}
		).Outbound({ props: { sandboxId: this.ctx.id.toString() } });
		await this.#container.interceptAllOutboundHttp(outbound);
		await this.#container.interceptOutboundHttps("*", outbound);
		await this.#container.setInactivityTimeout(CONTAINER_INACTIVITY_MS);
		await this.#prepare();
	}

	/**
	 * Makes the agents' user and the directories it works in, and has tools
	 * trust the authority intercepted HTTPS is signed with, which can change
	 * from one container to the next.
	 */
	async #prepare(): Promise<void> {
		const { name, id, home } = AGENT;
		const script = [
			`getent group ${name} >/dev/null || groupadd -o -g ${id} ${name}`,
			`id -u ${name} >/dev/null 2>&1 || useradd -o -u ${id} -g ${id} -M -d ${home} -s /bin/bash ${name}`,
			`mkdir -p ${WORKSPACE} ${home}`,
			`chown ${id}:${id} ${WORKSPACE} ${home}`,
			`if [ -f ${INTERCEPT_CA} ]; then`,
			`  cp ${INTERCEPT_CA} /usr/local/share/ca-certificates/cloudflare-containers.crt`,
			"  update-ca-certificates >/dev/null",
			// Node and Python's certifi keep their own lists, and read these instead.
			`  printf 'export NODE_EXTRA_CA_CERTS=${INTERCEPT_CA}\\nexport REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt\\nexport PIP_CERT=/etc/ssl/certs/ca-certificates.crt\\n' > /etc/profile.d/cloudflare-ca.sh`,
			// Chromium keeps its own list too, and each agent its own home, so
			// the authority goes in a policy every profile reads.
			"  mkdir -p /etc/chromium/policies/managed",
			`  printf '{"CACertificates":["%s"]}' "$(sed '/-----/d' ${INTERCEPT_CA} | tr -d '\n')" > /etc/chromium/policies/managed/cloudflare-ca.json`,
			"fi",
		].join("\n");
		const process = await this.#container.exec(["sh", "-c", script]);
		const { exitCode, stderr } = await process.output();
		if (exitCode !== 0) {
			throw new Error(`Could not prepare the agents' user: ${new TextDecoder().decode(stderr)}`);
		}
	}

	async #killTree(pid: number): Promise<void> {
		const script = `kill_tree() { for child in $(pgrep -P "$1"); do kill_tree "$child"; done; kill -KILL "$1" 2>/dev/null; }; kill_tree ${pid}`;
		const process = await this.#container.exec(["sh", "-c", script]);
		await process.output();
	}

	/** Moves the backstop on: the sandbox is in use. */
	async #touch(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + IDLE_BACKSTOP_MS);
	}

	#image(): string {
		const image = this.#container.images.sandbox;
		if (!image) throw new Error("The Worker is deployed without its sandbox image");
		return image;
	}

	#made(): Made | undefined {
		return this.ctx.storage.kv.get<Made>("made");
	}

	#save(made: Made): void {
		this.ctx.storage.kv.put("made", made);
	}
}

function fileRefused(exitCode: number, stderr: ArrayBuffer): Response {
	if (exitCode === NO_SUCH_FILE) return new Response("No such file", { status: 404 });
	if (exitCode === IS_DIRECTORY) return new Response("The path is a directory", { status: 400 });
	return new Response(new TextDecoder().decode(stderr) || "The file can't be read or written", {
		status: 403,
	});
}

/** Keeps the last `limit` characters of output as it arrives. */
function outputTail(limit: number) {
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

async function read(
	stream: ReadableStream<Uint8Array> | null,
	into: ReturnType<typeof outputTail>,
): Promise<void> {
	if (!stream) return;
	const decoder = new TextDecoder();
	for await (const chunk of stream) into.append(decoder.decode(chunk, { stream: true }));
	into.append(decoder.decode());
}

// Structured logs drop an Error's message and stack, which aren't enumerable.
function describe(cause: unknown): string {
	return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
}
