import type { EgressHttpClients } from "../providers/network/egress.ts";

/**
 * `image` pinned to the digest its tag names now, such as
 * `ghcr.io/nitrictech/sugabots-sandbox@sha256:…`, asked of its registry the
 * way `docker pull` asks, anonymously. A provider keeps what it pulled for a
 * tag and makes sandboxes, or builds templates, from that again, so without
 * the digest a new release would never reach them. An image already pinned
 * is its own answer. Undefined when the registry can't be asked or doesn't say.
 * `signal` abandons the asking.
 */
export async function pinnedToDigest(
	image: string,
	clients: EgressHttpClients,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (image.includes("@")) return image;
	const named = parseImage(image);
	const manifest = `https://${named.registry}/v2/${named.repository}/manifests/${named.tag}`;
	const head = (authorization?: string) =>
		clients.for({ baseUrl: `https://${named.registry}` })(manifest, {
			method: "HEAD",
			headers: { accept: MANIFEST_TYPES, ...(authorization ? { authorization } : {}) },
			signal,
		});
	let answer = await head();
	if (answer.status === 401) {
		const token = await anonymousToken(answer.headers.get("www-authenticate"), clients, signal);
		if (!token) return undefined;
		answer = await head(`Bearer ${token}`);
	}
	const digest = answer.ok ? answer.headers.get("docker-content-digest") : null;
	return digest ? `${withoutTag(image)}@${digest}` : undefined;
}

/**
 * The image's name as it was given, without its tag or digest:
 * `debian:bookworm-slim` is `debian`, `localhost:5000/tools:1` is
 * `localhost:5000/tools`.
 */
export function withoutTag(image: string): string {
	const at = image.indexOf("@");
	const named = at < 0 ? image : image.slice(0, at);
	const colon = named.indexOf(":", named.lastIndexOf("/") + 1);
	return colon < 0 ? named : named.slice(0, colon);
}

/** What a registry's `Bearer realm=…,service=…,scope=…` challenge says to fetch a pull token from. */
async function anonymousToken(
	challenge: string | null,
	clients: EgressHttpClients,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const fields = Object.fromEntries(
		[...(challenge ?? "").matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
	);
	if (!fields.realm) return undefined;
	const realm = new URL(fields.realm);
	if (fields.service) realm.searchParams.set("service", fields.service);
	if (fields.scope) realm.searchParams.set("scope", fields.scope);
	const answer = await clients.for({ baseUrl: realm.origin })(realm, { signal });
	if (!answer.ok) return undefined;
	const body = (await answer.json()) as { token?: string; access_token?: string };
	return body.token ?? body.access_token;
}

/** An image reference's parts, for one not pinned to a digest. */
function parseImage(image: string) {
	const slash = image.indexOf("/");
	const first = slash < 0 ? "" : image.slice(0, slash);
	// A first part with a dot, a colon or `localhost` is a registry; anything else is Docker Hub.
	const hasRegistry = /[.:]/.test(first) || first === "localhost";
	const registry = hasRegistry ? first : "registry-1.docker.io";
	let path = hasRegistry ? image.slice(slash + 1) : image;
	if (!hasRegistry && !path.includes("/")) path = `library/${path}`;
	const colon = path.lastIndexOf(":");
	return colon < 0
		? { registry, repository: path, tag: "latest" }
		: { registry, repository: path.slice(0, colon), tag: path.slice(colon + 1) };
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
