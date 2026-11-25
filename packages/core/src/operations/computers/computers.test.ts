import type { InputOf, RequestOperationName } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedComputer,
	seedMember,
	seedProject,
	seedProjectChat,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { Computers } from "../../computers/computers.ts";
import { recordingFirstComputer } from "../../computers/testing.ts";
import { computer, computerProvider } from "../../database/schema.ts";
import { closeDatabase, onDatabase, waitUntilWaitingOnLocks } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

/**
 * The computers operations, each called for every kind of principal through
 * the registry, as an entrypoint calls them. What each comes to is "ok", the
 * tag of its refusal, or the tag of the error its service answers with once
 * proved: hidden where the principal doesn't reach the workspace or project,
 * forbidden where it does but may not act. Who may do what in detail is the
 * provers' tests'.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it; Ed, Vi (a
 * viewer) and Quinn are in J, and Erin (an editor) isn't. No computer
 * provider of A is enabled, and the one J's computer was made by has no key,
 * so nothing here reaches a provider.
 */
describe("the computers operations, for each kind of principal", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	/** Every principal the cases call for, on J unless its name says otherwise. */
	let who: Awaited<ReturnType<typeof principalsOnJ>>;

	const principalsOnJ = async () => {
		const outsider = await seedMember(world.b.workspace, "editor");
		const adminsAssistant = await seedBot(a.workspace, {
			assistantOf: a.admin,
			visibility: "personal",
		});
		const adminsAssistantChat = await seedProjectChat(
			a.workspace,
			adminsAssistant.defaultProject,
			a.admin,
		);
		return {
			owner: await as.member(a.owner),
			admin: await as.member(a.admin),
			ed: await as.member(a.ed),
			vi: await as.member(a.vi),
			erin: await as.member(a.erin),
			outsider: await as.member(outsider),
			/** Pub answering Ed in J's chat: chat bounds, J. */
			pubForEd: await as.botFor(a.ed, a.pub.id, a.chat),
			/** Pub answering an admin in J's chat: chat bounds, J. */
			pubForAdmin: await as.botFor(a.admin, a.pub.id, a.chat),
			/** Helper answering Ed in K's chat: chat bounds, K, though both reach J. */
			helperInK: await as.botFor(a.ed, a.helper.id, a.otherChat),
			/** Ed's Personal Assistant in its own chat: member bounds. */
			edsAssistant: await as.botFor(a.ed, a.assistant.id, a.assistantChat),
			/** An admin's Personal Assistant in its own chat: member bounds. */
			adminsAssistant: await as.botFor(a.admin, adminsAssistant.id, adminsAssistantChat),
			run: (await as.run(a.workspace, a.project, a.pub.id)).principal,
			webhook: await as.webhook(a.workspace, a.project),
			computerSleep: (await as.computerSleep(a.workspace, a.project)).principal,
			compaction: await as.compaction(a.chat, a.pub.id),
			page: await as.page(a.chat),
		};
	};

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		as = principals(await authenticators());
		who = await principalsOnJ();
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** What calling `name` with `input` for `principal` came to: "ok", or its error's tag. */
	const tried = <Name extends RequestOperationName>(
		principal: Principal,
		name: Name,
		input: InputOf<Name>,
	): Promise<string> =>
		call(principal, name, input).then(
			() => "ok",
			(failure: { readonly _tag: string }) => failure._tag,
		);

	/** What `attempt` came to for each principal of `principals`, by its name. */
	const outcomes = async <Key extends string>(
		principals: Record<Key, Principal>,
		attempt: (principal: Principal) => Promise<string>,
	) => {
		const entries = await Promise.all(
			Object.entries<Principal>(principals).map(async ([key, principal]) => [
				key,
				await attempt(principal),
			]),
		);
		return Object.fromEntries(entries) as Record<Key, string>;
	};

	/** A new private project like J, with no computer: led by Pub, with Helper, and Ed, Vi and Quinn in it. */
	const projectLikeJ = () =>
		seedProject(a.workspace, {
			leadBotId: a.pub.id,
			bots: [a.helper.id],
			members: [a.ed, a.vi, a.quinn],
		});

	describe("a workspace's computers", () => {
		it("are managed by its owner and admins, and a bot only in member bounds", async () => {
			const reads = ["computerProviders.list", "computerProviders.network"] as const;
			for (const name of reads) {
				expect({
					name,
					outcomes: await outcomes(
						{
							owner: who.owner,
							admin: who.admin,
							editor: who.ed,
							viewer: who.vi,
							outsider: who.outsider,
							adminsBotInChatBounds: who.pubForAdmin,
							adminsAssistant: who.adminsAssistant,
							editorsAssistant: who.edsAssistant,
							run: who.run,
							webhook: who.webhook,
							computerSleep: who.computerSleep,
							page: who.page,
						},
						(principal) => tried(principal, name, { workspace: a.workspace }),
					),
				}).toEqual({
					name,
					outcomes: {
						owner: "ok",
						admin: "ok",
						editor: "ActionForbidden",
						viewer: "ActionForbidden",
						outsider: "ResourceHidden",
						adminsBotInChatBounds: "ActionForbidden",
						adminsAssistant: "ok",
						editorsAssistant: "ActionForbidden",
						run: "ActionForbidden",
						webhook: "ActionForbidden",
						computerSleep: "ActionForbidden",
						page: "ActionForbidden",
					},
				});
			}
		});

		it("say whether computers can be given to anyone in the workspace, and a bot only in member bounds", async () => {
			expect(
				await outcomes(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInChatBounds: who.pubForEd,
						botInMemberBounds: who.edsAssistant,
						run: who.run,
						page: who.page,
					},
					(principal) => tried(principal, "computerProviders.access", { workspace: a.workspace }),
				),
			).toEqual({
				viewer: "ok",
				outsider: "ResourceHidden",
				botInChatBounds: "ActionForbidden",
				botInMemberBounds: "ok",
				run: "ActionForbidden",
				page: "ActionForbidden",
			});
			expect(await call(who.vi, "computerProviders.access", { workspace: a.workspace })).toEqual({
				enabled: false,
			});
		});

		it("adds, removes, blocks and unblocks hosts for those who manage the workspace", async () => {
			const host = `${a.workspace.slice(0, 8)}.example.com`;
			const changed = await outcomes(
				{ owner: who.owner, admin: who.admin, adminsAssistant: who.adminsAssistant },
				async (principal) => {
					const steps = [
						"computerProviders.addHost",
						"computerProviders.removeHost",
						"computerProviders.blockHost",
						"computerProviders.unblockHost",
					] as const;
					const tags = [];
					for (const name of steps) {
						tags.push(await tried(principal, name, { workspace: a.workspace, host }));
					}
					return tags.join(", ");
				},
			);
			const refused = await outcomes(
				{ editor: who.ed, adminsBotInChatBounds: who.pubForAdmin, run: who.run },
				(principal) =>
					tried(principal, "computerProviders.addHost", { workspace: a.workspace, host }),
			);

			expect({ ...changed, ...refused }).toEqual({
				owner: "ok, ok, ok, ok",
				admin: "ok, ok, ok, ok",
				adminsAssistant: "ok, ok, ok, ok",
				editor: "ActionForbidden",
				adminsBotInChatBounds: "ActionForbidden",
				run: "ActionForbidden",
			});
		});

		it("sets a provider up, tries it, and removes it, and finds none of another workspace's", async () => {
			const made = await call(who.owner, "computerProviders.create", {
				workspace: a.workspace,
				settings: { builtIn: "e2b" },
			});
			const elsewhere = await call(who.ed, "computerProviders.create", {
				workspace: world.b.workspace,
				settings: { builtIn: "e2b" },
			});
			const ours = { workspace: a.workspace, providerId: made.id };

			expect(
				await call(who.admin, "computerProviders.update", {
					...ours,
					changes: { settings: { builtIn: "e2b", template: "ours" } },
				}),
			).toMatchObject({ id: made.id, settings: { builtIn: "e2b", template: "ours" } });
			expect(await call(who.admin, "computerProviders.test", ours)).toMatchObject({
				reachable: false,
			});
			expect(await call(who.admin, "computerProviders.template", ours)).toEqual({ state: null });
			expect(await tried(who.admin, "computerProviders.prepareTemplate", ours)).toBe("NoTemplates");
			expect(
				await tried(who.admin, "computerProviders.update", {
					...ours,
					changes: { settings: { builtIn: "opensandbox" } },
				}),
			).toBe("ComputerProviderBuiltInFixed");
			expect(
				await tried(who.admin, "computerProviders.update", { ...ours, changes: { enabled: true } }),
			).toBe("ComputerProviderIncomplete");
			const missing = crypto.randomUUID();
			for (const { principal, ids, refusal } of [
				{ principal: who.ed, ids: [made.id, missing], refusal: "ActionForbidden" },
				{ principal: who.vi, ids: [made.id, missing], refusal: "ActionForbidden" },
				{ principal: who.admin, ids: [elsewhere.id, missing], refusal: "ResourceHidden" },
			]) {
				for (const providerId of ids) {
					const address = { workspace: a.workspace, providerId };
					for (const name of [
						"computerProviders.test",
						"computerProviders.template",
						"computerProviders.prepareTemplate",
						"computerProviders.remove",
					] as const) {
						expect(await tried(principal, name, address), name).toBe(refusal);
					}
					expect(
						await tried(principal, "computerProviders.update", {
							...address,
							changes: { enabled: false },
						}),
					).toBe(refusal);
				}
			}
			expect(await tried(who.admin, "computerProviders.remove", ours)).toBe("ok");
			expect(
				(await call(who.owner, "computerProviders.list", { workspace: a.workspace })).map(
					({ id }) => id,
				),
			).not.toContain(made.id);
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
			expect(await tried(who.outsider, "computerProviders.disks", { workspace: a.workspace })).toBe(
				"ResourceHidden",
			);
		});
	});

	describe("removing a computer provider", () => {
		it("keeps a provider that makes a project's first computer while it is removed", async () => {
			const workspaceId = await seedWorkspace();
			const owner = await seedMember(workspaceId, "owner");
			const lead = await seedBot(workspaceId, { createdById: owner });
			const launch = await seedProject(workspaceId, { leadBotId: lead.id });
			const [provider] = await onDatabase((db) =>
				db
					.insert(computerProvider)
					.values({
						workspaceId,
						settings: { builtIn: "opensandbox", serverUrl: "http://computers.test" },
						enabled: true,
					})
					.returning({ id: computerProvider.id }),
			);
			if (!provider) throw new Error("fixture");
			const recording = await recordingFirstComputer({
				workspaceId,
				projectId: launch,
				computerProviderId: provider.id,
			});

			const removing = tried(await as.member(owner), "computerProviders.remove", {
				workspace: workspaceId,
				providerId: provider.id,
			});
			await waitUntilWaitingOnLocks(1);
			await recording.release();

			expect(await removing).toBe("ComputerMadeMeanwhile");
			expect(
				await onDatabase((db) =>
					db
						.select({ id: computer.id })
						.from(computer)
						.where(eq(computer.computerProviderId, provider.id)),
				),
			).toHaveLength(1);
		});
	});

	describe("a project's computer", () => {
		it("is seen by whoever reaches the project, within a turn's bounds", async () => {
			for (const name of ["projectComputer.get", "projectComputer.network"] as const) {
				expect({
					name,
					outcomes: await outcomes(
						{
							admin: who.admin,
							viewer: who.vi,
							notInProject: who.erin,
							outsider: who.outsider,
							botInBounds: who.pubForEd,
							botOutsideBounds: who.helperInK,
							run: who.run,
							webhook: who.webhook,
							computerSleep: who.computerSleep,
							compaction: who.compaction,
							page: who.page,
						},
						(principal) => tried(principal, name, { projectId: a.project }),
					),
				}).toEqual({
					name,
					outcomes: {
						admin: "ok",
						viewer: "ok",
						notInProject: "ResourceHidden",
						outsider: "ResourceHidden",
						botInBounds: "ok",
						botOutsideBounds: "ResourceHidden",
						run: "ok",
						webhook: "ResourceHidden",
						computerSleep: "ResourceHidden",
						compaction: "ResourceHidden",
						page: "ResourceHidden",
					},
				});
			}
		});

		it("is reset and upgraded by those who manage the project, a bot for its asker included", async () => {
			const refused = await outcomes(
				{
					editor: who.ed,
					viewer: who.vi,
					notInProject: who.erin,
					editorsBot: who.pubForEd,
					run: who.run,
					webhook: who.webhook,
					computerSleep: who.computerSleep,
					page: who.page,
				},
				(principal) => tried(principal, "projectComputer.reset", { projectId: a.project }),
			);
			const resetAndUpgrade = async (principal: Principal, projectId: string) => {
				const reset = await tried(principal, "projectComputer.reset", { projectId });
				const upgraded = await tried(principal, "projectComputer.upgrade", { projectId });
				return `${reset}, ${upgraded}`;
			};
			const managed = await outcomes(
				{ owner: who.owner, admin: who.admin, adminsAssistant: who.adminsAssistant },
				async (principal) => resetAndUpgrade(principal, await projectLikeJ()),
			);
			const newProject = await projectLikeJ();
			const pubForAdminThere = await as.botFor(
				a.admin,
				a.pub.id,
				await seedProjectChat(a.workspace, newProject, a.admin),
			);
			const adminsBotInChatBounds = await resetAndUpgrade(pubForAdminThere, newProject);

			expect({ ...refused, ...managed, adminsBotInChatBounds }).toEqual({
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				editorsBot: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ResourceHidden",
				computerSleep: "ResourceHidden",
				page: "ResourceHidden",
				owner: "ok, NoComputerProvider",
				admin: "ok, NoComputerProvider",
				adminsBotInChatBounds: "ok, NoComputerProvider",
				adminsAssistant: "ok, NoComputerProvider",
			});
		});

		it("is a bot's default project's, managed by the bot's managers, and hidden from an admin with a personal bot", async () => {
			const resetOf = (principal: Principal, projectId: string) =>
				tried(principal, "projectComputer.reset", { projectId });

			expect({
				creatorOfPublicBot: await resetOf(who.ed, a.pub.defaultProject),
				adminOfPublicBot: await resetOf(who.admin, a.pub.defaultProject),
				editorTalkingToPublicBot: await resetOf(who.erin, a.pub.defaultProject),
				creatorOfPersonalBot: await resetOf(who.ed, a.personal.defaultProject),
				adminOfPersonalBot: await resetOf(who.admin, a.personal.defaultProject),
				memberOfAssistant: await resetOf(who.ed, a.assistant.defaultProject),
			}).toEqual({
				creatorOfPublicBot: "ok",
				adminOfPublicBot: "ok",
				editorTalkingToPublicBot: "ActionForbidden",
				creatorOfPersonalBot: "ok",
				adminOfPersonalBot: "ResourceHidden",
				memberOfAssistant: "ok",
			});
		});

		it("has its allowed hosts changed by those who manage the project, and a bot only in member bounds", async () => {
			const host = `${a.workspace.slice(0, 8)}.example.org`;
			const refused = await outcomes(
				{
					editor: who.ed,
					viewer: who.vi,
					notInProject: who.erin,
					adminsBotInChatBounds: who.pubForAdmin,
					run: who.run,
					webhook: who.webhook,
					computerSleep: who.computerSleep,
					page: who.page,
				},
				(principal) => tried(principal, "projectComputer.addHost", { projectId: a.project, host }),
			);
			const changed = await outcomes(
				{ owner: who.owner, admin: who.admin, adminsAssistant: who.adminsAssistant },
				async (principal) => {
					const projectId = await projectLikeJ();
					const added = await call(principal, "projectComputer.addHost", { projectId, host });
					const removed = await call(principal, "projectComputer.removeHost", { projectId, host });
					return `${added.addedHosts.map((shown) => shown.host)}; ${removed.addedHosts.length}`;
				},
			);

			expect({ ...refused, ...changed }).toEqual({
				editor: "ActionForbidden",
				viewer: "ActionForbidden",
				notInProject: "ResourceHidden",
				adminsBotInChatBounds: "ActionForbidden",
				run: "ActionForbidden",
				webhook: "ResourceHidden",
				computerSleep: "ResourceHidden",
				page: "ResourceHidden",
				owner: `${host}; 0`,
				admin: `${host}; 0`,
				adminsAssistant: `${host}; 0`,
			});
		});

		it("refuses a host the workspace blocked", async () => {
			const host = `${a.workspace.slice(0, 8)}.example.net`;
			const projectId = await projectLikeJ();
			await call(who.owner, "computerProviders.blockHost", { workspace: a.workspace, host });

			expect(await tried(who.admin, "projectComputer.addHost", { projectId, host })).toBe(
				"ComputerHostBlocked",
			);

			await call(who.owner, "computerProviders.unblockHost", { workspace: a.workspace, host });
			expect(await tried(who.admin, "projectComputer.addHost", { projectId, host })).toBe("ok");
		});
	});
});
