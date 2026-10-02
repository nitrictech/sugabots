import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	pod,
	sandboxAllowedHost,
	sandboxBlockedHost,
	sandboxPodAllowedHost,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { allowedHostsOf, TRUSTED_HOSTS } from "./allowed-hosts.ts";

/** What a pod's sandbox may reach, from the workspace's lists and the pod's own, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)("allowed hosts, against Postgres", () => {
	let workspaceId: string;
	let builders: { workspaceId: string; podId: string };
	let research: { workspaceId: string; podId: string };

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
		const sharedPod = async (name: string) => {
			const [made] = await onDatabase((db) =>
				db
					.insert(pod)
					.values({
						workspaceId,
						ownerId: owner.id,
						kind: "shared",
						name,
						slug: `${name.toLowerCase()}-${suffix}`,
						createdById: owner.id,
					})
					.returning(),
			);
			if (!made) throw new Error("fixture");
			return { workspaceId, podId: made.id };
		};
		builders = await sharedPod("Builders");
		research = await sharedPod("Research");
	});

	const allowForWorkspace = (host: string) =>
		onDatabase((db) => db.insert(sandboxAllowedHost).values({ workspaceId, host }));
	const allowForPod = (target: { podId: string }, host: string) =>
		onDatabase((db) =>
			db.insert(sandboxPodAllowedHost).values({ workspaceId, podId: target.podId, host }),
		);
	const block = (host: string) =>
		onDatabase((db) => db.insert(sandboxBlockedHost).values({ workspaceId, host }));

	it("gives a pod the trusted hosts, the workspace's, and its own, but not another pod's", async () => {
		await allowForWorkspace("api.example.com");
		await allowForPod(builders, "builders.example.com");
		await allowForPod(research, "research.example.com");

		const hosts = await runOnPostgres(allowedHostsOf(builders));

		expect(hosts).toEqual(
			expect.arrayContaining([...TRUSTED_HOSTS, "api.example.com", "builders.example.com"]),
		);
		expect(hosts).not.toContain("research.example.com");
	});

	it("keeps a blocked host out of every pod, trusted or allowed", async () => {
		await allowForWorkspace("api.example.com");
		await allowForPod(builders, "api.example.com");
		await block("api.example.com");
		await block("github.com");

		for (const target of [builders, research]) {
			const hosts = await runOnPostgres(allowedHostsOf(target));
			expect(hosts).not.toContain("api.example.com");
			expect(hosts).not.toContain("github.com");
		}
	});

	it("keeps out a wildcard that would reach a blocked host, and what a blocked wildcard covers", async () => {
		await allowForPod(builders, "*.example.com");
		await allowForPod(builders, "cdn.example.org");
		await allowForPod(builders, "example.org");
		await block("api.example.com");
		await block("*.example.org");

		const hosts = await runOnPostgres(allowedHostsOf(builders));

		expect(hosts).not.toContain("*.example.com");
		expect(hosts).not.toContain("cdn.example.org");
		// A wildcard leaves its domain out, blocking as it allows.
		expect(hosts).toContain("example.org");
	});
});
