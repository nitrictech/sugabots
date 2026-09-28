import { PERSONAL_POD_SLUG, type PodColor } from "@sugabots/contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import {
	agent,
	modelProvider,
	pod,
	podMember,
	providerModel,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { AgentAdministration } from "../agents/agent-administration.ts";
import { AgentRepository } from "../agents/agent-repository.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { PersonalPods } from "./personal-pods.ts";
import { PodAdministration } from "./pod-administration.ts";
import { PodRepository } from "./pod-repository.ts";

/**
 * The repository, the administration over it, and the authorisation queries
 * against real SQL.
 *
 * The joins behind `Authorization.pod`, the `reachesPod` predicate a list is
 * scoped by, and the create-plus-membership transaction are exactly the parts
 * a fake cannot check. Needs a migrated database and skips without one, as
 * `db/schema.test.ts` does; CI always has one.
 */
describe.skipIf(!process.env.DATABASE_URL)("pods, against Postgres", () => {
	let repository: Promised<PodRepository.Interface>;
	let personalPods: Promised<PersonalPods.Interface>;
	let administrationAs: (userId: string) => Promised<PodAdministration.Interface>;
	let agentsAs: (userId: string) => Promised<AgentAdministration.Interface>;
	let authorizationAs: (userId: string) => Promised<Authorization.Interface>;

	let workspaceId: string;
	let otherWorkspaceId: string;
	let adminId: string;
	let memberId: string;
	let viewerId: string;
	let outsiderId: string;

	beforeAll(async () => {
		repository = await servedOnPostgres(PodRepository.Service, PodRepository.layer);
		personalPods = await servedOnPostgres(PersonalPods.Service, PersonalPods.layer);
		administrationAs = await servedOnPostgresAs(PodAdministration.Service, PodAdministration.layer);
		agentsAs = await servedOnPostgresAs(AgentAdministration.Service, AgentAdministration.layer);
		authorizationAs = await servedOnPostgresAs(Authorization.Service, Authorization.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const create = (creatorId: string, input: { name: string; slug: string; color?: PodColor }) =>
		administrationAs(creatorId).create({ workspace: workspaceId, ...input });
	const createIn = (
		inWorkspace: string,
		creatorId: string,
		input: { name: string; slug: string },
	) => administrationAs(creatorId).create({ workspace: inWorkspace, ...input });
	const visibleTo = (userId: string, inWorkspace = workspaceId) =>
		administrationAs(userId).list({ workspace: inWorkspace });
	const ensurePersonal = (ownerId: string, model: string) =>
		administrationAs(ownerId).ensurePersonal({ workspace: workspaceId, model });
	const membersOf = (podId: string) => administrationAs(adminId).members({ podId });

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
				.insert(user)
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
		memberId = sam.id;
		outsiderId = kim.id;
		viewerId = lee.id;

		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adminId, role: "admin" },
				{ workspaceId, userId: memberId, role: "member" },
				{ workspaceId, userId: viewerId, role: "viewer" },
				{ workspaceId: otherWorkspaceId, userId: adminId, role: "admin" },
				{ workspaceId: otherWorkspaceId, userId: outsiderId, role: "member" },
			]),
		);

		// The models the cases provision Personal Assistants on.
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
				["first-model", "second-model", "test-model"].map((modelId) => ({
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
		it("puts the creator in the pod, so an admin is not locked out of it", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			expect(await visibleTo(adminId)).toEqual([made]);
			expect(await visibleTo(memberId)).toEqual([]);
		});

		it("puts no system agent in a new pod, since the workspace owns them", async () => {
			// A pod has nothing to place: the workspace's Scribe and Facilitator
			// serve every pod in it, and are set up once for all of them.
			const made = await create(adminId, { name: "Product", slug: "product" });

			const placed = await onDatabase((db) =>
				db
					.select({ key: agent.systemAgentKey })
					.from(agent)
					.where(and(eq(agent.podId, made.id), isNotNull(agent.systemAgentKey))),
			);
			expect(placed).toEqual([]);
		});

		it("refuses a slug already used in the same workspace", async () => {
			await create(adminId, { name: "Suga", slug: "suga" });

			await expect(create(adminId, { name: "Suga again", slug: "suga" })).rejects.toThrow(
				PodRepository.PodSlugTaken,
			);
		});

		it("allows the same slug in another workspace", async () => {
			await create(adminId, { name: "General", slug: "general" });

			await expect(
				createIn(otherWorkspaceId, adminId, { name: "General", slug: "general" }),
			).resolves.toMatchObject({ slug: "general" });
		});

		it("leaves nothing behind when the slug is taken", async () => {
			await create(adminId, { name: "Suga", slug: "suga" });
			await create(adminId, { name: "Sales", slug: "sales" }).catch(() => {});
			await create(adminId, { name: "Dup", slug: "suga" }).catch(() => {});

			const rows = await onDatabase((db) => db.select().from(pod));
			expect(rows.filter((row) => row.workspaceId === workspaceId)).toHaveLength(2);
		});

		it("gives a pod with no colour chosen one no other pod in the workspace has yet", async () => {
			await create(adminId, { name: "Suga", slug: "suga", color: "green" });
			await create(adminId, { name: "Sales", slug: "sales", color: "plum" });

			const made = await create(adminId, { name: "Ops", slug: "ops" });

			expect(made.color).toBe("blue");
		});
	});

	describe("membership", () => {
		it("adds, lists and removes people", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await repository.addMember(workspaceId, made.id, memberId);
			expect((await membersOf(made.id)).map((row) => row.name)).toEqual(["Ada", "Sam"]);

			expect(await repository.removeMember(workspaceId, made.id, memberId)).toBe("removed");
			expect((await membersOf(made.id)).map((row) => row.name)).toEqual(["Ada"]);
		});

		it("is idempotent, so adding twice is not an error", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await repository.addMember(workspaceId, made.id, memberId);
			await repository.addMember(workspaceId, made.id, memberId);

			expect(await membersOf(made.id)).toHaveLength(2);
		});

		it("does not add somebody from another workspace", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			expect(await repository.addMember(workspaceId, made.id, outsiderId)).toBe(
				"not_workspace_member",
			);
		});

		it("rejects a cross-workspace membership at the database boundary", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await expect(
				onDatabase((db) =>
					db.insert(podMember).values({ workspaceId, podId: made.id, userId: outsiderId }),
				),
			).rejects.toThrow();
		});

		it("revokes pod grants when a workspace member leaves and does not restore them", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await repository.addMember(workspaceId, made.id, memberId);

			await onDatabase((db) =>
				db
					.delete(workspaceMember)
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, memberId)),
					),
			);
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: memberId }),
			);

			expect(await visibleTo(memberId)).toEqual([]);
			expect((await membersOf(made.id)).map(({ userId }) => userId)).not.toContain(memberId);
			await expect(authorizationAs(memberId).pod(made.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("personal pods", () => {
		it("provisions one private pod and an assistant that keeps what its owner changes", async () => {
			const personal = await ensurePersonal(memberId, "first-model");
			const [assistant] = await onDatabase((db) =>
				db
					.select()
					.from(agent)
					.where(and(eq(agent.podId, personal.id), eq(agent.provisionedKey, "personal-assistant"))),
			);
			if (!assistant) throw new Error("Personal Assistant was not provisioned");

			expect(personal).toMatchObject({ kind: "personal", ownerId: memberId });
			expect(assistant).toMatchObject({
				name: "Personal Assistant",
				model: "first-model",
				prompt: AgentRepository.PERSONAL_ASSISTANT_PROMPT,
			});

			await onDatabase((db) =>
				db
					.update(agent)
					.set({ name: "Friday", prompt: "Keep this customization." })
					.where(eq(agent.id, assistant.id)),
			);
			await ensurePersonal(memberId, "second-model");

			const provisioned = await onDatabase((db) =>
				db
					.select()
					.from(agent)
					.where(and(eq(agent.podId, personal.id), eq(agent.provisionedKey, "personal-assistant"))),
			);
			expect(provisioned).toHaveLength(1);
			expect(provisioned[0]).toMatchObject({
				name: "Friday",
				model: "first-model",
				prompt: "Keep this customization.",
			});
		});

		it("moves an assistant to the model named when the workspace does not offer its own", async () => {
			// Provisioned without a model, as somebody joining is, so it runs on the
			// fallback, which this workspace does not offer.
			const personal = await personalPods.provision({ workspaceId, userId: memberId });

			await ensurePersonal(memberId, "second-model");

			const [assistant] = await onDatabase((db) =>
				db
					.select({ model: agent.model })
					.from(agent)
					.where(and(eq(agent.podId, personal.id), eq(agent.provisionedKey, "personal-assistant"))),
			);
			expect(assistant?.model).toBe("second-model");
		});

		it("refuses a model the workspace does not offer", async () => {
			await expect(ensurePersonal(memberId, "unknown-model")).rejects.toMatchObject({
				_tag: "ModelNotEnabled",
			});
		});

		it("is invisible to other members and workspace administrators", async () => {
			const personal = await ensurePersonal(memberId, "test-model");
			const [assistant] = await onDatabase((db) =>
				db
					.select({ id: agent.id })
					.from(agent)
					.where(and(eq(agent.podId, personal.id), eq(agent.provisionedKey, "personal-assistant"))),
			);
			if (!assistant) throw new Error("Personal Assistant was not provisioned");

			expect(await authorizationAs(memberId).pod(personal.id, "pod.delete")).toMatchObject({
				facts: { isExplicitMember: true },
			});
			await expect(authorizationAs(adminId).pod(personal.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
			await expect(authorizationAs(adminId).agent(assistant.id, "agent.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect(
				(await agentsAs(adminId).list({ workspace: workspaceId })).map(({ id }) => id),
			).not.toContain(assistant.id);
		});

		it("rejects adding another workspace member", async () => {
			const personal = await ensurePersonal(memberId, "test-model");

			expect(await repository.addMember(workspaceId, personal.id, adminId)).toBe("personal_pod");
			await expect(
				onDatabase((db) =>
					db.insert(podMember).values({ workspaceId, podId: personal.id, userId: adminId }),
				),
			).rejects.toThrow();
		});

		it("does not change its name, address or colour", async () => {
			const personal = await ensurePersonal(memberId, "test-model");

			await expect(repository.update(workspaceId, personal.id, { name: "Mine" })).rejects.toThrow(
				PodRepository.PersonalPodFixed,
			);
			await expect(repository.update(workspaceId, personal.id, { slug: "mine" })).rejects.toThrow(
				PodRepository.PersonalPodFixed,
			);
			await expect(repository.update(workspaceId, personal.id, { color: "rose" })).rejects.toThrow(
				PodRepository.PersonalPodFixed,
			);
		});
	});

	describe("renaming", () => {
		it("refuses a slug another pod in the workspace holds", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await create(adminId, { name: "Sales", slug: "sales" });

			await expect(repository.update(workspaceId, made.id, { slug: "sales" })).rejects.toThrow(
				PodRepository.PodSlugTaken,
			);
		});

		it("says the pod is gone, not that its slug is taken", async () => {
			// Renaming a pod somebody else deleted in between.
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await repository.remove(workspaceId, made.id);

			await expect(repository.update(workspaceId, made.id, { name: "Platform" })).rejects.toThrow(
				PodRepository.PodGone,
			);
		});
	});

	describe("authorisation", () => {
		it("lets a member of the workspace in, and keeps an outsider out", async () => {
			expect(await authorizationAs(adminId).workspace(workspaceId, "pod.create")).toMatchObject({
				actor: { workspaceRole: "admin" },
			});
			await expect(authorizationAs(memberId).workspace(workspaceId, "pod.create")).rejects.toThrow(
				ActionForbidden,
			);
			await expect(
				authorizationAs(outsiderId).workspace(workspaceId, "workspace.read"),
			).rejects.toThrow(ResourceHidden);
		});

		it("gives an admin every shared pod without a membership row", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.removeMember(workspaceId, made.id, adminId);

			const standing = await authorizationAs(adminId).pod(made.id, "pod.delete");

			expect(standing).toMatchObject({ facts: { isExplicitMember: false } });
			expect(standing.may("agent.delete")).toBe(true);
		});

		it("gives a member the pods they have joined, and nothing else", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			const apart = await create(adminId, { name: "Legal", slug: "legal" });
			await repository.addMember(workspaceId, joined.id, memberId);

			expect(await authorizationAs(memberId).pod(joined.id, "agent.create")).toMatchObject({
				facts: { isExplicitMember: true },
			});
			await expect(authorizationAs(memberId).pod(joined.id, "agent.delete")).rejects.toThrow(
				ActionForbidden,
			);
			await expect(authorizationAs(memberId).pod(apart.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("lists exactly the pods each role may read one by one", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			const apart = await create(adminId, { name: "Legal", slug: "legal" });
			await repository.addMember(workspaceId, joined.id, memberId);
			await repository.addMember(workspaceId, joined.id, viewerId);
			// Reached by the admin's role alone, with no membership row.
			await repository.removeMember(workspaceId, apart.id, adminId);
			const people = { admin: adminId, member: memberId, viewer: viewerId };
			const pods: Record<string, string> = {
				"shared, with the member and viewer in it": joined.id,
				"shared, with nobody in it": apart.id,
			};
			for (const [role, userId] of Object.entries(people)) {
				pods[`${role}'s Personal pod`] = (await ensurePersonal(userId, "test-model")).id;
			}

			for (const [role, userId] of Object.entries(people)) {
				const listed = new Set((await visibleTo(userId)).map(({ id }) => id));
				for (const [pod, podId] of Object.entries(pods)) {
					const readable = await authorizationAs(userId)
						.pod(podId, "pod.read")
						.then(() => true)
						.catch((refusal) =>
							refusal instanceof ResourceHidden ? false : Promise.reject(refusal),
						);
					expect({ role, pod, listed: listed.has(podId) }).toEqual({ role, pod, listed: readable });
				}
			}
			expect((await visibleTo(adminId)).map(({ id }) => id)).toEqual(
				expect.arrayContaining([joined.id, apart.id]),
			);
		});

		it("carries the resolved permissions on each pod it lists", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, memberId);

			const [seen] = (await visibleTo(memberId)).filter(({ id }) => id === made.id);

			expect(seen?.permissions).toMatchObject({
				createAgents: true,
				updateAgents: true,
				deleteAgents: false,
				manageConnections: false,
			});
		});

		it("gives a viewer the pods they have joined, to read and take part in", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			const apart = await create(adminId, { name: "Legal", slug: "legal" });
			await repository.addMember(workspaceId, joined.id, viewerId);

			const standing = await authorizationAs(viewerId).pod(joined.id, "pod.read");

			expect(standing.may("routine.read")).toBe(true);
			expect(standing.may("agent.update")).toBe(false);
			await expect(authorizationAs(viewerId).pod(joined.id, "agent.create")).rejects.toThrow(
				ActionForbidden,
			);
			await expect(authorizationAs(viewerId).pod(apart.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect((await visibleTo(viewerId)).map(({ id }) => id)).toEqual([joined.id]);
		});

		it("carries a viewer's permissions on the pods it lists, all of them closed", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, joined.id, viewerId);

			const [seen] = await visibleTo(viewerId);

			expect(Object.values(seen?.permissions ?? {})).not.toContain(true);
		});

		it("leaves a viewer in charge of their own Personal pod", async () => {
			const personal = await ensurePersonal(viewerId, "test-model");

			expect(personal.permissions).toMatchObject({
				createAgents: true,
				manageConnections: true,
				manageRoutines: true,
			});
		});

		it("stops reaching a shared pod once somebody is demoted", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.removeMember(workspaceId, made.id, adminId);
			expect(await authorizationAs(adminId).pod(made.id, "pod.read")).toBeDefined();

			await onDatabase((db) =>
				db
					.update(workspaceMember)
					.set({ role: "member" })
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, adminId)),
					),
			);

			await expect(authorizationAs(adminId).pod(made.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect(await visibleTo(adminId)).toEqual([]);
		});

		it("does not carry an administrator's reach into another workspace", async () => {
			// Ada administers both, so the only thing keeping her out of the other
			// one's pods would be the id — which is exactly what must not be true.
			const here = await create(adminId, { name: "Sales", slug: "sales" });
			const there = await createIn(otherWorkspaceId, adminId, {
				name: "Sales",
				slug: "sales",
			});

			expect(await visibleTo(adminId)).toEqual([expect.objectContaining({ id: here.id })]);
			await expect(authorizationAs(outsiderId).pod(here.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect((await visibleTo(outsiderId, otherWorkspaceId)).length).toBe(0);
			expect(there.workspaceId).toBe(otherWorkspaceId);
		});

		it("gives nothing to somebody outside the workspace", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await expect(authorizationAs(outsiderId).pod(made.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("answers no to ids that are not uuids rather than raising", async () => {
			await expect(
				authorizationAs(adminId).workspace("nonsense", "workspace.read"),
			).rejects.toThrow(ResourceHidden);
			await expect(authorizationAs(adminId).pod("nonsense", "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("refusals, decided in the administration", () => {
		it("refuses a command to somebody who may not make it, whoever called it", async () => {
			// No route and no middleware in front: this is what a new entry point
			// that forgot to check would reach.
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, memberId);

			await expect(administrationAs(memberId).remove({ podId: made.id })).rejects.toThrow(
				ActionForbidden,
			);
			await expect(
				administrationAs(memberId).addMember({ podId: made.id, userId: viewerId }),
			).rejects.toThrow(ActionForbidden);
			await expect(create(memberId, { name: "Mine", slug: "mine" })).rejects.toThrow(
				ActionForbidden,
			);
			expect((await membersOf(made.id)).map(({ userId }) => userId)).not.toContain(viewerId);
		});

		it("hides a pod from somebody who does not reach it, whatever they asked", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });

			await expect(
				administrationAs(memberId).update({ podId: made.id, changes: { name: "Ours" } }),
			).rejects.toThrow(ResourceHidden);
			await expect(administrationAs(outsiderId).members({ podId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(visibleTo(outsiderId)).rejects.toThrow(ResourceHidden);
		});
	});

	describe("workspace membership lifecycle", () => {
		it("lets somebody who created a shared pod leave the workspace", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await ensurePersonal(adminId, "test-model");

			// What better-auth's beforeRemoveMember hook does, then the removal.
			await onDatabase((db) =>
				db
					.delete(pod)
					.where(
						and(
							eq(pod.workspaceId, workspaceId),
							eq(pod.ownerId, adminId),
							eq(pod.kind, "personal"),
						),
					),
			);
			await onDatabase((db) =>
				db
					.delete(workspaceMember)
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, adminId)),
					),
			);

			const [survivor] = await onDatabase((db) => db.select().from(pod).where(eq(pod.id, made.id)));
			expect(survivor).toMatchObject({ ownerId: null });
		});

		it("refuses a Personal pod with no owner", async () => {
			await expect(
				onDatabase((db) =>
					db.insert(pod).values({
						workspaceId,
						kind: "personal",
						name: "Personal",
						// The slug a Personal pod must have, so the missing owner is the
						// only thing wrong with this row.
						slug: PERSONAL_POD_SLUG,
					}),
				),
			).rejects.toThrow();
		});
	});

	describe("routing through the Facilitator", () => {
		it("refuses while the workspace has chosen no model for it", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await placeFacilitator(null);

			await expect(
				administrationAs(adminId).update({
					podId: made.id,
					changes: { routing: { facilitator: true } },
				}),
			).rejects.toThrow(PodAdministration.FacilitatorNotSetUp);
		});

		it("allows it once a model has been chosen", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await placeFacilitator("test-model");

			const updated = await administrationAs(adminId).update({
				podId: made.id,
				changes: { routing: { facilitator: true } },
			});

			expect(updated.routing).toEqual({ facilitator: true });
		});

		it("still lets a pod switch routing off when there is no model", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await placeFacilitator(null);

			const updated = await administrationAs(adminId).update({
				podId: made.id,
				changes: { routing: { facilitator: false } },
			});

			expect(updated.routing).toEqual({ facilitator: false });
		});

		/** The workspace's Facilitator, set up or not. */
		async function placeFacilitator(model: string | null) {
			await onDatabase((db) =>
				db.insert(agent).values({
					workspaceId,
					podId: null,
					name: "Facilitator",
					handle: "facilitator",
					systemAgentKey: "facilitate",
					color: "teal",
					face: "pill",
					model,
				}),
			);
		}
	});
});
