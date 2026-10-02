import type { EgressHttpClients } from "../providers/network/egress.ts";

/**
 * `image` pinned to the digest its tag names now, such as
 * `ghcr.io/nitrictech/sugabots-sandbox@sha256:…`, asked of its registry the
 * way `docker pull` asks, anonymously. E2B keeps what it pulled for a tag and
 * builds from that again, so a template built from `:latest` after a new
 * release would be the old image. Answers `image` as it is when the registry
 * can't be asked or doesn't say.
 */
export async function pinnedToDigest(image: string, clients: EgressHttpClients): Promise<string> {
	const named = parseImage(image);
	if (!named) return image;
	const manifest = `https://${named.registry}/v2/${named.repository}/manifests/${named.tag}`;
	const head = (authorization?: string) =>
		clients.for({ baseUrl: `https://${named.registry}` })(manifest, {
			method: "HEAD",
			headers: { accept: MANIFEST_TYPES, ...(authorization ? { authorization } : {}) },
		});
	let answer = await head();
	if (answer.status === 401) {
		const token = await anonymousToken(answer.headers.get("www-authenticate"), clients);
		if (!token) return image;
		answer = await head(`Bearer ${token}`);
	}
	const digest = answer.ok ? answer.headers.get("docker-content-digest") : null;
	return digest ? `${named.registry}/${named.repository}@${digest}` : image;
}

/** What a registry's `Bearer realm=…,service=…,scope=…` challenge says to fetch a pull token from. */
async function anonymousToken(
	challenge: string | null,
	clients: EgressHttpClients,
): Promise<string | undefined> {
	const fields = Object.fromEntries(
		[...(challenge ?? "").matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
	);
	if (!fields.realm) return undefined;
	const realm = new URL(fields.realm);
	if (fields.service) realm.searchParams.set("service", fields.service);
	if (fields.scope) realm.searchParams.set("scope", fields.scope);
	const answer = await clients.for({ baseUrl: realm.origin })(realm);
	if (!answer.ok) return undefined;
	const body = (await answer.json()) as { token?: string; access_token?: string };
	return body.token ?? body.access_token;
}

/** An image reference's parts, or nothing for one already pinned to a digest. */
function parseImage(image: string) {
	if (image.includes("@")) return undefined;
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
