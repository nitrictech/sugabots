import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import {
	sandboxAllowedHost,
	sandboxBlockedHost,
	sandboxPodAllowedHost,
} from "../database/schema.ts";

/**
 * What every workspace's sandboxes may reach: where source code is hosted,
 * the package registries agents install from, and the binary cache the
 * image's Nix installs from. A wildcard leaves its domain out, so a domain
 * wanted with its subdomains is listed twice.
 */
export const TRUSTED_HOSTS: readonly string[] = [
	"github.com",
	"*.github.com",
	"*.githubusercontent.com",
	"ghcr.io",
	"gitlab.com",
	"bitbucket.org",
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"*.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
	"rubygems.org",
	"*.rubygems.org",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"deb.debian.org",
	"security.debian.org",
	"archive.ubuntu.com",
	"security.ubuntu.com",
	"ports.ubuntu.com",
	"cache.nixos.org",
];

/** The hosts the workspace added for every pod beyond {@link TRUSTED_HOSTS}, oldest first. */
export const addedHostsOf = (workspaceId: string) =>
	query((db) =>
		db
			.select()
			.from(sandboxAllowedHost)
			.where(eq(sandboxAllowedHost.workspaceId, workspaceId))
			.orderBy(asc(sandboxAllowedHost.createdAt), asc(sandboxAllowedHost.host)),
	);

/** The hosts the pod added for its own sandbox, oldest first. */
export const podAddedHostsOf = (pod: { workspaceId: string; podId: string }) =>
	query((db) =>
		db
			.select()
			.from(sandboxPodAllowedHost)
			.where(
				and(
					eq(sandboxPodAllowedHost.workspaceId, pod.workspaceId),
					eq(sandboxPodAllowedHost.podId, pod.podId),
				),
			)
			.orderBy(asc(sandboxPodAllowedHost.createdAt), asc(sandboxPodAllowedHost.host)),
	);

/** The hosts the workspace blocked, oldest first. */
export const blockedHostsOf = (workspaceId: string) =>
	query((db) =>
		db
			.select()
			.from(sandboxBlockedHost)
			.where(eq(sandboxBlockedHost.workspaceId, workspaceId))
			.orderBy(asc(sandboxBlockedHost.createdAt), asc(sandboxBlockedHost.host)),
	);

/**
 * Every host the pod's sandbox may reach: {@link TRUSTED_HOSTS}, the
 * workspace's hosts and the pod's own, less what the workspace blocked.
 */
export const allowedHostsOf = (pod: { workspaceId: string; podId: string }) =>
	Effect.map(
		Effect.all([
			addedHostsOf(pod.workspaceId),
			podAddedHostsOf(pod),
			blockedHostsOf(pod.workspaceId),
		]),
		([workspaceAdded, podAdded, blocked]) => {
			const blocks = blocked.map((row) => row.host);
			return [
				...new Set([
					...TRUSTED_HOSTS,
					...workspaceAdded.map((row) => row.host),
					...podAdded.map((row) => row.host),
				]),
			].filter((host) => blockOn(host, blocks) === undefined);
		},
	);

/**
 * The block among `blocks` that keeps `host` out, if any: one that blocks a
 * name `host` reaches. Blocking `example.com` blocks its subdomains too, and
 * `*.example.com` its subdomains alone. A wildcard that reaches a blocked name
 * is kept out whole: the providers' allowlists can't make an exception inside
 * a wildcard, so allowing `*.example.com` would let `api.example.com` through
 * though it is blocked.
 */
export function blockOn(host: string, blocks: readonly string[]): string | undefined {
	return blocks.find((block) => keepsOut(block, host));
}

function keepsOut(block: string, host: string) {
	const blocked = domainOf(block);
	const reached = domainOf(host);
	if (isWildcard(host)) return isWithin(reached, blocked) || isWithin(blocked, reached);
	return isWildcard(block) ? reached.endsWith(`.${blocked}`) : isWithin(reached, blocked);
}

function isWildcard(host: string) {
	return host.startsWith("*.");
}

function domainOf(host: string) {
	return isWildcard(host) ? host.slice(2) : host;
}

/** Whether `name` is `domain` or one of its subdomains. */
function isWithin(name: string, domain: string) {
	return name === domain || name.endsWith(`.${domain}`);
}
