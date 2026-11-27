import {
	type NewBot,
	PROJECT_DESCRIPTION_MAX_LENGTH,
	PROJECT_NAME_MAX_LENGTH,
	type ProjectColor,
	type ProjectVisibility,
} from "@sugabots/contracts";
import {
	AdministratorInEveryPrivateBot,
	CreatorInOwnPrivateBot,
	NotBotMember,
	PersonalVisibilityFixed,
} from "@sugabots/contracts/errors/bots";
import {
	AdministratorInEveryProject,
	NotInProject,
	NotInWorkspace,
	UnusableProjectName,
} from "@sugabots/contracts/errors/projects";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { InputOf, RequestOperationName } from "@sugabots/contracts/operations";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectChat } from "../../authentication/seed.test-support.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { recordingFirstComputer } from "../../computers/testing.ts";
import { query } from "../../database/database.ts";
import {
	bot,
	botMember,
	computer,
	computerProvider,
	membership,
	modelProvider,
	project,
	projectMember,
	providerModel,
	workspace,
} from "../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	type Promised,
	servedOnPostgres,
	waitUntilWaitingOnLocks,
} from "../../database/testing.ts";
import {
	addTestMemberships,
	createTestWorkspace,
	createWorkspaceFixture,
} from "../../database/workspace.test-support.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import type { MemberSession } from "../../principal.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { LeadsProjects } from "./project-leads.ts";
import { ProjectStore } from "./project-store.ts";

