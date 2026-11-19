import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	allowedHost,
	blockedHost,
	projectAllowedHost,
	project as projectTable,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { allowedHostsOf, reachOf, TRUSTED_HOSTS } from "./allowed-hosts.ts";
import type { Computers } from "./computers.ts";

const BLOCKS_HOSTS: Computers.Capabilities = {
	pauseKeeps: "disk",
	credentials: "host",
	blocksHosts: true,
};

/** What a project's computer may reach, from the workspace's lists and the project's own, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)("allowed hosts, against Postgres", () => {
	let workspaceId: string;
	let builders: { workspaceId: string; projectId: string };
	let research: { workspaceId: string; projectId: string };

	afterAll(closeDatabase);

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Hosts ${suffix}`, slug: `hosts-${suffix}` })
				.returning(),
		);
		const [owner] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `hosts-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		workspaceId = space.id;
		await onDatabase((db) => db.insert(workspaceMember).values({ workspaceId, userId: owner.id }));
		const aProject = async (name: string) => {
			const [made] = await onDatabase((db) =>
				db.insert(projectTable).values({ workspaceId, name, slug: name.toLowerCase() }).returning(),
			);
			if (!made) throw new Error("fixture");
			return { workspaceId, projectId: made.id };
		};
		builders = await aProject("Builders");
		research = await aProject("Research");
	});

	const allowForWorkspace = (host: string) =>
		onDatabase((db) => db.insert(allowedHost).values({ workspaceId, host }));
	const allowForProject = (target: { projectId: string }, host: string) =>
		onDatabase((db) =>
			db.insert(projectAllowedHost).values({ workspaceId, projectId: target.projectId, host }),
		);
	const block = (host: string) =>
		onDatabase((db) => db.insert(blockedHost).values({ workspaceId, host }));

	it("gives a project the trusted hosts, the workspace's, and its own, but not another project's", async () => {
		await allowForWorkspace("api.example.com");
		await allowForProject(builders, "builders.example.com");
		await allowForProject(research, "research.example.com");

		const hosts = await runOnPostgres(allowedHostsOf(builders));

		expect(hosts).toEqual(
			expect.arrayContaining([...TRUSTED_HOSTS, "api.example.com", "builders.example.com"]),
		);
		expect(hosts).not.toContain("research.example.com");
	});

	it("keeps a blocked host out of every project's reach, trusted or allowed", async () => {
		await allowForWorkspace("api.example.com");
		await allowForProject(builders, "api.example.com");
		await block("api.example.com");
		await block("github.com");

		for (const target of [builders, research]) {
			const hosts = await runOnPostgres(allowedHostsOf(target));
			expect(hosts).not.toContain("api.example.com");
			expect(hosts).not.toContain("github.com");
		}
	});

	it("keeps out a wildcard that would reach a blocked host, and what a blocked wildcard covers", async () => {
		await allowForProject(builders, "*.example.com");
		await allowForProject(builders, "cdn.example.org");
		await allowForProject(builders, "example.org");
		await block("api.example.com");
		await block("*.example.org");

		const hosts = await runOnPostgres(allowedHostsOf(builders));

		expect(hosts).not.toContain("*.example.com");
		expect(hosts).not.toContain("cdn.example.org");
		// A wildcard leaves its domain out, blocking as it allows.
		expect(hosts).toContain("example.org");
	});

	it("keeps out a blocked domain's subdomains", async () => {
		await allowForProject(builders, "www.pastebin.com");
		await allowForProject(builders, "*.pastebin.com");
		await block("pastebin.com");

		const hosts = await runOnPostgres(allowedHostsOf(builders));

		expect(hosts).not.toContain("www.pastebin.com");
		expect(hosts).not.toContain("*.pastebin.com");
	});

	it("gives a project on the allowlist the hosts allowed it", async () => {
		await allowForProject(builders, "builders.example.com");

		const reach = await runOnPostgres(
			reachOf(builders, { networkMode: "allowlist", capabilities: BLOCKS_HOSTS }),
		);

		expect(reach).toEqual({
			kind: "allowlist",
			hosts: expect.arrayContaining([...TRUSTED_HOSTS, "builders.example.com"]),
		});
	});

	it("opens every host but the blocked ones, with a blocked domain's subdomains", async () => {
		await allowForProject(builders, "builders.example.com");
		await block("pastebin.com");
		await block("*.example.org");

		const reach = await runOnPostgres(
			reachOf(builders, { networkMode: "open", capabilities: BLOCKS_HOSTS }),
		);

		expect(reach).toEqual({
			kind: "open",
			blockedHosts: ["pastebin.com", "*.pastebin.com", "*.example.org"],
		});
	});

	it("opens every host, blocked or not, at a provider that can't block hosts", async () => {
		await block("pastebin.com");

		const reach = await runOnPostgres(
			reachOf(builders, {
				networkMode: "open",
				capabilities: { ...BLOCKS_HOSTS, blocksHosts: false },
			}),
		);

		expect(reach).toEqual({ kind: "open", blockedHosts: [] });
	});
});
