import { PERSONAL_POD_SLUG, type WorkspaceRole } from "@sugabots/contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { agent, pod, podMember, user, workspace, workspaceMember } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres } from "../../database/testing.ts";
import {
	ActionForbidden,
	authorization as databaseAuthorization,
	ResourceHidden,
} from "../access.ts";
import { agentStore } from "../agents/store.ts";
import {
	FacilitatorNotSetUp,
	PERSONAL_ASSISTANT_PROMPT,
	PersonalPodFixed,
	PodGone,
	podStore,
	SlugTaken,
} from "./store.ts";

/**
 * The store and the authorisation queries against real SQL.
 *
 * The route tests run the real policy over stated facts, which proves the
 * rules but not the queries — the joins behind `authorization.pod`, the
 * `reachesPod` predicate a list is scoped by, and the create-plus-membership
 * transaction are exactly the parts a fake cannot check. Needs a migrated
 * database and skips without one, as `db/schema.test.ts` does; CI always has
 * one.
 */
describe.skipIf(!process.env.DATABASE_URL)("pods, against Postgres", () => {
	const store = onPostgres(podStore);
	const agents = onPostgres(agentStore);
	const authorization = onPostgres(databaseAuthorization);

	let workspaceId: string;
	let otherWorkspaceId: string;
	let adminId: string;
	let memberId: string;
	let viewerId: string;
	let outsiderId: string;

	const actor = (userId: string, workspaceRole: WorkspaceRole) => ({ userId, workspaceRole });
	const asAdmin = () => actor(adminId, "admin");
	const asMember = () => actor(memberId, "member");

	afterAll(async () => {
		await closeDatabase();
	});

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
	});

	describe("creating", () => {
		it("puts the creator in the pod, so an admin is not locked out of it", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });

			expect(await store.listVisible(workspaceId, asAdmin())).toEqual([made]);
			expect(await store.listVisible(workspaceId, asMember())).toEqual([]);
		});

		it("puts no system agent in a new pod, since the workspace owns them", async () => {
			// A pod has nothing to place: the workspace's Scribe and Facilitator
			// serve every pod in it, and are set up once for all of them.
			const made = await store.create(workspaceId, asAdmin(), { name: "Product", slug: "product" });

			const placed = await onDatabase((db) =>
				db
					.select({ key: agent.systemAgentKey })
					.from(agent)
					.where(and(eq(agent.podId, made.id), isNotNull(agent.systemAgentKey))),
			);
			expect(placed).toEqual([]);
		});

		it("refuses a slug already used in the same workspace", async () => {
			await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });

			await expect(
				store.create(workspaceId, asAdmin(), { name: "Suga again", slug: "suga" }),
			).rejects.toThrow(SlugTaken);
		});

		it("allows the same slug in another workspace", async () => {
			await store.create(workspaceId, asAdmin(), { name: "General", slug: "general" });

			await expect(
				store.create(otherWorkspaceId, asAdmin(), { name: "General", slug: "general" }),
			).resolves.toMatchObject({ slug: "general" });
		});

		it("leaves nothing behind when the slug is taken", async () => {
			await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });
			await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" }).catch(() => {});
			await store.create(workspaceId, asAdmin(), { name: "Dup", slug: "suga" }).catch(() => {});

			const rows = await onDatabase((db) => db.select().from(pod));
			expect(rows.filter((row) => row.workspaceId === workspaceId)).toHaveLength(2);
		});

		it("gives a pod with no colour chosen one no other pod in the workspace has yet", async () => {
			await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga", color: "green" });
			await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales", color: "plum" });

			const made = await store.create(workspaceId, asAdmin(), { name: "Ops", slug: "ops" });

			expect(made.color).toBe("blue");
		});
	});

	describe("membership", () => {
		it("adds, lists and removes people", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });

			await store.addMember(workspaceId, made.id, memberId);
			expect((await store.listMembers(made.id)).map((row) => row.name)).toEqual(["Ada", "Sam"]);

			expect(await store.removeMember(workspaceId, made.id, memberId)).toBe("removed");
			expect((await store.listMembers(made.id)).map((row) => row.name)).toEqual(["Ada"]);
		});

		it("is idempotent, so adding twice is not an error", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });

			await store.addMember(workspaceId, made.id, memberId);
			await store.addMember(workspaceId, made.id, memberId);

			expect(await store.listMembers(made.id)).toHaveLength(2);
		});

		it("does not add somebody from another workspace", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });

			expect(await store.addMember(workspaceId, made.id, outsiderId)).toBe("not_workspace_member");
		});

		it("rejects a cross-workspace membership at the database boundary", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });

			await expect(
				onDatabase((db) =>
					db.insert(podMember).values({ workspaceId, podId: made.id, userId: outsiderId }),
				),
			).rejects.toThrow();
		});

		it("revokes pod grants when a workspace member leaves and does not restore them", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });
			await store.addMember(workspaceId, made.id, memberId);

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

			expect(await store.listVisible(workspaceId, asMember())).toEqual([]);
			expect((await store.listMembers(made.id)).map(({ userId }) => userId)).not.toContain(
				memberId,
			);
			await expect(authorization.pod(memberId, made.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("personal pods", () => {
		it("provisions one private pod and a customizable default assistant", async () => {
			const personal = await store.ensurePersonal(workspaceId, asMember(), "first-model");
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
				prompt: PERSONAL_ASSISTANT_PROMPT,
			});

			await onDatabase((db) =>
				db
					.update(agent)
					.set({ name: "Friday", prompt: "Keep this customization." })
					.where(eq(agent.id, assistant.id)),
			);
			await store.ensurePersonal(workspaceId, asMember(), "second-model");

			const provisioned = await onDatabase((db) =>
				db
					.select()
					.from(agent)
					.where(and(eq(agent.podId, personal.id), eq(agent.provisionedKey, "personal-assistant"))),
			);
			expect(provisioned).toHaveLength(1);
			expect(provisioned[0]).toMatchObject({
				name: "Friday",
				model: "second-model",
				prompt: "Keep this customization.",
			});
		});

		it("is invisible to other members and workspace administrators", async () => {
			const personal = await store.ensurePersonal(workspaceId, asMember(), "test-model");
			const [assistant] = await onDatabase((db) =>
				db
					.select({ id: agent.id })
					.from(agent)
					.where(and(eq(agent.podId, personal.id), eq(agent.provisionedKey, "personal-assistant"))),
			);
			if (!assistant) throw new Error("Personal Assistant was not provisioned");

			expect(await authorization.pod(memberId, personal.id, "pod.delete")).toMatchObject({
				facts: { isMember: true },
			});
			await expect(authorization.pod(adminId, personal.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
			await expect(authorization.agent(adminId, assistant.id, "agent.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect((await agents.listVisible(workspaceId, adminId)).map(({ id }) => id)).not.toContain(
				assistant.id,
			);
		});

		it("rejects adding another workspace member", async () => {
			const personal = await store.ensurePersonal(workspaceId, asMember(), "test-model");

			expect(await store.addMember(workspaceId, personal.id, adminId)).toBe("personal_pod");
			await expect(
				onDatabase((db) =>
					db.insert(podMember).values({ workspaceId, podId: personal.id, userId: adminId }),
				),
			).rejects.toThrow();
		});

		it("does not change its name, address or colour", async () => {
			const personal = await store.ensurePersonal(workspaceId, asMember(), "test-model");

			await expect(store.update(workspaceId, personal.id, { name: "Mine" })).rejects.toThrow(
				PersonalPodFixed,
			);
			await expect(store.update(workspaceId, personal.id, { slug: "mine" })).rejects.toThrow(
				PersonalPodFixed,
			);
			await expect(store.update(workspaceId, personal.id, { color: "rose" })).rejects.toThrow(
				PersonalPodFixed,
			);
		});
	});

	describe("renaming", () => {
		it("refuses a slug another pod in the workspace holds", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });
			await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });

			await expect(store.update(workspaceId, made.id, { slug: "sales" })).rejects.toThrow(
				SlugTaken,
			);
		});

		it("says the pod is gone, not that its slug is taken", async () => {
			// Renaming a pod somebody else deleted in between. This used to
			// raise SlugTaken with an empty slug, so the route answered 409
			// about a conflict that had not happened.
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });
			await store.remove(workspaceId, made.id);

			await expect(store.update(workspaceId, made.id, { name: "Platform" })).rejects.toThrow(
				PodGone,
			);
		});
	});

	describe("authorisation", () => {
		it("lets a member of the workspace in, and keeps an outsider out", async () => {
			expect(await authorization.workspace(adminId, workspaceId, "pod.create")).toMatchObject({
				actor: { workspaceRole: "admin" },
			});
			await expect(authorization.workspace(memberId, workspaceId, "pod.create")).rejects.toThrow(
				ActionForbidden,
			);
			await expect(
				authorization.workspace(outsiderId, workspaceId, "workspace.read"),
			).rejects.toThrow(ResourceHidden);
		});

		it("puts every administrator in a new shared pod, and keeps them there", async () => {
			await onDatabase((db) =>
				db
					.update(workspaceMember)
					.set({ role: "admin" })
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, viewerId)),
					),
			);

			const made = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });

			expect((await store.listMembers(made.id)).map(({ userId }) => userId).toSorted()).toEqual(
				[adminId, viewerId].toSorted(),
			);
			expect(await store.removeMember(workspaceId, made.id, viewerId)).toBe("administrator");
			expect(await authorization.pod(viewerId, made.id, "pod.delete")).toMatchObject({
				facts: { isMember: true },
			});
		});

		it("refuses an administrator leaving a shared pod", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });
			await store.addMember(workspaceId, made.id, memberId);

			await expect(authorization.pod(adminId, made.id, "pod.leave")).rejects.toThrow(
				ActionForbidden,
			);
			expect(await authorization.pod(memberId, made.id, "pod.leave")).toBeDefined();
		});

		it("gives a member the pods they have joined, and nothing else", async () => {
			const joined = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });
			const apart = await store.create(workspaceId, asAdmin(), { name: "Legal", slug: "legal" });
			await store.addMember(workspaceId, joined.id, memberId);

			expect(await authorization.pod(memberId, joined.id, "agent.create")).toMatchObject({
				facts: { isMember: true },
			});
			await expect(authorization.pod(memberId, joined.id, "agent.delete")).rejects.toThrow(
				ActionForbidden,
			);
			await expect(authorization.pod(memberId, apart.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("agrees with what a list shows", async () => {
			const joined = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });
			const apart = await store.create(workspaceId, asAdmin(), { name: "Legal", slug: "legal" });
			await store.addMember(workspaceId, joined.id, memberId);
			const personal = await store.ensurePersonal(workspaceId, asMember(), "test-model");

			const forAdmin = (await store.listVisible(workspaceId, asAdmin())).map(({ id }) => id);
			const forMember = (await store.listVisible(workspaceId, asMember())).map(({ id }) => id);

			expect(forAdmin).toEqual(expect.arrayContaining([joined.id, apart.id]));
			expect(forAdmin).not.toContain(personal.id);
			expect(forMember.toSorted()).toEqual([joined.id, personal.id].toSorted());
		});

		it("carries the resolved permissions on each pod it lists", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });
			await store.addMember(workspaceId, made.id, memberId);

			const [seen] = (await store.listVisible(workspaceId, asMember())).filter(
				({ id }) => id === made.id,
			);

			expect(seen?.permissions).toMatchObject({
				createAgents: true,
				updateAgents: true,
				deleteAgents: false,
				manageConnections: false,
			});
		});

		it("gives a viewer the pods they have joined, to read and take part in", async () => {
			const joined = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });
			const apart = await store.create(workspaceId, asAdmin(), { name: "Legal", slug: "legal" });
			await store.addMember(workspaceId, joined.id, viewerId);

			const standing = await authorization.pod(viewerId, joined.id, "pod.read");

			expect(standing.may("routine.read")).toBe(true);
			expect(standing.may("agent.update")).toBe(false);
			await expect(authorization.pod(viewerId, joined.id, "agent.create")).rejects.toThrow(
				ActionForbidden,
			);
			await expect(authorization.pod(viewerId, apart.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect(
				(await store.listVisible(workspaceId, actor(viewerId, "viewer"))).map(({ id }) => id),
			).toEqual([joined.id]);
		});

		it("carries a viewer's permissions on the pods it lists, all closed but leaving", async () => {
			const joined = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });
			await store.addMember(workspaceId, joined.id, viewerId);

			const [seen] = await store.listVisible(workspaceId, actor(viewerId, "viewer"));
			const { leave, ...others } = seen?.permissions ?? { leave: false };

			expect(leave).toBe(true);
			expect(Object.values(others)).not.toContain(true);
		});

		it("leaves a viewer in charge of their own Personal pod", async () => {
			const personal = await store.ensurePersonal(
				workspaceId,
				actor(viewerId, "viewer"),
				"test-model",
			);

			expect(personal.permissions).toMatchObject({
				createAgents: true,
				manageConnections: true,
				manageRoutines: true,
			});
		});

		it("keeps a demoted administrator in their pods, with a member's permissions there", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });

			await onDatabase((db) =>
				db
					.update(workspaceMember)
					.set({ role: "member" })
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, adminId)),
					),
			);

			const standing = await authorization.pod(adminId, made.id, "pod.read");
			expect(standing.may("pod.delete")).toBe(false);
			expect(await store.removeMember(workspaceId, made.id, adminId)).toBe("removed");
			await expect(authorization.pod(adminId, made.id, "pod.read")).rejects.toThrow(ResourceHidden);
		});

		it("does not carry an administrator's reach into another workspace", async () => {
			// Ada administers both, so the only thing keeping her out of the other
			// one's pods would be the id — which is exactly what must not be true.
			const here = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });
			const there = await store.create(otherWorkspaceId, asAdmin(), {
				name: "Sales",
				slug: "sales",
			});

			expect(await store.listVisible(workspaceId, asAdmin())).toEqual([
				expect.objectContaining({ id: here.id }),
			]);
			await expect(authorization.pod(outsiderId, here.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect((await store.listVisible(otherWorkspaceId, actor(outsiderId, "member"))).length).toBe(
				0,
			);
			expect(there.workspaceId).toBe(otherWorkspaceId);
		});

		it("gives nothing to somebody outside the workspace", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });

			await expect(authorization.pod(outsiderId, made.id, "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("answers no to ids that are not uuids rather than raising", async () => {
			await expect(authorization.workspace(adminId, "nonsense", "workspace.read")).rejects.toThrow(
				ResourceHidden,
			);
			await expect(authorization.pod(adminId, "nonsense", "pod.read")).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("workspace membership lifecycle", () => {
		it("lets somebody who created a shared pod leave the workspace", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Sales", slug: "sales" });
			await store.ensurePersonal(workspaceId, asAdmin(), "test-model");

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
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });
			await placeFacilitator(null);

			await expect(
				store.update(workspaceId, made.id, { routing: { facilitator: true } }),
			).rejects.toThrow(FacilitatorNotSetUp);
		});

		it("allows it once a model has been chosen", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });
			await placeFacilitator("test-model");

			const updated = await store.update(workspaceId, made.id, { routing: { facilitator: true } });

			expect(updated.routing).toEqual({ facilitator: true });
		});

		it("still lets a pod switch routing off when there is no model", async () => {
			const made = await store.create(workspaceId, asAdmin(), { name: "Suga", slug: "suga" });
			await placeFacilitator(null);

			const updated = await store.update(workspaceId, made.id, { routing: { facilitator: false } });

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
