import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.ts";

export interface OutboundProps {
	/** The Durable Object id of the sandbox the request leaves. */
	readonly sandboxId: string;
}

/**
 * Every HTTP and HTTPS request a sandbox makes arrives here before it leaves,
 * and goes out only to a host its sandbox is allowed. The hosts are read on
 * each request, so a change applies to the next one, while the sandbox runs.
 * Other ports can't leave at all: sandboxes start without the internet.
 */
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
	override async fetch(request: Request): Promise<Response> {
		const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromString(this.ctx.props.sandboxId));
		const host = new URL(request.url).hostname.replace(/\.$/, "").toLowerCase();
		if (!allows(await sandbox.allowedHosts(), host)) {
			return new Response(`The sandbox isn't allowed to connect to ${host}.\n`, { status: 403 });
		}
		return fetch(request);
	}
}

/**
 * Whether `host` is one of `allowed`: a name, or `*.example.com`, which
 * covers example.com's subdomains but not example.com itself.
 */
export function allows(allowed: readonly string[], host: string): boolean {
	return allowed.some((pattern) =>
		pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern,
	);
}
