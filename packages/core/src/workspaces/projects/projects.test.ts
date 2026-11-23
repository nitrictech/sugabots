import {
	PROJECT_DESCRIPTION_MAX_LENGTH,
	PROJECT_NAME_MAX_LENGTH,
	type ProjectColor,
	type ProjectVisibility,
} from "@sugabots/contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { projectPermissions } from "../../authorization/permissions.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { noComputers, recordingFirstComputer } from "../../computers/testing.ts";
import { query, transaction } from "../../database/database.ts";
import {
	bot,
	computer,
	computerProvider,
	membership,
	modelProvider,
	person,
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
	runOnPostgres,
	servedOnPostgres,
	waitUntilWaitingOnLocks,
} from "../../database/testing.ts";
import { BotAdministration } from "../bots/bot-administration.ts";
import { BotStore } from "../bots/bot-store.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { ProjectAdministration } from "./project-administration.ts";
import { LeadsProjects } from "./project-leads.ts";
import { ProjectStore } from "./project-store.ts";

/**
 * Projects: the repository, the administration over it, and the authorisation
 * queries against real SQL.
 *
 * The joins behind `Authorization.project`, the query a list is scoped by, and the
 * create-plus-membership transaction are exactly the parts a fake cannot
 * check.
 */
describe.skipIf(!process.env.DATABASE_URL)("projects, against Postgres", () => {
	let repository: Promised<ProjectStore.Interface>;
	let administrationAs: (personId: string) => Promised<ProjectAdministration.Interface>;
	let botsAs: (personId: string) => Promised<BotAdministration.Interface>;
	let authorizationAs: (personId: string) => Promised<Authorization.Interface>;

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
		administrationAs = await servedOnPostgresAs(
			ProjectAdministration.Service,
			ProjectAdministration.layer.pipe(Layer.provide(noComputers)),
		);
		botsAs = await servedOnPostgresAs(
			BotAdministration.Service,
			BotAdministration.layer.pipe(Layer.provide(noComputers)),
		);
		authorizationAs = await servedOnPostgresAs(Authorization.Service, Authorization.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const create = (
		creatorId: string,
		input: { name: string; slug: string; color?: ProjectColor; visibility?: ProjectVisibility },
	) => administrationAs(creatorId).create({ workspace: workspaceId, leadBotId: leadId, ...input });
	const createIn = (
		inWorkspace: string,
		creatorId: string,
		input: { name: string; slug: string; visibility?: ProjectVisibility },
	) =>
		administrationAs(creatorId).create({
			workspace: inWorkspace,
			leadBotId: inWorkspace === workspaceId ? leadId : otherLeadId,
			...input,
		});
	const visibleTo = (personId: string, inWorkspace = workspaceId) =>
		administrationAs(personId).list({ workspace: inWorkspace });
	/** The ids of the projects `personId` is listed, with whether they are in each. */
	const listedTo = async (personId: string, inWorkspace = workspaceId) =>
		(await visibleTo(personId, inWorkspace)).map(({ id, isMember }) => ({ id, isMember }));
	/** A bot `creatorId` made, public unless said otherwise. */
	const aBot = async (creatorId: string, name: string, visibility?: "public" | "private") =>
		botsAs(creatorId).create({
			workspace: workspaceId,
			bot: { name, model: "test-model", visibility },
		});
	const membersOf = (projectId: string) => administrationAs(adminId).members({ projectId });

	beforeEach(async () => {
		// A fresh workspace per test rather than a truncate, so these can run
		// against a database that has the dev seed in it.
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const [made] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Test ${stamp}`, slug: `test-${stamp}` })
				.returning(),
		);
		const [other] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Other ${stamp}`, slug: `other-${stamp}` })
				.returning(),
		);
		if (!made || !other) {
			throw new Error("could not create the test workspaces");
		}
		workspaceId = made.id;
		otherWorkspaceId = other.id;

		const people = await onDatabase((db) =>
			db
				.insert(person)
				.values([
					{ name: "Ada", email: `ada-${stamp}@example.com` },
					{ name: "Sam", email: `sam-${stamp}@example.com` },
					{ name: "Kim", email: `kim-${stamp}@example.com` },
					{ name: "Lee", email: `lee-${stamp}@example.com` },
				])
				.returning(),
		);
		const [ada, sam, kim, lee] = people;
		if (!ada || !sam || !kim || !lee) {
			throw new Error("could not create the test people");
		}
		adminId = ada.id;
		editorId = sam.id;
		outsiderId = kim.id;
		viewerId = lee.id;

		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId, personId: adminId, role: "admin" },
				{ workspaceId, personId: editorId, role: "editor" },
				{ workspaceId, personId: viewerId, role: "viewer" },
				{ workspaceId: otherWorkspaceId, personId: adminId, role: "admin" },
				{ workspaceId: otherWorkspaceId, personId: outsiderId, role: "editor" },
			]),
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
			const made = await administrationAs(editorId).create({
				workspace: workspaceId,
				name: "Sales Team",
				leadBotId: leadId,
			});

			expect(made.slug).toBe("sales-team");
			await expect(
				administrationAs(editorId).create({
					workspace: workspaceId,
					name: "!!!",
					leadBotId: leadId,
				}),
			).rejects.toBeInstanceOf(ProjectAdministration.UnusableProjectName);
		});

		it("refuses a name or description longer than the API allows, from any caller", async () => {
			const tooLong = (length: number) => "a".repeat(length + 1);
			for (const details of [
				{ name: tooLong(PROJECT_NAME_MAX_LENGTH) },
				{ name: "Launch", description: tooLong(PROJECT_DESCRIPTION_MAX_LENGTH) },
			]) {
				await expect(
					administrationAs(editorId).create({
						workspace: workspaceId,
						leadBotId: leadId,
						...details,
					}),
				).rejects.toBeInstanceOf(ProjectAdministration.InvalidProjectDetails);
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

		it("counts the people and bots in each project it lists, for those who may list them", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const helper = await aBot(adminId, "Triage");
			await administrationAs(editorId).addBot({ projectId: made.id, botId: helper.id });

			// The administrator, in every project people made, the creator, and the lead and the bot added.
			expect(await visibleTo(editorId)).toEqual([
				expect.objectContaining({ id: made.id, memberCount: 2, botCount: 2 }),
			]);
			// Somebody who may only join it is not told who is in it.
			const [listed] = await visibleTo(viewerId);
			expect(listed).not.toHaveProperty("memberCount");
			expect(listed).not.toHaveProperty("botCount");
		});

		it("lists a private project only to the people in it", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga", visibility: "private" });

			expect(await listedTo(editorId)).toEqual([{ id: made.id, isMember: true }]);
			// Administrators are in every project people made, private ones included.
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
		it("adds, lists and removes people", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await repository.addMember(workspaceId, made.id, editorId);
			expect((await membersOf(made.id)).map((row) => row.name)).toEqual(["Ada", "Sam"]);

			expect(await repository.removeMember(workspaceId, made.id, editorId)).toBe("removed");
			expect((await membersOf(made.id)).map((row) => row.name)).toEqual(["Ada"]);
		});

		it("names its members as the people reaching it", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await repository.addMember(workspaceId, made.id, editorId);

			const people = await administrationAs(editorId).peopleReaching({ projectId: made.id });

			expect(people.map(({ name, handle }) => ({ name, handle }))).toEqual([
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
						.values({ workspaceId, projectId: made.id, personId: outsiderId }),
				),
			).rejects.toThrow();
		});

		it("takes somebody out of their projects when they leave the workspace, and does not put them back", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga", visibility: "private" });
			await repository.addMember(workspaceId, made.id, editorId);

			await onDatabase((db) =>
				db
					.delete(membership)
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.personId, editorId))),
			);
			await onDatabase((db) => db.insert(membership).values({ workspaceId, personId: editorId }));

			expect(await visibleTo(editorId)).toEqual([]);
			expect((await membersOf(made.id)).map(({ personId }) => personId)).not.toContain(editorId);
			await expect(authorizationAs(editorId).project(made.id, "project.read")).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("joining and inviting", () => {
		it("lets anybody in the workspace join a public project, once", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			expect(await administrationAs(viewerId).join({ projectId: made.id })).toMatchObject({
				isMember: true,
				permissions: { join: false, leave: true },
			});
			await administrationAs(viewerId).join({ projectId: made.id });

			expect((await membersOf(made.id)).map(({ personId }) => personId).toSorted()).toEqual(
				[adminId, viewerId].toSorted(),
			);
		});

		it("does not let anybody join a private project, and hides it from them", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga", visibility: "private" });

			await expect(administrationAs(editorId).join({ projectId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(administrationAs(outsiderId).join({ projectId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("lets somebody join a project they are joining at the same time, once", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			// The other join, which has found them not yet in it and added them.
			const otherJoin = holdTransaction(
				query((db) =>
					db.insert(projectMember).values({ workspaceId, projectId: made.id, personId: editorId }),
				),
			);
			await otherJoin.held;

			const joining = administrationAs(editorId).join({ projectId: made.id });
			await waitUntilWaitingOnLocks(1);
			await otherJoin.release();

			await expect(joining).resolves.toMatchObject({ id: made.id });
			expect((await membersOf(made.id)).map(({ personId }) => personId).toSorted()).toEqual(
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

			const joining = administrationAs(editorId).join({ projectId: made.id });
			await waitUntilWaitingOnLocks(1);
			await hiding.release();

			await expect(joining).rejects.toThrow(ResourceHidden);
			expect((await membersOf(made.id)).map(({ personId }) => personId)).toEqual([adminId]);
		});

		it("lets an editor in a project invite and remove people, and a viewer neither", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga", visibility: "private" });

			await administrationAs(editorId).addMember({ projectId: made.id, personId: viewerId });
			await expect(
				administrationAs(viewerId).removeMember({ projectId: made.id, personId: editorId }),
			).rejects.toThrow(ActionForbidden);
			await administrationAs(editorId).removeMember({ projectId: made.id, personId: viewerId });

			expect((await membersOf(made.id)).map(({ personId }) => personId).toSorted()).toEqual(
				[adminId, editorId].toSorted(),
			);
			await expect(
				administrationAs(editorId).removeMember({ projectId: made.id, personId: viewerId }),
			).rejects.toBeInstanceOf(ProjectAdministration.NotInProject);
			await expect(
				administrationAs(editorId).removeMember({ projectId: made.id, personId: adminId }),
			).rejects.toBeInstanceOf(ProjectAdministration.AdministratorInEveryProject);
			await expect(
				administrationAs(editorId).addMember({ projectId: made.id, personId: outsiderId }),
			).rejects.toBeInstanceOf(ProjectAdministration.NotInWorkspace);
		});
	});

	describe("bots", () => {
		it("adds a public bot to a project, lists it, and takes it out", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const bot = await aBot(adminId, "Triage");

			await administrationAs(editorId).addBot({ projectId: made.id, botId: bot.id });
			await administrationAs(editorId).addBot({ projectId: made.id, botId: bot.id });
			expect(
				(await administrationAs(editorId).bots({ projectId: made.id })).map(({ id }) => id),
			).toEqual([leadId, bot.id]);

			await administrationAs(editorId).removeBot({ projectId: made.id, botId: bot.id });
			expect(
				(await administrationAs(editorId).bots({ projectId: made.id })).map(({ id }) => id),
			).toEqual([leadId]);
		});

		it("lists each bot as pinned for whoever pinned it", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const bot = await aBot(editorId, "Triage");
			await administrationAs(editorId).addBot({ projectId: made.id, botId: bot.id });

			const pinnedFor = async (personId: string) =>
				(await administrationAs(personId).bots({ projectId: made.id })).map(({ id, pinned }) => ({
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

		it("refuses a private bot, even its creator's, and hides one the person doesn't reach", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const own = await aBot(editorId, "Diary", "private");
			const someoneElses = await aBot(adminId, "Ledger", "private");

			await expect(
				administrationAs(editorId).addBot({ projectId: made.id, botId: own.id }),
			).rejects.toBeInstanceOf(ProjectStore.BotNotPublic);
			await expect(
				administrationAs(editorId).addBot({ projectId: made.id, botId: someoneElses.id }),
			).rejects.toThrow(ResourceHidden);
			expect(
				(await administrationAs(editorId).bots({ projectId: made.id })).map(({ id }) => id),
			).toEqual([leadId]);
		});

		it("does not add a bot being made private at the same time", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			const bot = await aBot(adminId, "Triage");
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let madePrivate = () => {};
			const privateUncommitted = new Promise<void>((resolve) => {
				madePrivate = resolve;
			});
			const makingPrivate = runOnPostgres(
				transaction(
					Effect.gen(function* () {
						const bots = yield* BotStore.Service;
						yield* bots.update(workspaceId, bot.id, { visibility: "private" }, adminId);
						madePrivate();
						yield* Effect.promise(() => released);
					}),
				).pipe(Effect.provide(BotStore.layer)),
			);
			await privateUncommitted;

			const adding = repository.addBot(workspaceId, made.id, bot.id);
			await new Promise((resolve) => setTimeout(resolve, 300));
			release();
			await makingPrivate;

			await expect(adding).rejects.toBeInstanceOf(ProjectStore.BotNotPublic);
			expect(
				(await administrationAs(adminId).bots({ projectId: made.id })).map(({ id }) => id),
			).toEqual([leadId]);
		});

		it("does not let a viewer add a bot", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const bot = await aBot(adminId, "Triage");
			await repository.addMember(workspaceId, made.id, viewerId);

			await expect(
				administrationAs(viewerId).addBot({ projectId: made.id, botId: bot.id }),
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

	describe("authorisation", () => {
		it("lets a person in the workspace in, and keeps an outsider out", async () => {
			expect(await authorizationAs(adminId).workspace(workspaceId, "project.create")).toMatchObject(
				{
					actor: { workspaceRole: "admin" },
				},
			);
			expect(
				await authorizationAs(editorId).workspace(workspaceId, "project.create"),
			).toMatchObject({
				actor: { workspaceRole: "editor" },
			});
			await expect(
				authorizationAs(viewerId).workspace(workspaceId, "project.create"),
			).rejects.toThrow(ActionForbidden);
			await expect(
				authorizationAs(outsiderId).workspace(workspaceId, "workspace.read"),
			).rejects.toThrow(ResourceHidden);
		});

		it("puts every administrator in a new project, and keeps them there", async () => {
			await onDatabase((db) =>
				db
					.update(membership)
					.set({ role: "admin" })
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.personId, viewerId))),
			);

			const made = await create(adminId, { name: "Sales", slug: "sales" });

			expect((await membersOf(made.id)).map(({ personId }) => personId).toSorted()).toEqual(
				[adminId, viewerId].toSorted(),
			);
			expect(await repository.removeMember(workspaceId, made.id, viewerId)).toBe("administrator");
		});

		it("lets a member of a project manage its bots, but not delete it", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, joined.id, editorId);

			expect(
				await authorizationAs(editorId).project(joined.id, "project.bots.manage"),
			).toMatchObject({
				facts: { isMember: true },
			});
			await expect(authorizationAs(editorId).project(joined.id, "project.delete")).rejects.toThrow(
				ActionForbidden,
			);
		});

		it("lists exactly the projects each role may read one by one as theirs, and other public ones to join", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			const apart = await create(adminId, { name: "Legal", slug: "legal" });
			const secret = await create(adminId, { name: "Board", slug: "board", visibility: "private" });
			await repository.addMember(workspaceId, joined.id, editorId);
			await repository.addMember(workspaceId, joined.id, viewerId);
			const people = { admin: adminId, editor: editorId, viewer: viewerId };
			const projects: Record<string, { id: string; isPublic: boolean }> = {
				"public, with the editor and viewer in it": { id: joined.id, isPublic: true },
				"public, with only the administrator in it": { id: apart.id, isPublic: true },
				"private, with only the administrator in it": { id: secret.id, isPublic: false },
			};

			for (const [role, personId] of Object.entries(people)) {
				const listed = new Map(
					(await listedTo(personId)).map(({ id, isMember }) => [id, isMember]),
				);
				for (const [project, { id, isPublic }] of Object.entries(projects)) {
					const readable = await authorizationAs(personId)
						.project(id, "project.read")
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
			const standing = await authorizationAs(editorId).project(made.id, "project.read");

			expect(seen?.permissions).toEqual(
				projectPermissions(standing.actor, { ...standing.facts, isPublic: true }),
			);
		});

		it("lets a viewer in a project read it, but not decide approvals or manage its bots", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, joined.id, viewerId);

			const standing = await authorizationAs(viewerId).project(joined.id, "project.read");

			expect(standing.may("approval.decide")).toBe(false);
			await expect(
				authorizationAs(viewerId).project(joined.id, "project.bots.manage"),
			).rejects.toThrow(ActionForbidden);
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

			await administrationAs(editorId).leave({ projectId: made.id });

			expect((await membersOf(made.id)).map(({ personId }) => personId)).toEqual([adminId]);
			await expect(administrationAs(adminId).leave({ projectId: made.id })).rejects.toThrow(
				ActionForbidden,
			);
		});

		it("keeps a demoted administrator in their projects, with an editor's permissions there", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });

			await onDatabase((db) =>
				db
					.update(membership)
					.set({ role: "editor" })
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.personId, adminId))),
			);

			const standing = await authorizationAs(adminId).project(made.id, "project.read");
			expect(standing.may("project.delete")).toBe(false);
			expect(await repository.removeMember(workspaceId, made.id, adminId)).toBe("removed");
			await expect(authorizationAs(adminId).project(made.id, "project.read")).rejects.toThrow(
				ResourceHidden,
			);
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

		it("gives nothing to somebody outside the workspace", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await expect(authorizationAs(outsiderId).project(made.id, "project.read")).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("answers no to ids that are not uuids rather than raising", async () => {
			await expect(
				authorizationAs(adminId).workspace("nonsense", "workspace.read"),
			).rejects.toThrow(ResourceHidden);
			await expect(authorizationAs(adminId).project("nonsense", "project.read")).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("refusals, decided in the administration", () => {
		it("refuses a command to somebody who may not make it, whoever called it", async () => {
			// No route and no middleware in front: this is what a new entrypoint
			// that forgot to check would reach.
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, editorId);

			await expect(administrationAs(editorId).remove({ projectId: made.id })).rejects.toThrow(
				ActionForbidden,
			);
			await expect(
				administrationAs(editorId).update({ projectId: made.id, changes: { name: "Ours" } }),
			).rejects.toThrow(ActionForbidden);
			await expect(create(viewerId, { name: "Mine", slug: "mine" })).rejects.toThrow(
				ActionForbidden,
			);
			expect(await listedTo(viewerId)).toEqual([{ id: made.id, isMember: false }]);
		});

		it("hides a project from somebody who is not in it, whatever they asked", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales", visibility: "private" });

			await expect(
				administrationAs(editorId).update({ projectId: made.id, changes: { name: "Ours" } }),
			).rejects.toThrow(ResourceHidden);
			await expect(administrationAs(outsiderId).members({ projectId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(visibleTo(outsiderId)).rejects.toThrow(ResourceHidden);
		});
	});

	describe("workspace membership lifecycle", () => {
		it("lets somebody who created a project leave the workspace, and keeps the project", async () => {
			const made = await create(editorId, { name: "Sales", slug: "sales" });

			await onDatabase((db) =>
				db
					.delete(membership)
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.personId, editorId))),
			);

			const [survivor] = await onDatabase((db) =>
				db.select().from(project).where(eq(project.id, made.id)),
			);
			expect(survivor).toMatchObject({ id: made.id });
		});
	});

	describe("lead bots", () => {
		it("makes a project with its lead among its bots, and refuses a private one", async () => {
			const made = await create(editorId, { name: "Suga", slug: "suga" });
			expect(made.leadBotId).toBe(leadId);
			expect(
				(await administrationAs(editorId).bots({ projectId: made.id })).map(({ id }) => id),
			).toEqual([leadId]);

			const diary = await aBot(editorId, "Diary", "private");
			await expect(
				administrationAs(editorId).create({
					workspace: workspaceId,
					name: "Mine",
					slug: "mine",
					leadBotId: diary.id,
				}),
			).rejects.toBeInstanceOf(ProjectStore.BotNotPublic);
			expect((await listedTo(editorId)).map(({ id }) => id)).toEqual([made.id]);
		});

		it("lets whoever may change the project choose another lead, which joins its bots", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const triage = await aBot(adminId, "Triage");

			await expect(
				administrationAs(editorId).update({
					projectId: made.id,
					changes: { leadBotId: triage.id },
				}),
			).rejects.toThrow();
			const changed = await administrationAs(adminId).update({
				projectId: made.id,
				changes: { leadBotId: triage.id },
			});

			expect(changed.leadBotId).toBe(triage.id);
			expect(
				(await administrationAs(adminId).bots({ projectId: made.id })).map(({ id }) => id),
			).toEqual([leadId, triage.id]);
		});

		it("keeps a lead in its project, public and undeleted, until another is chosen", async () => {
			const sales = await create(adminId, { name: "Sales", slug: "sales" });
			const ops = await create(adminId, { name: "Ops", slug: "ops" });
			const triage = await aBot(adminId, "Triage");

			const removing = administrationAs(adminId).removeBot({
				projectId: sales.id,
				botId: leadId,
			});
			await expect(removing).rejects.toBeInstanceOf(LeadsProjects);
			await expect(removing).rejects.toMatchObject({
				userMessage: "Lead leads Sales. Choose another lead bot for it first.",
			});
			const hiding = botsAs(adminId).update({
				botId: leadId,
				changes: { visibility: "private" },
			});
			await expect(hiding).rejects.toMatchObject({
				userMessage: "Lead leads Ops and Sales. Choose another lead bot for each first.",
			});
			await expect(botsAs(adminId).remove({ botId: leadId })).rejects.toBeInstanceOf(LeadsProjects);

			for (const projectId of [sales.id, ops.id]) {
				await administrationAs(adminId).update({ projectId, changes: { leadBotId: triage.id } });
			}
			await administrationAs(adminId).removeBot({ projectId: sales.id, botId: leadId });
			await botsAs(adminId).update({ botId: leadId, changes: { visibility: "private" } });
			expect(
				(await administrationAs(adminId).bots({ projectId: ops.id })).map(({ id }) => id),
			).toEqual([triage.id]);
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
				await administrationAs(adminId).update({ projectId, changes: { leadBotId: triage.id } });
			}

			const toCreator = {
				userMessage:
					"Triage leads Ops and private projects you aren't in. Each needs another lead bot first.",
			};
			await expect(
				botsAs(editorId).update({ botId: triage.id, changes: { visibility: "private" } }),
			).rejects.toMatchObject(toCreator);
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
			expect(
				(await administrationAs(adminId).bots({ projectId: made.id })).map(({ id }) => id),
			).toEqual([leadId, triage.id]);
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
			expect(
				(await administrationAs(adminId).bots({ projectId: made.id })).map(({ id }) => id),
			).toEqual([leadId, triage.id]);
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
			const diary = await aBot(editorId, "Diary", "private");
			const own = await defaultProjectOf(diary.id);

			expect(own).toMatchObject({ leadBotId: diary.id, workspaceId });
			expect(
				(await administrationAs(editorId).bots({ projectId: own.id })).map(({ id }) => id),
			).toEqual([diary.id]);
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
			const diary = await aBot(editorId, "Diary", "private");
			const triage = await aBot(adminId, "Triage");
			const diaryOwn = await defaultProjectOf(diary.id);
			const triageOwn = await defaultProjectOf(triage.id);

			for (const personId of [adminId, editorId, viewerId]) {
				const listed = (await listedTo(personId)).map(({ id }) => id);
				expect(listed).not.toContain(diaryOwn.id);
				expect(listed).not.toContain(triageOwn.id);
			}
			// A public bot's, by everyone in the workspace.
			for (const personId of [adminId, editorId, viewerId]) {
				await expect(
					authorizationAs(personId).project(triageOwn.id, "project.read"),
				).resolves.toMatchObject({ project: { id: triageOwn.id } });
			}
			// A private bot's, by its creator alone: an admin sees it is there, not its chats.
			await expect(
				authorizationAs(editorId).project(diaryOwn.id, "project.read"),
			).resolves.toMatchObject({ project: { id: diaryOwn.id } });
			await expect(authorizationAs(adminId).project(diaryOwn.id, "project.read")).rejects.toThrow(
				ResourceHidden,
			);
			await expect(authorizationAs(adminId).projectFound(diaryOwn.id)).resolves.toMatchObject({
				project: { id: diaryOwn.id },
			});
			await expect(
				authorizationAs(outsiderId).project(triageOwn.id, "project.read"),
			).rejects.toThrow(ResourceHidden);
		});

		it("names as the people reaching it whoever reaches its bot, though it has no members", async () => {
			const diary = await aBot(editorId, "Diary", "private");
			const triage = await aBot(adminId, "Triage");
			const peopleReaching = async (botId: string) =>
				(
					await administrationAs(editorId).peopleReaching({
						projectId: (await defaultProjectOf(botId)).id,
					})
				).map(({ name }) => name);

			expect(await peopleReaching(triage.id)).toEqual(["Ada", "Lee", "Sam"]);
			expect(await peopleReaching(diary.id)).toEqual(["Sam"]);
		});

		it("is never joined, left, staffed, changed or deleted on its own", async () => {
			const triage = await aBot(adminId, "Triage");
			const other = await aBot(adminId, "Other");
			const own = await defaultProjectOf(triage.id);
			const projectId = own.id;

			for (const personId of [adminId, editorId]) {
				const as = administrationAs(personId);
				await expect(as.join({ projectId })).rejects.toThrow(ResourceHidden);
				await expect(as.leave({ projectId })).rejects.toThrow(ActionForbidden);
				await expect(as.addMember({ projectId, personId: viewerId })).rejects.toThrow(
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

			const removing = administrationAs(adminId).remove({ projectId: made.id });
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