describe.skipIf(!process.env.DATABASE_URL)("projects, against Postgres", () => {
	let repository: Promised<ProjectStore.Interface>;
	let callOperation: CallOperation;
	let signIn: (memberId: string) => Promise<MemberSession>;

	let workspaceId: string;
	let otherWorkspaceId: string;
	let adminId: string;
	let editorId: string;
	let viewerId: string;
	let outsiderId: string;
	/** The public bot that leads the projects the cases make, in each workspace. */
	let leadId: string;
	let otherLeadId: string;

	beforeAll(async () => {
		repository = await servedOnPostgres(ProjectStore.Service, ProjectStore.layer);
		callOperation = await servedOperations();
		const signedIn = principals(await authenticators());
		signIn = (memberId) => signedIn.member(memberId);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** The projects operations, each called for `memberId` signed in, by the names these cases use. */
	const projectsAs = (memberId: string) => {
		const operation =
			<Name extends RequestOperationName>(name: Name) =>
			async (input: InputOf<Name>) =>
				callOperation(await signIn(memberId), name, input);
		return {
			list: operation("projects.list"),
			create: operation("projects.create"),
			update: operation("projects.update"),
			remove: operation("projects.remove"),
			members: operation("projects.listMembers"),
			membersReaching: operation("projects.listMembersReaching"),
			addMember: operation("projects.addMember"),
			removeMember: operation("projects.removeMember"),
			leave: operation("projects.leave"),
			join: operation("projects.join"),
			bots: operation("projects.listBots"),
			addBot: operation("projects.addBot"),
			removeBot: operation("projects.removeBot"),
		};
	};

	const create = (
		creatorId: string,
		input: { name: string; slug: string; color?: ProjectColor; visibility?: ProjectVisibility },
	) => projectsAs(creatorId).create({ workspace: workspaceId, leadBotId: leadId, ...input });
	const createIn = (
		inWorkspace: string,
		creatorId: string,
		input: { name: string; slug: string; visibility?: ProjectVisibility },
	) =>
		projectsAs(creatorId).create({
			workspace: inWorkspace,
			leadBotId: inWorkspace === workspaceId ? leadId : otherLeadId,
			...input,
		});
	const visibleTo = (memberId: string, inWorkspace = workspaceId) =>
		projectsAs(memberId).list({ workspace: inWorkspace });
	/** The ids of the projects `memberId` is listed, with whether they are in each. */
	const listedTo = async (memberId: string, inWorkspace = workspaceId) =>
		(await visibleTo(memberId, inWorkspace)).map(({ id, isMember }) => ({ id, isMember }));
	/** The bots operations these cases make, change and delete bots with, called for `memberId` signed in. */
	const botsAs = (memberId: string) => ({
		create: async ({ workspace, bot }: { workspace: string; bot: NewBot }) =>
			callOperation(await signIn(memberId), "bots.create", { workspace, ...bot }),
		update: async (input: InputOf<"bots.update">) =>
			callOperation(await signIn(memberId), "bots.update", input),
		remove: async (input: InputOf<"bots.remove">) =>
			callOperation(await signIn(memberId), "bots.remove", input),
		list: async () =>
			callOperation(await signIn(memberId), "bots.list", { workspace: workspaceId }),
		members: async (input: InputOf<"bots.listMembers">) =>
			callOperation(await signIn(memberId), "bots.listMembers", input),
		addMember: async (input: InputOf<"bots.addMember">) =>
			callOperation(await signIn(memberId), "bots.addMember", input),
		removeMember: async (input: InputOf<"bots.removeMember">) =>
			callOperation(await signIn(memberId), "bots.removeMember", input),
	});
	/** A bot `creatorId` made, public unless said otherwise. */
	const aBot = async (
		creatorId: string,
		name: string,
		visibility?: "public" | "private" | "personal",
	) =>
		botsAs(creatorId).create({
			workspace: workspaceId,
			bot: { name, model: "test-model", visibility },
		});
	const membersOf = (projectId: string) => projectsAs(adminId).members({ projectId });

	beforeEach(async () => {
		// A fresh workspace per test rather than a truncate, so these can run
		// against a database that has the dev seed in it.
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const {
			workspace: made,
			members: { ada, sam, kim, lee },
		} = await createWorkspaceFixture(
			{ name: `Test ${stamp}`, slug: `test-${stamp}` },
			{
				ada: { name: "Ada", email: `ada-${stamp}@example.com`, role: "admin" },
				sam: { name: "Sam", email: `sam-${stamp}@example.com`, role: "editor" },
				kim: { name: "Kim", email: `kim-${stamp}@example.com` },
				lee: { name: "Lee", email: `lee-${stamp}@example.com`, role: "viewer" },
			},
		);
		const other = await createTestWorkspace({ name: `Other ${stamp}`, slug: `other-${stamp}` });
		workspaceId = made.id;
		otherWorkspaceId = other.id;
		adminId = ada.id;
		editorId = sam.id;
		outsiderId = kim.id;
		viewerId = lee.id;
		await addTestMemberships(
			{ workspaceId: otherWorkspaceId, memberId: adminId, role: "admin" },
			{ workspaceId: otherWorkspaceId, memberId: outsiderId, role: "editor" },
		);

		const leads = await onDatabase((db) =>
			db
				.insert(bot)
				.values(
					[workspaceId, otherWorkspaceId].map((inWorkspace) => ({
						workspaceId: inWorkspace,
						name: "Lead",
						handle: "lead",
						color: "green" as const,
						eyes: "pill" as const,
						createdById: adminId,
					})),
				)
				.returning(),
		);
		const [lead, otherLead] = leads;
		if (!lead || !otherLead) {
			throw new Error("could not create the test leads");
		}
		leadId = lead.id;
		otherLeadId = otherLead.id;

		// The model the cases make bots on.
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					name: "Models",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning(),
		);
		if (!provider) {
			throw new Error("could not create the test model provider");
		}
		await onDatabase((db) =>
			db.insert(providerModel).values(
				["test-model"].map((modelId) => ({
					workspaceId,
					providerId: provider.id,
					modelId,
					enabled: true,
					source: "manual" as const,
				})),
			),
		);
	});

	describe("creating", () => {
		it("derives its address from its name when none is given, and refuses a name that has none", async () => {
			const made = await projectsAs(editorId).create({
				workspace: workspaceId,
				name: "Sales Team",
				leadBotId: leadId,
			});

			expect(made.slug).toBe("sales-team");
			await expect(
				projectsAs(editorId).create({
					workspace: workspaceId,
					name: "!!!",
					leadBotId: leadId,
				}),
			).rejects.toBeInstanceOf(UnusableProjectName);
		});

		it("refuses a name or description longer than the API allows, from any caller", async () => {
			const tooLong = (length: number) => "a".repeat(length + 1);
			for (const details of [
				{ name: tooLong(PROJECT_NAME_MAX_LENGTH) },
				{ name: "Launch", description: tooLong(PROJECT_DESCRIPTION_MAX_LENGTH) },
			]) {
				await expect(
					projectsAs(editorId).create({
						workspace: workspaceId,
						leadBotId: leadId,
						...details,
					}),
				).rejects.toThrow("projects.create was called with an input its contract refuses");
			}
			expect(await listedTo(editorId)).toEqual([]);
		});

		it("puts the creator in the project, and lists a public one to everybody to join", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });

			expect(made).toMatchObject({ visibility: "public", isMember: true });
			expect(await listedTo(editorId)).toEqual([{ id: made.id, isMember: true }]);
			expect(await visibleTo(viewerId)).toEqual([
				expect.objectContaining({
					id: made.id,
					isMember: false,
					permissions: expect.objectContaining({ join: true, leave: false }),
				}),
			]);
		});

		it("counts the members and bots in each project it lists, for those who may list them", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const helper = await aBot(adminId, "Triage");
			await projectsAs(editorId).addBot({ projectId: made.id, botId: helper.id });

			// The administrator, in every project members made, the creator, and the lead and the bot added.
			expect(await visibleTo(editorId)).toEqual([
				expect.objectContaining({ id: made.id, memberCount: 2, botCount: 2 }),
			]);
			// Somebody who may only join it is not told who is in it.
			const [listed] = await visibleTo(viewerId);
			expect(listed).not.toHaveProperty("memberCount");
			expect(listed).not.toHaveProperty("botCount");
		});

		it("lists a private project only to the members in it", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga", visibility: "private" });

			expect(await listedTo(editorId)).toEqual([{ id: made.id, isMember: true }]);
			// Administrators are in every project members made, private ones included.
			expect(await listedTo(adminId)).toEqual([{ id: made.id, isMember: true }]);
			expect(await visibleTo(viewerId)).toEqual([]);
		});

		it("refuses a slug already used in the same workspace", async () => {
			await create(adminId, { name: "Suga", slug: "suga" });

			await expect(create(adminId, { name: "Suga again", slug: "suga" })).rejects.toThrow(
				ProjectStore.ProjectSlugTaken,
			);
		});

		it("allows the same slug in another workspace", async () => {
			await create(adminId, { name: "General", slug: "general" });

			await expect(
				createIn(otherWorkspaceId, adminId, { name: "General", slug: "general" }),
			).resolves.toMatchObject({ slug: "general" });
		});

		it("gives a project with no colour chosen one no other project in the workspace has yet", async () => {
			await create(adminId, { name: "Suga", slug: "suga", color: "green" });
			await create(adminId, { name: "Sales", slug: "sales", color: "plum" });

			const made = await create(adminId, { name: "Ops", slug: "ops" });

			expect(made.color).toBe("blue");
		});
	});

	describe("membership", () => {
		it("adds, lists and removes members", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await repository.addMember(workspaceId, made.id, editorId);
			expect((await membersOf(made.id)).map((row) => row.name)).toEqual(["Ada", "Sam"]);

			expect(await repository.removeMember(workspaceId, made.id, editorId)).toBe("removed");
			expect((await membersOf(made.id)).map((row) => row.name)).toEqual(["Ada"]);
		});

		it("names its members as the members reaching it", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await repository.addMember(workspaceId, made.id, editorId);

			const members = await projectsAs(editorId).membersReaching({ projectId: made.id });

			expect(members.map(({ name, handle }) => ({ name, handle }))).toEqual([
				{ name: "Ada", handle: "ada" },
				{ name: "Sam", handle: "sam" },
			]);
		});

		it("is idempotent, so adding twice is not an error", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await repository.addMember(workspaceId, made.id, editorId);
			await repository.addMember(workspaceId, made.id, editorId);

			expect(await membersOf(made.id)).toHaveLength(2);
		});

		it("does not add somebody from another workspace", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			expect(await repository.addMember(workspaceId, made.id, outsiderId)).toBe(false);
		});

		it("rejects a cross-workspace membership at the database boundary", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await expect(
				onDatabase((db) =>
					db
						.insert(projectMember)
						.values({ workspaceId, projectId: made.id, memberId: outsiderId }),
				),
			).rejects.toThrow();
		});

		it("takes somebody out of their projects when they leave the workspace, and does not put them back", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga", visibility: "private" });
			await repository.addMember(workspaceId, made.id, editorId);

			await onDatabase((db) =>
				db
					.delete(membership)
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, editorId))),
			);
			await addTestMemberships({ workspaceId, memberId: editorId, role: "editor" });

			expect(await visibleTo(editorId)).toEqual([]);
			expect((await membersOf(made.id)).map(({ memberId }) => memberId)).not.toContain(editorId);
			await expect(projectsAs(editorId).members({ projectId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("joining and inviting", () => {
		it("lets anybody in the workspace join a public project, once", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			expect(await projectsAs(viewerId).join({ projectId: made.id })).toMatchObject({
				isMember: true,
				permissions: { join: false, leave: true },
			});
			await projectsAs(viewerId).join({ projectId: made.id });

			expect((await membersOf(made.id)).map(({ memberId }) => memberId).toSorted()).toEqual(
				[adminId, viewerId].toSorted(),
			);
		});

		it("does not let anybody join a private project, and hides it from them", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga", visibility: "private" });

			await expect(projectsAs(editorId).join({ projectId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(projectsAs(outsiderId).join({ projectId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("lets somebody join a project they are joining at the same time, once", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			// The other join, which has found them not yet in it and added them.
			const otherJoin = holdTransaction(
				query((db) =>
					db.insert(projectMember).values({ workspaceId, projectId: made.id, memberId: editorId }),
				),
			);
			await otherJoin.held;

			const joining = projectsAs(editorId).join({ projectId: made.id });
			await waitUntilWaitingOnLocks(1);
			await otherJoin.release();

			await expect(joining).resolves.toMatchObject({ id: made.id });
			expect((await membersOf(made.id)).map(({ memberId }) => memberId).toSorted()).toEqual(
				[adminId, editorId].toSorted(),
			);
		});

		it("does not let somebody join a project made private as they join it", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const hiding = holdTransaction(
				Effect.flatMap(ProjectStore.Service, (projects) =>
					projects.update(workspaceId, made.id, { visibility: "private" }),
				).pipe(Effect.provide(ProjectStore.layer)),
			);
			await hiding.held;

			const joining = projectsAs(editorId).join({ projectId: made.id });
			await waitUntilWaitingOnLocks(1);
			await hiding.release();

			await expect(joining).rejects.toThrow(ResourceHidden);
			expect((await membersOf(made.id)).map(({ memberId }) => memberId)).toEqual([adminId]);
		});

		it("lets an editor in a project invite and remove members, and a viewer neither", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga", visibility: "private" });

			await projectsAs(editorId).addMember({ projectId: made.id, memberId: viewerId });
			await expect(
				projectsAs(viewerId).removeMember({ projectId: made.id, memberId: editorId }),
			).rejects.toThrow(ActionForbidden);
			await projectsAs(editorId).removeMember({ projectId: made.id, memberId: viewerId });

			expect((await membersOf(made.id)).map(({ memberId }) => memberId).toSorted()).toEqual(
				[adminId, editorId].toSorted(),
			);
			await expect(
				projectsAs(editorId).removeMember({ projectId: made.id, memberId: viewerId }),
			).rejects.toBeInstanceOf(NotInProject);
			await expect(
				projectsAs(editorId).removeMember({ projectId: made.id, memberId: adminId }),
			).rejects.toBeInstanceOf(AdministratorInEveryProject);
			await expect(
				projectsAs(editorId).addMember({ projectId: made.id, memberId: outsiderId }),
			).rejects.toBeInstanceOf(NotInWorkspace);
		});
	});

	describe("bots", () => {
		it("adds a public bot to a project, lists it, and takes it out", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const bot = await aBot(adminId, "Triage");

			await projectsAs(editorId).addBot({ projectId: made.id, botId: bot.id });
			await projectsAs(editorId).addBot({ projectId: made.id, botId: bot.id });
			expect((await projectsAs(editorId).bots({ projectId: made.id })).map(({ id }) => id)).toEqual(
				[leadId, bot.id],
			);

			await projectsAs(editorId).removeBot({ projectId: made.id, botId: bot.id });
			expect((await projectsAs(editorId).bots({ projectId: made.id })).map(({ id }) => id)).toEqual(
				[leadId],
			);
		});

		it("lists each bot as pinned for whoever pinned it", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const bot = await aBot(editorId, "Triage");
			await projectsAs(editorId).addBot({ projectId: made.id, botId: bot.id });

			const pinnedFor = async (memberId: string) =>
				(await projectsAs(memberId).bots({ projectId: made.id })).map(({ id, pinned }) => ({
					id,
					pinned,
				}));
			expect(await pinnedFor(editorId)).toEqual([
				{ id: leadId, pinned: false },
				{ id: bot.id, pinned: true },
			]);
			expect(await pinnedFor(adminId)).toEqual([
				{ id: leadId, pinned: false },
				{ id: bot.id, pinned: false },
			]);
		});

		it("refuses a personal bot, even its creator's, and hides one the member doesn't reach", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const own = await aBot(editorId, "Diary", "personal");
			const someoneElses = await aBot(adminId, "Ledger", "personal");

			await expect(
				projectsAs(editorId).addBot({ projectId: made.id, botId: own.id }),
			).rejects.toBeInstanceOf(ProjectStore.PersonalBotInProject);
			await expect(
				projectsAs(editorId).addBot({ projectId: made.id, botId: someoneElses.id }),
			).rejects.toThrow(ResourceHidden);
			expect((await projectsAs(editorId).bots({ projectId: made.id })).map(({ id }) => id)).toEqual(
				[leadId],
			);
		});

		it("does not let a viewer add a bot", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const bot = await aBot(adminId, "Triage");
			await repository.addMember(workspaceId, made.id, viewerId);

			await expect(
				projectsAs(viewerId).addBot({ projectId: made.id, botId: bot.id }),
			).rejects.toThrow(ActionForbidden);
		});
	});

	describe("renaming", () => {
		it("refuses a slug another project in the workspace holds", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await create(adminId, { name: "Sales", slug: "sales" });

			await expect(repository.update(workspaceId, made.id, { slug: "sales" })).rejects.toThrow(
				ProjectStore.ProjectSlugTaken,
			);
		});

		it("says the project is gone, not that its slug is taken", async () => {
			// Renaming a project somebody else deleted in between.
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await repository.remove(workspaceId, made.id);

			await expect(repository.update(workspaceId, made.id, { name: "Platform" })).rejects.toThrow(
				ProjectStore.ProjectGone,
			);
		});
	});

	describe("project reach and permissions", () => {
		it("puts every administrator in a new project, and keeps them there", async () => {
			await onDatabase((db) =>
				db
					.update(membership)
					.set({ role: "admin" })
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, viewerId))),
			);

			const made = await create(adminId, { name: "Sales", slug: "sales" });

			expect((await membersOf(made.id)).map(({ memberId }) => memberId).toSorted()).toEqual(
				[adminId, viewerId].toSorted(),
			);
			expect(await repository.removeMember(workspaceId, made.id, viewerId)).toBe("administrator");
		});

		it("lists exactly the projects each role may read one by one as theirs, and other public ones to join", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			const apart = await create(adminId, { name: "Legal", slug: "legal" });
			const secret = await create(adminId, { name: "Board", slug: "board", visibility: "private" });
			await repository.addMember(workspaceId, joined.id, editorId);
			await repository.addMember(workspaceId, joined.id, viewerId);
			const members = { admin: adminId, editor: editorId, viewer: viewerId };
			const projects: Record<string, { id: string; isPublic: boolean }> = {
				"public, with the editor and viewer in it": { id: joined.id, isPublic: true },
				"public, with only the administrator in it": { id: apart.id, isPublic: true },
				"private, with only the administrator in it": { id: secret.id, isPublic: false },
			};

			for (const [role, memberId] of Object.entries(members)) {
				const listed = new Map(
					(await listedTo(memberId)).map(({ id, isMember }) => [id, isMember]),
				);
				for (const [project, { id, isPublic }] of Object.entries(projects)) {
					const readable = await projectsAs(memberId)
						.bots({ projectId: id })
						.then(() => true)
						.catch((refusal) =>
							refusal instanceof ResourceHidden ? false : Promise.reject(refusal),
						);
					expect({ role, project, listed: listed.get(id) }).toEqual({
						role,
						project,
						listed: readable ? true : isPublic ? false : undefined,
					});
				}
			}
		});

		it("carries the caller's resolved permissions on each project it lists", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, editorId);

			const [seen] = (await visibleTo(editorId)).filter(({ id }) => id === made.id);

			expect(seen?.permissions).toEqual({
				rename: false,
				manageMembers: true,
				manageBots: true,
				leave: true,
				join: false,
				delete: false,
				resources: {
					readHistory: true,
					resolveChats: true,
					openSettings: true,
					deleteFiles: false,
					manageConnectors: false,
					manageComputer: false,
					useDesktop: true,
					manageAutomations: false,
					pauseAutomations: false,
					runAutomations: true,
				},
			});
		});

		it("carries a viewer's permissions on the projects it lists, all closed but leaving", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, joined.id, viewerId);

			const [seen] = await visibleTo(viewerId);
			const { leave, ...others } = seen?.permissions ?? { leave: false };

			expect(leave).toBe(true);
			expect(Object.values(others)).not.toContain(true);
		});

		it("lets an editor leave a project, and keeps an administrator in it", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, editorId);

			await projectsAs(editorId).leave({ projectId: made.id });

			expect((await membersOf(made.id)).map(({ memberId }) => memberId)).toEqual([adminId]);
			await expect(projectsAs(adminId).leave({ projectId: made.id })).rejects.toThrow(
				ActionForbidden,
			);
		});

		it("keeps a demoted administrator in their projects, with an editor's permissions there", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });

			await onDatabase((db) =>
				db
					.update(membership)
					.set({ role: "editor" })
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, adminId))),
			);

			await expect(projectsAs(adminId).members({ projectId: made.id })).resolves.toEqual([
				expect.objectContaining({ memberId: adminId }),
			]);
			await expect(projectsAs(adminId).remove({ projectId: made.id })).rejects.toThrow(
				ActionForbidden,
			);
			expect(await repository.removeMember(workspaceId, made.id, adminId)).toBe("removed");
			await expect(projectsAs(adminId).members({ projectId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("reads what a member reaches only once a removal under way has committed, then refuses it", async () => {
			const diary = await aBot(editorId, "Diary", "private");
			await botsAs(editorId).addMember({ botId: diary.id, memberId: viewerId });
			const closed = await create(adminId, {
				name: "Closed",
				slug: "closed",
				visibility: "private",
			});
			await repository.addMember(workspaceId, closed.id, viewerId);
			const chatId = await seedProjectChat(workspaceId, closed.id, adminId);
			const viewer = await signIn(viewerId);
			const removing = holdTransaction(
				Effect.gen(function* () {
					yield* query((db) =>
						db
							.select({ id: workspace.id })
							.from(workspace)
							.where(eq(workspace.id, workspaceId))
							.for("no key update"),
					);
					yield* query((db) =>
						db
							.delete(botMember)
							.where(and(eq(botMember.botId, diary.id), eq(botMember.memberId, viewerId))),
					);
					yield* query((db) =>
						db
							.delete(projectMember)
							.where(
								and(eq(projectMember.projectId, closed.id), eq(projectMember.memberId, viewerId)),
							),
					);
				}),
			);
			await removing.held;

			const reads = [
				callOperation(viewer, "bots.listMembers", { botId: diary.id }),
				callOperation(viewer, "chats.messages", { chatId, limit: 1 }),
			];
			await waitUntilWaitingOnLocks(reads.length);
			await removing.release();

			for (const read of reads) await expect(read).rejects.toThrow(ResourceHidden);
		});

		it("lists an administrator of two workspaces only the projects of the one asked about", async () => {
			const here = await create(adminId, { name: "Sales", slug: "sales" });
			await createIn(otherWorkspaceId, adminId, {
				name: "Sales",
				slug: "sales",
				visibility: "private",
			});

			expect(await visibleTo(adminId)).toEqual([expect.objectContaining({ id: here.id })]);
		});

		it("answers no to a workspace that isn't there, and never looks up a project id that isn't a uuid", async () => {
			await expect(visibleTo(adminId, "nonsense")).rejects.toThrow(ResourceHidden);
			await expect(projectsAs(adminId).members({ projectId: "nonsense" })).rejects.toThrow(
				"projects.listMembers was called with an input its contract refuses",
			);
		});
	});

	describe("refusals, decided in the administration", () => {
		it("refuses a command to somebody who may not make it, whoever called it", async () => {
			// No route and no middleware in front: this is what a new entrypoint
			// that forgot to check would reach.
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, editorId);

			await expect(projectsAs(editorId).remove({ projectId: made.id })).rejects.toThrow(
				ActionForbidden,
			);
			await expect(
				projectsAs(editorId).update({ projectId: made.id, changes: { name: "Ours" } }),
			).rejects.toThrow(ActionForbidden);
			await expect(create(viewerId, { name: "Mine", slug: "mine" })).rejects.toThrow(
				ActionForbidden,
			);
			expect(await listedTo(viewerId)).toEqual([{ id: made.id, isMember: false }]);
		});

		it("hides a project from somebody who is not in it, whatever they asked", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales", visibility: "private" });

			await expect(
				projectsAs(editorId).update({ projectId: made.id, changes: { name: "Ours" } }),
			).rejects.toThrow(ResourceHidden);
			await expect(projectsAs(outsiderId).members({ projectId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(visibleTo(outsiderId)).rejects.toThrow(ResourceHidden);
		});
	});

	describe("lead bots", () => {
		it("makes a project with its lead among its bots, and refuses a personal one", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			expect(made.leadBotId).toBe(leadId);
			expect((await projectsAs(editorId).bots({ projectId: made.id })).map(({ id }) => id)).toEqual(
				[leadId],
			);

			const diary = await aBot(editorId, "Diary", "personal");
			await expect(
				projectsAs(editorId).create({
					workspace: workspaceId,
					name: "Mine",
					slug: "mine",
					leadBotId: diary.id,
				}),
			).rejects.toBeInstanceOf(ProjectStore.PersonalBotInProject);
			expect((await listedTo(editorId)).map(({ id }) => id)).toEqual([made.id]);
		});

		it("lets whoever may change the project choose another lead, which joins its bots", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const triage = await aBot(adminId, "Triage");

			await expect(
				projectsAs(editorId).update({
					projectId: made.id,
					changes: { leadBotId: triage.id },
				}),
			).rejects.toThrow();
			const changed = await projectsAs(adminId).update({
				projectId: made.id,
				changes: { leadBotId: triage.id },
			});

			expect(changed.leadBotId).toBe(triage.id);
			expect((await projectsAs(adminId).bots({ projectId: made.id })).map(({ id }) => id)).toEqual([
				leadId,
				triage.id,
			]);
		});

		it("keeps a lead in its project and undeleted until another is chosen", async () => {
			const sales = await create(adminId, { name: "Sales", slug: "sales" });
			const ops = await create(adminId, { name: "Ops", slug: "ops" });
			const triage = await aBot(adminId, "Triage");

			const removing = projectsAs(adminId).removeBot({
				projectId: sales.id,
				botId: leadId,
			});
			await expect(removing).rejects.toBeInstanceOf(LeadsProjects);
			await expect(removing).rejects.toMatchObject({
				userMessage: "Lead leads Sales. Choose another lead bot for it first.",
			});
			await expect(botsAs(adminId).remove({ botId: leadId })).rejects.toMatchObject({
				userMessage: "Lead leads Ops and Sales. Choose another lead bot for each first.",
			});

			for (const projectId of [sales.id, ops.id]) {
				await projectsAs(adminId).update({ projectId, changes: { leadBotId: triage.id } });
			}
			await projectsAs(adminId).removeBot({ projectId: sales.id, botId: leadId });
			await botsAs(adminId).remove({ botId: leadId });
		});

		it("names to whoever is refused only the projects they see among those the bot leads", async () => {
			const triage = await aBot(editorId, "Triage");
			const ops = await create(adminId, { name: "Ops", slug: "ops" });
			const secret = await create(adminId, {
				name: "Secret",
				slug: "secret",
				visibility: "private",
			});
			for (const projectId of [ops.id, secret.id]) {
				await projectsAs(adminId).update({ projectId, changes: { leadBotId: triage.id } });
			}

			const toCreator = {
				userMessage:
					"Triage leads Ops and private projects you aren't in. Each needs another lead bot first.",
			};
			await expect(botsAs(editorId).remove({ botId: triage.id })).rejects.toMatchObject(toCreator);
			await expect(botsAs(adminId).remove({ botId: triage.id })).rejects.toMatchObject({
				userMessage: "Triage leads Ops and Secret. Choose another lead bot for each first.",
			});
		});

		it("refuses to take out a bot being chosen as lead, though the choice is not yet written", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const triage = await aBot(adminId, "Triage");
			await repository.addBot(workspaceId, made.id, triage.id);
			// Stalls the new lead's write after the choice has found Triage among
			// the project's bots, without stopping anything from locking its row.
			const projectWrites = holdTransaction(
				query((db) => db.execute(sql`lock table ${project} in share mode`)),
			);
			await projectWrites.held;

			const choosing = repository.update(workspaceId, made.id, { leadBotId: triage.id });
			await waitUntilWaitingOnLocks(1);
			const removing = repository.removeBot(workspaceId, made.id, triage.id, adminId);
			await waitUntilWaitingOnLocks(2);
			await projectWrites.release();

			await expect(choosing).resolves.toMatchObject({ leadBotId: triage.id });
			await expect(removing).rejects.toBeInstanceOf(LeadsProjects);
			expect((await projectsAs(adminId).bots({ projectId: made.id })).map(({ id }) => id)).toEqual([
				leadId,
				triage.id,
			]);
		});

		it("puts a bot back in its project when chosen as lead while being taken out", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const triage = await aBot(adminId, "Triage");
			await repository.addBot(workspaceId, made.id, triage.id);
			const removing = holdTransaction(
				Effect.flatMap(ProjectStore.Service, (projects) =>
					projects.removeBot(workspaceId, made.id, triage.id, adminId),
				).pipe(Effect.provide(ProjectStore.layer)),
			);
			await removing.held;

			const choosing = repository.update(workspaceId, made.id, { leadBotId: triage.id });
			await waitUntilWaitingOnLocks(1);
			await removing.release();

			await expect(choosing).resolves.toMatchObject({ leadBotId: triage.id });
			expect((await projectsAs(adminId).bots({ projectId: made.id })).map(({ id }) => id)).toEqual([
				leadId,
				triage.id,
			]);
		});
	});

	describe("private bots", () => {
		/** The ids of the members of the bot `botId`, as `memberId` lists them. */
		const botMemberIds = async (memberId: string, botId: string) =>
			(await botsAs(memberId).members({ botId })).map((one) => one.memberId).sort();
		/** The ids of the bots `memberId` is listed. */
		const botsListedTo = async (memberId: string) =>
			(await botsAs(memberId).list()).map(({ id }) => id);

		it("is reached by its creator, the admins and the members they invite, and listed only to them", async () => {
			const diary = await aBot(editorId, "Diary", "private");

			expect(await botMemberIds(editorId, diary.id)).toEqual([adminId, editorId].sort());
			expect(await botsListedTo(viewerId)).not.toContain(diary.id);
			await expect(botsAs(viewerId).members({ botId: diary.id })).rejects.toThrow(ResourceHidden);

			await botsAs(editorId).addMember({ botId: diary.id, memberId: viewerId });
			expect(await botsListedTo(viewerId)).toContain(diary.id);
			expect(await botMemberIds(viewerId, diary.id)).toEqual([adminId, editorId, viewerId].sort());
			await expect(
				botsAs(viewerId).addMember({ botId: diary.id, memberId: outsiderId }),
			).rejects.toThrow(ActionForbidden);
			await expect(
				botsAs(editorId).removeMember({ botId: diary.id, memberId: adminId }),
			).rejects.toBeInstanceOf(AdministratorInEveryPrivateBot);

			await botsAs(editorId).removeMember({ botId: diary.id, memberId: viewerId });
			expect(await botsListedTo(viewerId)).not.toContain(diary.id);
			await expect(
				botsAs(editorId).removeMember({ botId: diary.id, memberId: viewerId }),
			).rejects.toBeInstanceOf(NotBotMember);
		});

		it("keeps its creator among its members, who can't be taken out", async () => {
			const diary = await aBot(editorId, "Diary", "private");

			const listed = await botsAs(adminId).members({ botId: diary.id });
			expect(listed.find(({ memberId }) => memberId === editorId)?.removable).toBe(false);
			await expect(
				botsAs(adminId).removeMember({ botId: diary.id, memberId: editorId }),
			).rejects.toBeInstanceOf(CreatorInOwnPrivateBot);
			expect(await botMemberIds(adminId, diary.id)).toContain(editorId);
		});

		it("gives its creator no say over it while they aren't one of its members, as when an upgrade left them out", async () => {
			const diary = await aBot(editorId, "Diary", "private");
			await onDatabase((db) =>
				db
					.delete(botMember)
					.where(and(eq(botMember.botId, diary.id), eq(botMember.memberId, editorId))),
			);

			await expect(
				botsAs(editorId).update({ botId: diary.id, changes: { name: "Mine" } }),
			).rejects.toThrow(ResourceHidden);
		});

		it("puts a promoted member in every private bot, and keeps them there once demoted, until taken out", async () => {
			const diary = await aBot(editorId, "Diary", "private");
			const setRole = (role: "admin" | "viewer") =>
				onDatabase((db) =>
					db
						.update(membership)
						.set({ role })
						.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, viewerId))),
				);

			await setRole("admin");
			expect(await botMemberIds(editorId, diary.id)).toContain(viewerId);
			await setRole("viewer");
			const listed = await botsAs(editorId).members({ botId: diary.id });
			expect(listed.find(({ memberId }) => memberId === viewerId)?.removable).toBe(true);
			expect(await botsListedTo(viewerId)).toContain(diary.id);

			await botsAs(editorId).removeMember({ botId: diary.id, memberId: viewerId });
			expect(await botsListedTo(viewerId)).not.toContain(diary.id);
		});

		it("joins and leads private projects only, where the project's members talk to it", async () => {
			const diary = await aBot(editorId, "Diary", "private");
			const open = await create(editorId, { name: "Open", slug: "open" });
			const closed = await create(editorId, {
				name: "Closed",
				slug: "closed",
				visibility: "private",
			});
			await projectsAs(editorId).addMember({ projectId: closed.id, memberId: viewerId });

			await expect(
				projectsAs(editorId).addBot({ projectId: open.id, botId: diary.id }),
			).rejects.toBeInstanceOf(ProjectStore.BotNotPublic);
			await expect(
				projectsAs(editorId).create({
					workspace: workspaceId,
					name: "Led",
					slug: "led",
					leadBotId: diary.id,
				}),
			).rejects.toBeInstanceOf(ProjectStore.BotNotPublic);
			const led = await projectsAs(editorId).create({
				workspace: workspaceId,
				name: "Led",
				slug: "led",
				visibility: "private",
				leadBotId: diary.id,
			});
			expect(led.leadBotId).toBe(diary.id);

			await projectsAs(editorId).addBot({ projectId: closed.id, botId: diary.id });
			// Vi talks to it in Closed, and reaches it nowhere else.
			expect(
				(await projectsAs(viewerId).bots({ projectId: closed.id })).map(({ id }) => id),
			).toContain(diary.id);
			expect(await botsListedTo(viewerId)).not.toContain(diary.id);
		});

		it("keeps a project with a private bot private until the bot leaves it", async () => {
			const diary = await aBot(editorId, "Diary", "private");
			const closed = await create(adminId, {
				name: "Closed",
				slug: "closed",
				visibility: "private",
			});
			await projectsAs(adminId).addBot({ projectId: closed.id, botId: diary.id });

			const opening = projectsAs(adminId).update({
				projectId: closed.id,
				changes: { visibility: "public" },
			});
			await expect(opening).rejects.toBeInstanceOf(ProjectStore.ProjectHasPrivateBots);
			await expect(opening).rejects.toMatchObject({
				userMessage: "Diary is a private bot, so this project stays private until they leave it.",
			});

			await projectsAs(adminId).removeBot({ projectId: closed.id, botId: diary.id });
			const opened = await projectsAs(adminId).update({
				projectId: closed.id,
				changes: { visibility: "public" },
			});
			expect(opened.visibility).toBe("public");
		});

		it("takes a bot made private out of public projects, once it leads none, and keeps it in private ones", async () => {
			const triage = await aBot(editorId, "Triage");
			const open = await create(editorId, { name: "Open", slug: "open" });
			const closed = await create(editorId, {
				name: "Closed",
				slug: "closed",
				visibility: "private",
			});
			for (const projectId of [open.id, closed.id]) {
				await projectsAs(editorId).addBot({ projectId, botId: triage.id });
			}
			await projectsAs(adminId).update({ projectId: open.id, changes: { leadBotId: triage.id } });

			await expect(
				botsAs(editorId).update({ botId: triage.id, changes: { visibility: "private" } }),
			).rejects.toMatchObject({
				userMessage: "Triage leads Open. Choose another lead bot for it first.",
			});

			await projectsAs(adminId).update({ projectId: open.id, changes: { leadBotId: leadId } });
			const made = await botsAs(editorId).update({
				botId: triage.id,
				changes: { visibility: "private" },
			});
			expect(made.visibility).toBe("private");
			const botsIn = async (projectId: string) =>
				(await projectsAs(adminId).bots({ projectId })).map(({ id }) => id);
			expect(await botsIn(open.id)).not.toContain(triage.id);
			expect(await botsIn(closed.id)).toContain(triage.id);
			expect(await botMemberIds(editorId, triage.id)).toEqual([adminId, editorId].sort());

			// Made public again, it stays in Closed, and has no members: everyone reaches it.
			await botsAs(editorId).update({ botId: triage.id, changes: { visibility: "public" } });
			expect(await botsIn(closed.id)).toContain(triage.id);
			expect(await botMemberIds(viewerId, triage.id)).toEqual([]);
			expect(await botsListedTo(viewerId)).toContain(triage.id);
		});

		it("never makes a bot personal, or a personal bot public or private", async () => {
			const triage = await aBot(editorId, "Triage", "private");
			const diary = await aBot(editorId, "Diary", "personal");

			await expect(
				botsAs(editorId).update({ botId: triage.id, changes: { visibility: "personal" } }),
			).rejects.toBeInstanceOf(PersonalVisibilityFixed);
			await expect(
				botsAs(editorId).update({ botId: diary.id, changes: { visibility: "private" } }),
			).rejects.toBeInstanceOf(PersonalVisibilityFixed);
		});
	});

	describe("a bot's default project", () => {
		/** The default project of `botId`, which the bot was made with. */
		const defaultProjectOf = async (botId: string) => {
			const [row] = await onDatabase((db) =>
				db.select().from(project).where(eq(project.defaultOfBotId, botId)),
			);
			if (!row) throw new Error(`Bot ${botId} has no default project`);
			return row;
		};

		it("is made with its bot, led by it alone, and goes with it", async () => {
			const diary = await aBot(editorId, "Diary", "personal");
			const own = await defaultProjectOf(diary.id);

			expect(own).toMatchObject({ leadBotId: diary.id, workspaceId });
			expect((await projectsAs(editorId).bots({ projectId: own.id })).map(({ id }) => id)).toEqual([
				diary.id,
			]);
			// Nobody is a member of one, administrators included.
			expect(
				await onDatabase((db) =>
					db.select().from(projectMember).where(eq(projectMember.projectId, own.id)),
				),
			).toEqual([]);

			await botsAs(editorId).remove({ botId: diary.id });
			expect(
				await onDatabase((db) => db.select().from(project).where(eq(project.id, own.id))),
			).toEqual([]);
		});

		it("is never listed, and is reached by whoever reaches its bot", async () => {
			const diary = await aBot(editorId, "Diary", "personal");
			const triage = await aBot(adminId, "Triage");
			const diaryOwn = await defaultProjectOf(diary.id);
			const triageOwn = await defaultProjectOf(triage.id);

			for (const memberId of [adminId, editorId, viewerId]) {
				const listed = (await listedTo(memberId)).map(({ id }) => id);
				expect(listed).not.toContain(diaryOwn.id);
				expect(listed).not.toContain(triageOwn.id);
			}
			for (const memberId of [adminId, editorId, viewerId]) {
				await expect(projectsAs(memberId).bots({ projectId: triageOwn.id })).resolves.toEqual([
					expect.objectContaining({ id: triage.id }),
				]);
			}
			await expect(projectsAs(editorId).bots({ projectId: diaryOwn.id })).resolves.toEqual([
				expect.objectContaining({ id: diary.id }),
			]);
			await expect(projectsAs(adminId).bots({ projectId: diaryOwn.id })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(projectsAs(outsiderId).bots({ projectId: triageOwn.id })).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("names as the members reaching it whoever reaches its bot, though it has no members", async () => {
			const diary = await aBot(editorId, "Diary", "personal");
			const triage = await aBot(adminId, "Triage");
			const membersReaching = async (botId: string) =>
				(
					await projectsAs(editorId).membersReaching({
						projectId: (await defaultProjectOf(botId)).id,
					})
				).map(({ name }) => name);

			expect(await membersReaching(triage.id)).toEqual(["Ada", "Lee", "Sam"]);
			expect(await membersReaching(diary.id)).toEqual(["Sam"]);
		});

		it("is never joined, left, staffed, changed or deleted on its own", async () => {
			const triage = await aBot(adminId, "Triage");
			const other = await aBot(adminId, "Other");
			const own = await defaultProjectOf(triage.id);
			const projectId = own.id;

			for (const memberId of [adminId, editorId]) {
				const as = projectsAs(memberId);
				await expect(as.join({ projectId })).rejects.toThrow(ResourceHidden);
				await expect(as.leave({ projectId })).rejects.toThrow(ActionForbidden);
				await expect(as.addMember({ projectId, memberId: viewerId })).rejects.toThrow(
					ActionForbidden,
				);
				await expect(as.addBot({ projectId, botId: other.id })).rejects.toThrow(ActionForbidden);
				await expect(as.removeBot({ projectId, botId: triage.id })).rejects.toThrow(
					ActionForbidden,
				);
				await expect(as.update({ projectId, changes: { name: "Mine" } })).rejects.toThrow(
					ActionForbidden,
				);
				await expect(as.remove({ projectId })).rejects.toThrow(ActionForbidden);
			}
			const members = await onDatabase((db) =>
				db
					.select()
					.from(projectMember)
					.innerJoin(project, eq(project.id, projectMember.projectId))
					.where(and(eq(project.workspaceId, workspaceId), isNotNull(project.defaultOfBotId))),
			);
			expect(members).toEqual([]);
		});
	});

	describe("deleting while a first computer is recorded", () => {
		/** Records a first computer for the project, made by a new provider. */
		const recordingFirstComputerOf = async (projectId: string) => {
			const [provider] = await onDatabase((db) =>
				db
					.insert(computerProvider)
					.values({
						workspaceId,
						settings: {
							builtIn: "opensandbox",
							serverUrl: "http://computers.test",
							image: "debian",
						},
						enabled: true,
					})
					.returning(),
			);
			if (!provider) throw new Error("could not create the test computer provider");
			return recordingFirstComputer({ workspaceId, projectId, computerProviderId: provider.id });
		};
		const computersOf = (projectId: string) =>
			onDatabase((db) =>
				db.select({ id: computer.id }).from(computer).where(eq(computer.projectId, projectId)),
			);

		it("keeps the project, and its computer's record", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const recording = await recordingFirstComputerOf(made.id);

			const removing = projectsAs(adminId).remove({ projectId: made.id });
			await waitUntilWaitingOnLocks(1);
			await recording.release();

			await expect(removing).rejects.toBeInstanceOf(ProjectComputers.ComputerMadeMeanwhile);
			expect(await computersOf(made.id)).toHaveLength(1);
		});

		it("keeps a bot whose default project it is, and the computer's record", async () => {
			const triage = await aBot(adminId, "Triage");
			const [own] = await onDatabase((db) =>
				db.select({ id: project.id }).from(project).where(eq(project.defaultOfBotId, triage.id)),
			);
			if (!own) throw new Error("The bot has no default project");
			const recording = await recordingFirstComputerOf(own.id);

			const removing = botsAs(adminId).remove({ botId: triage.id });
			await waitUntilWaitingOnLocks(1);
			await recording.release();

			await expect(removing).rejects.toBeInstanceOf(ProjectComputers.ComputerMadeMeanwhile);
			expect(await computersOf(own.id)).toHaveLength(1);
		});
	});
});
