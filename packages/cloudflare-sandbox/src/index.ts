/**
 * Sugabots' sandboxes on Cloudflare: an HTTP API in front of the Sandbox
 * Durable Objects, which only a Worker can reach. A workspace deploys it to
 * its own Cloudflare account, and gives Sugabots its address and API key.
 *
 *   GET    /v1/health
 *   GET    /v1/image                          what new sandboxes start from
 *   POST   /v1/sandboxes                      { labels, allowedHosts } -> { id }
 *   GET    /v1/sandboxes/:id                  { state, image }; 404 missing, 410 stopped
 *   POST   /v1/sandboxes/:id/open             { resumed }; 404 missing, 410 stopped
 *   POST   /v1/sandboxes/:id/pause
 *   DELETE /v1/sandboxes/:id
 *   PUT    /v1/sandboxes/:id/allowed-hosts    { hosts }
 *   POST   /v1/sandboxes/:id/exec             { command, cwd, env, timeoutMs, maxOutputCharacters }
 *   GET    /v1/sandboxes/:id/files?path=      the file's bytes
 *   PUT    /v1/sandboxes/:id/files?path=      the file's bytes
 *   *      /v1/sandboxes/:id/ports/:port/...  forwarded to the port, WebSockets included
 */

import type { Env } from "./env.ts";

export { Outbound } from "./outbound.ts";
export { Sandbox } from "./sandbox.ts";

const SANDBOX_ID = /^[0-9a-f]{64}$/;

export default {
	async fetch(request, env): Promise<Response> {
		if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
		const url = new URL(request.url);
		const [version, collection, id, resource] = url.pathname.split("/").slice(1);
		if (version !== "v1") return notFound();
		if (collection === "health" && request.method === "GET")
			return new Response(null, { status: 204 });
		if (collection === "image" && request.method === "GET") {
			// Any object answers: the image belongs to the deployment, not to one sandbox.
			return Response.json({
				image: await env.SANDBOX.get(env.SANDBOX.idFromName("image")).image(),
			});
		}
		if (collection !== "sandboxes") return notFound();
		if (id === undefined && request.method === "POST") {
			const objectId = env.SANDBOX.newUniqueId();
			const spec = (await request.json()) as {
				labels: Record<string, string>;
				allowedHosts: string[];
			};
			await env.SANDBOX.get(objectId).create(spec);
			return Response.json({ id: objectId.toString() }, { status: 201 });
		}
		const objectId = id === undefined ? undefined : sandboxId(env, id);
		if (!objectId) return missing();
		const sandbox = env.SANDBOX.get(objectId);
		if (resource === undefined && request.method === "GET") {
			const info = await sandbox.info();
			if (info.kind === "missing") return missing();
			if (info.kind === "stopped") return stopped();
			return Response.json({ state: info.state, image: info.image });
		}
		if (resource === undefined && request.method === "DELETE") {
			await sandbox.destroy();
			return new Response(null, { status: 204 });
		}
		if (resource === "open" && request.method === "POST") {
			const opened = await sandbox.open();
			if (opened.kind === "missing") return missing();
			if (opened.kind === "stopped") return stopped();
			return Response.json({ resumed: opened.resumed });
		}
		if (resource === "pause" && request.method === "POST") {
			return (await sandbox.pause()) === "missing"
				? missing()
				: new Response(null, { status: 204 });
		}
		if (resource === "allowed-hosts" && request.method === "PUT") {
			const { hosts } = (await request.json()) as { hosts: string[] };
			return (await sandbox.setAllowedHosts(hosts)) === "missing"
				? missing()
				: new Response(null, { status: 204 });
		}
		return sandbox.fetch(request);
	},
} satisfies ExportedHandler<Env>;

function authorized(request: Request, env: Env): boolean {
	const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");
	const expected = new TextEncoder().encode(`Bearer ${env.API_KEY}`);
	// Compared in constant time, against itself when the lengths differ, so
	// the time taken says nothing about the key.
	return env.API_KEY.length > 0 && given.byteLength === expected.byteLength
		? crypto.subtle.timingSafeEqual(given, expected)
		: !crypto.subtle.timingSafeEqual(expected, expected);
}

/** The object a sandbox id names, or nothing for an id this Worker never made. */
function sandboxId(env: Env, id: string): DurableObjectId | undefined {
	if (!SANDBOX_ID.test(id)) return undefined;
	try {
		return env.SANDBOX.idFromString(id);
	} catch {
		return undefined;
	}
}

const notFound = () => new Response("Not found", { status: 404 });
const missing = () => new Response("No such sandbox", { status: 404 });
const stopped = () =>
	new Response("The sandbox stopped without a pause, and its disk is gone", { status: 410 });
