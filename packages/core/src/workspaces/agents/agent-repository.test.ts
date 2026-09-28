import type { NewAgent } from "@sugabots/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agent, pod, podMember, user, workspace, workspaceMember } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { AgentAdministration } from "./agent-administration.ts";
import { AgentRepository } from "./agent-repository.ts";

describe.skipIf(!process.env.DATABASE_URL)("agents, against Postgres", () => {
	let repository: Promised<AgentRepository.Interface>;
	let administrationAs: (userId: string) => Promised<AgentAdministration.Interface>;
	let workspaceId: string;
	let adminId: string;
	let memberId: string;
	let podId: string;

	beforeAll(async () => {
		repository = await servedOnPostgres(AgentRepository.Service, AgentRepository.layer);
		administrationAs = await servedOnPostgresAs(
			AgentAdministration.Service,
			AgentAdministration.layer,
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const create = (createdById: string, input: NewAgent) =>
		repository.create(workspaceId, { createdById, agent: input });
	const visibleTo = (userId: string) => administrationAs(userId).list({ workspace: workspaceId });

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db.insert(workspace).values({ name: stamp, slug: stamp }).returning(),
		);
		if (!space) throw new Error("workspace setup failed");
		workspaceId = space.id;
		const [admin, member] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `ada-${stamp}@example.com` },
					{ name: "Sam", email: `sam-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!admin || !member) throw new Error("user setup failed");
		adminId = admin.id;
		memberId = member.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adminId, role: "admin" },
				{ workspaceId, userId: memberId, role: "member" },
			]),
		);
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					kind: "shared",
					name: "Support",
					slug: "support",
					createdById: adminId,
				})
				.returning(),
		);
		if (!room) throw new Error("pod setup failed");
		podId = room.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId: memberId }));
	});

	it("creates an agent in exactly one pod and scopes member visibility to that pod", async () => {
		const made = await create(adminId, {
			podId,
			name: "Triage",
			model: "gpt-4o-mini",
		});
		expect(made.podId).toBe(podId);
		expect((await visibleTo(memberId)).map(({ id }) => id)).toEqual([made.id]);
	});

	it("rejects a pod from another workspace", async () => {
		const [other] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Other", slug: `other-${Date.now()}` })
				.returning(),
		);
		if (!other) throw new Error("foreign workspace setup failed");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({
				workspaceId: other.id,
				userId: adminId,
				role: "admin",
			}),
		);
		const [foreign] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: other.id,
					kind: "shared",
					name: "Other",
					slug: "other",
				})
				.returning(),
		);
		if (!foreign) throw new Error("foreign pod setup failed");
		await expect(
			create(adminId, { podId: foreign.id, name: "Nope", model: "model" }),
		).rejects.toBeInstanceOf(AgentRepository.PodOutsideWorkspace);
	});

	it("refuses a name another agent in the pod has", async () => {
		await create(adminId, { podId, name: "Triage", model: "model" });
		await expect(create(adminId, { podId, name: "Triage", model: "model" })).rejects.toMatchObject({
			_tag: "AgentNameTaken",
			field: "name",
		});
	});

	it("refuses a handle another agent in the pod has, as a clash rather than a fault", async () => {
		await create(adminId, { podId, name: "Triage", model: "model" });

		await expect(
			create(adminId, { podId, name: "Sorter", handle: "triage", model: "model" }),
		).rejects.toMatchObject({ _tag: "AgentNameTaken", field: "handle" });
	});

	it("says which name a renaming clashes on", async () => {
		await create(adminId, { podId, name: "Triage", model: "model" });
		const other = await create(adminId, { podId, name: "Sorter", model: "model" });

		await expect(
			repository.update(workspaceId, other.id, { name: "Triage" }),
		).rejects.toMatchObject({
			_tag: "AgentNameTaken",
			field: "name",
			value: "Triage",
		});
	});

	it("lets a crew agent's model be cleared, which stops it rather than breaking it", async () => {
		const made = await create(adminId, {
			podId,
			name: "Clearable",
			model: "model",
		});

		const cleared = await repository.update(workspaceId, made.id, { model: null });

		expect(cleared.model).toBeNull();
		// Still a crew agent in its pod, still listed: it simply cannot take a turn.
		const visible = await visibleTo(adminId);
		expect(visible.map((one) => one.name)).toContain("Clearable");
	});

	it("does not individually delete a system agent", async () => {
		const system = await placeScribe();
		await expect(repository.remove(workspaceId, system.id)).rejects.toBeInstanceOf(
			AgentRepository.SystemAgentImmutable,
		);
	});

	it("does not change a system agent as a crew agent", async () => {
		const system = await placeScribe();
		await expect(
			repository.update(workspaceId, system.id, { model: "another" }),
		).rejects.toBeInstanceOf(AgentRepository.SystemAgentImmutable);
	});

	it("leaves system agents out of the roster, since they are in no pod", async () => {
		await placeScribe();
		await create(adminId, { podId, name: "Crew", model: "model" });
		const visible = await visibleTo(adminId);
		expect(visible.map((one) => one.name)).not.toContain("Scribe");
		expect(visible.map((one) => one.name)).toContain("Crew");
	});

	/** The workspace's Scribe: no pod, and no model until somebody chooses one. */
	async function placeScribe() {
		const [system] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: null,
					name: "Scribe",
					handle: "scribe",
					systemAgentKey: "summarise",
					color: "orange",
					face: "arc",
					model: null,
				})
				.returning(),
		);
		if (!system) throw new Error("system agent setup failed");
		return system;
	}
});
