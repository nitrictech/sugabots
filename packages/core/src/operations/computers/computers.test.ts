import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedComputer,
	seedMember,
	seedProject,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { Computers } from "../../computers/computers.ts";
import { computer, computerProvider } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/**
 * What the computers operations do beyond the rule `permissions.test.ts`
 * states for each: the hosts and providers a manager changes, that a provider
 * they name is their workspace's, and whose computers' disks each principal is
 * shown. What each comes to is "ok", the tag of its refusal, or the tag of the
 * error its service answers with.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it; Ed, Vi (a
 * viewer) and Quinn are in J, and Erin (an editor) isn't. No computer
 * provider of A is enabled, and the one J's computer was made by has no key,
 * so nothing here reaches a provider.
 */
describe("the computers operations, beyond who may call them", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	/** Every principal the cases call for, on J unless its name says otherwise. */
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		as = principals(await authenticators());
		who = await everyKindOfPrincipal(world, as);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** A new private project like J, with no computer: led by Pub, with Helper, and Ed, Vi and Quinn in it. */
	const projectLikeJ = () =>
		seedProject(a.workspace, {
			leadBotId: a.pub.id,
			bots: [a.helper.id],
			members: [a.ed, a.vi, a.quinn],
		});

	describe("a workspace's computers", () => {
		it("adds, removes, blocks and unblocks the workspace's hosts", async () => {
			const input = { workspace: a.workspace, host: "packages.example.com" };
			const network = () =>
				call(who.admin, "computerProviders.network", { workspace: a.workspace });
			const entry = expect.objectContaining({ host: input.host });

			await call(who.admin, "computerProviders.addHost", input);
			expect((await network()).addedHosts).toContainEqual(entry);
			await call(who.admin, "computerProviders.removeHost", input);
			expect((await network()).addedHosts).not.toContainEqual(entry);

			await call(who.admin, "computerProviders.blockHost", input);
			expect((await network()).blockedHosts).toContainEqual(entry);
			await call(who.admin, "computerProviders.unblockHost", input);
			expect((await network()).blockedHosts).not.toContainEqual(entry);
		});
		const providerFixture = async () => {
			const workspace = await seedWorkspace();
			const admin = await as.member(await seedMember(workspace, "admin"));
			const made = await call(admin, "computerProviders.create", {
				workspace,
				settings: { builtIn: "e2b" },
			});
			return { workspace, admin, providerId: made.id };
		};

		it("lists the provider settings an admin changes", async () => {
			const { workspace, admin, providerId } = await providerFixture();

			await call(admin, "computerProviders.update", {
				workspace,
				providerId,
				changes: { settings: { builtIn: "e2b", template: "ours" } },
			});

			const providers = await call(admin, "computerProviders.list", { workspace });
			expect(providers).toContainEqual(
				expect.objectContaining({ id: providerId, settings: { builtIn: "e2b", template: "ours" } }),
			);
		});

		it("reports an unconfigured provider unreachable with no template", async () => {
			const { workspace, admin, providerId } = await providerFixture();
			const input = { workspace, providerId };
			expect(await call(admin, "computerProviders.test", input)).toMatchObject({
				reachable: false,
			});
			expect(await call(admin, "computerProviders.template", input)).toEqual({ state: null });
			await expect(call(admin, "computerProviders.prepareTemplate", input)).rejects.toMatchObject({
				_tag: "NoTemplates",
			});
		});

		it("refuses changing a provider's built-in kind or enabling it while incomplete", async () => {
			const { workspace, admin, providerId } = await providerFixture();
			await expect(
				call(admin, "computerProviders.update", {
					workspace,
					providerId,
					changes: { settings: { builtIn: "opensandbox" } },
				}),
			).rejects.toMatchObject({ _tag: "ComputerProviderBuiltInFixed" });
			await expect(
				call(admin, "computerProviders.update", {
					workspace,
					providerId,
					changes: { enabled: true },
				}),
			).rejects.toMatchObject({ _tag: "ComputerProviderIncomplete" });
		});

		it("hides another workspace's providers and missing ones from its manager", async () => {
			const { workspace, admin } = await providerFixture();
			const elsewhere = await providerFixture();

			for (const providerId of [elsewhere.providerId, crypto.randomUUID()]) {
				const address = { workspace, providerId };
				for (const name of [
					"computerProviders.test",
					"computerProviders.template",
					"computerProviders.prepareTemplate",
					"computerProviders.remove",
				] as const) {
					expect(await operationOutcome(call, admin, name, address), name).toBe("ResourceHidden");
				}
				expect(
					await operationOutcome(call, admin, "computerProviders.update", {
						...address,
						changes: { enabled: false },
					}),
				).toBe("ResourceHidden");
			}
		});

		it("takes a removed provider out of its workspace list", async () => {
			const { workspace, admin, providerId } = await providerFixture();
			await call(admin, "computerProviders.remove", { workspace, providerId });
			const providers = await call(admin, "computerProviders.list", { workspace });
			expect(providers.map(({ id }) => id)).not.toContain(providerId);
			expect(await call(admin, "computerProviders.access", { workspace })).toEqual({
				enabled: false,
			});
		});
	});

	describe("computerProviders.disks", () => {
		it("leaves out the computers of another member's personal bots, even for a workspace admin", async () => {
			const workspaceId = await seedWorkspace();
			const ada = await seedMember(workspaceId, "admin");
			const sam = await seedMember(workspaceId, "editor");
			const publicBot = await seedBot(workspaceId, { createdById: ada });
			const adasBot = await seedBot(workspaceId, { createdById: ada, visibility: "personal" });
			const samsBot = await seedBot(workspaceId, { createdById: sam, visibility: "personal" });
			const [provider] = await onDatabase((db) =>
				db
					.insert(computerProvider)
					.values({
						workspaceId,
						settings: { builtIn: "opensandbox", serverUrl: "http://computers.test" },
					})
					.returning({ id: computerProvider.id }),
			);
			if (!provider) throw new Error("fixture");
			const measured = [publicBot, adasBot, samsBot].map((made) => made.defaultProject);
			await onDatabase((db) =>
				db.insert(computer).values(
					measured.map((projectId) => ({
						workspaceId,
						projectId,
						computerProviderId: provider.id,
						providerComputerId: Computers.ComputerId(`computer-${projectId}`),
						image: "debian",
						diskUsage: { usedBytes: 1_000, totalBytes: 10_000, folders: [] },
						diskMeasuredAt: new Date(),
					})),
				),
			);
			const shownTo = async (memberId: string) =>
				(
					await call(await as.member(memberId), "computerProviders.disks", {
						workspace: workspaceId,
					})
				)
					.map(({ projectId }) => projectId)
					.toSorted();

			expect(await shownTo(sam)).toEqual(
				[publicBot.defaultProject, samsBot.defaultProject].toSorted(),
			);
			expect(await shownTo(ada)).toEqual(
				[publicBot.defaultProject, adasBot.defaultProject].toSorted(),
			);
		});

		it("shows a bot only the computers within its turn's bounds", async () => {
			await seedComputer(a.workspace, a.otherProject);
			await onDatabase((db) =>
				db
					.update(computer)
					.set({
						diskUsage: { usedBytes: 1_000, totalBytes: 10_000, folders: [] },
						diskMeasuredAt: new Date(),
					})
					.where(eq(computer.workspaceId, a.workspace)),
			);
			const shownTo = async (principal: Principal) =>
				(await call(principal, "computerProviders.disks", { workspace: a.workspace }))
					.map(({ projectId }) => projectId)
					.toSorted();

			expect(await shownTo(who.ed)).toEqual([a.project, a.otherProject].toSorted());
			expect(await shownTo(who.pubForEd)).toEqual([a.project]);
			expect(
				await operationOutcome(call, who.outsider, "computerProviders.disks", {
					workspace: a.workspace,
				}),
			).toBe("ResourceHidden");
		});
	});

	describe("a project's computer", () => {
		it("resets a bot's computer for its manager and hides a personal bot's computer from an admin", async () => {
			const reset = (principal: Principal, projectId: string) =>
				operationOutcome(call, principal, "projectComputer.reset", { projectId });

			expect(await reset(who.ed, a.pub.defaultProject)).toBe("ok");
			expect(await reset(who.erin, a.pub.defaultProject)).toBe("ActionForbidden");
			expect(await reset(who.admin, a.personal.defaultProject)).toBe("ResourceHidden");
		});

		it("adds and removes a project's allowed hosts", async () => {
			const projectId = a.project;
			const input = { projectId, host: "project-packages.example.org" };
			const network = () => call(who.admin, "projectComputer.network", { projectId });
			const entry = expect.objectContaining({ host: input.host });

			await call(who.admin, "projectComputer.addHost", input);
			expect((await network()).addedHosts).toContainEqual(entry);
			await call(who.admin, "projectComputer.removeHost", input);
			expect((await network()).addedHosts).not.toContainEqual(entry);
		});

		it("refuses a host the workspace blocked", async () => {
			const host = `${a.workspace.slice(0, 8)}.example.net`;
			const projectId = await projectLikeJ();
			await call(who.owner, "computerProviders.blockHost", { workspace: a.workspace, host });

			expect(
				await operationOutcome(call, who.admin, "projectComputer.addHost", { projectId, host }),
			).toBe("ComputerHostBlocked");

			await call(who.owner, "computerProviders.unblockHost", { workspace: a.workspace, host });
			expect(
				await operationOutcome(call, who.admin, "projectComputer.addHost", { projectId, host }),
			).toBe("ok");
		});
	});
});
