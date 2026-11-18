import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { type Database, query } from "../database/database.ts";
import {
	sandboxAgentAllowedHost,
	sandboxAllowedHost,
	sandboxBlockedHost,
} from "../database/schema.ts";
import type { Sandboxes } from "./sandboxes.ts";

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

/** The hosts the workspace added for every computer beyond {@link TRUSTED_HOSTS}, oldest first. */
export const addedHostsOf = (workspaceId: string) =>
	query((db) =>
		db
			.select()
			.from(sandboxAllowedHost)
			.where(eq(sandboxAllowedHost.workspaceId, workspaceId))
			.orderBy(asc(sandboxAllowedHost.createdAt), asc(sandboxAllowedHost.host)),
	);

/** The hosts added for the bot's own computer, oldest first. */
export const agentAddedHostsOf = (agent: { workspaceId: string; agentId: string }) =>
	query((db) =>
		db
			.select()
			.from(sandboxAgentAllowedHost)
			.where(
				and(
					eq(sandboxAgentAllowedHost.workspaceId, agent.workspaceId),
					eq(sandboxAgentAllowedHost.agentId, agent.agentId),
				),
			)
			.orderBy(asc(sandboxAgentAllowedHost.createdAt), asc(sandboxAgentAllowedHost.host)),
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
 * Every host the bot's computer may reach: {@link TRUSTED_HOSTS}, the
 * workspace's hosts and the bot's own, less what the workspace blocked.
 */
export const allowedHostsOf = (agent: { workspaceId: string; agentId: string }) =>
	Effect.map(
		Effect.all([
			addedHostsOf(agent.workspaceId),
			agentAddedHostsOf(agent),
			blockedHostsOf(agent.workspaceId),
		]),
		([workspaceAdded, agentAdded, blocked]) => {
			const blocks = blocked.map((row) => row.host);
			return [
				...new Set([
					...TRUSTED_HOSTS,
					...workspaceAdded.map((row) => row.host),
					...agentAdded.map((row) => row.host),
				]),
			].filter((host) => blockOn(host, blocks) === undefined);
		},
	);

/**
 * What the bot's computer may reach at `provider`, by its network mode: on the
 * allowlist, {@link allowedHostsOf}; open, everything but what the workspace
 * blocked, if the provider can block hosts, and everything if not.
 */
export const reachOf = (
	agent: { workspaceId: string; agentId: string },
	provider: Pick<Sandboxes.Provider, "networkMode" | "capabilities">,
): Effect.Effect<Sandboxes.Reach, never, Database> => {
	if (provider.networkMode === "allowlist") {
		return Effect.map(allowedHostsOf(agent), (hosts) => ({ kind: "allowlist", hosts }));
	}
	if (!provider.capabilities.blocksHosts) return Effect.succeed({ kind: "open", blockedHosts: [] });
	return Effect.map(blockedHostsOf(agent.workspaceId), (blocked) => ({
		kind: "open",
		blockedHosts: blocked.flatMap((row) => namesBlockedBy(row.host)),
	}));
};

/**
 * The names a block keeps out, as a sandbox's network rules match them:
 * blocking `example.com` blocks its subdomains too, but a rule for it
 * matches only itself.
 */
function namesBlockedBy(block: string) {
	return isWildcard(block) ? [block] : [block, `*.${block}`];
}

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
