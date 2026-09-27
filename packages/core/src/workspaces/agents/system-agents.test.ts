import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agent, pod, user, workspace } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { AgentAdministration } from "./agent-administration.ts";
import { AgentRepository } from "./agent-repository.ts";

describe.skipIf(!process.env.DATABASE_URL)("the workspace's system agents", () => {
	let agents: Promised<AgentRepository.Interface>;
	let administration: Promised<AgentAdministration.Interface>;
	let workspaceId: string;
	let otherWorkspaceId: string;
	let creatorId: string;

	beforeAll(async () => {
		agents = await servedOnPostgres(AgentRepository.Service, AgentRepository.layer);
		administration = await servedOnPostgres(AgentAdministration.Service, AgentAdministration.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const made = await onDatabase((db) =>
			db
				.insert(workspace)
				.values([
					{ name: `Test ${stamp}`, slug: `system-${stamp}` },
					{ name: `Other ${stamp}`, slug: `system-other-${stamp}` },
				])
				.returning(),
		);
		const [space, other] = made;
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!space || !other || !person) throw new Error("could not create the fixtures");
		workspaceId = space.id;
		otherWorkspaceId = other.id;
		creatorId = person.id;
	});

	const placed = () =>
		onDatabase((db) =>
			db
				.select({ key: agent.systemAgentKey, podId: agent.podId, model: agent.model })
				.from(agent)
				.where(eq(agent.workspaceId, workspaceId))
				.orderBy(agent.name),
		);

	it("gives a workspace one of each, in no pod and with no model", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });

		expect(await placed()).toEqual([
			{ key: "facilitate", podId: null, model: null },
			{ key: "summarise", podId: null, model: null },
		]);
	});

	it("creates nothing more when run again", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });

		expect(await placed()).toHaveLength(2);
	});

	it("does not put a chosen model back to unset when run again", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });
		await agents.setSystemAgentModel(workspaceId, "summarise", "chosen-model");

		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });

		const [scribe] = await onDatabase((db) =>
			db
				.select({ model: agent.model })
				.from(agent)
				.where(and(eq(agent.workspaceId, workspaceId), eq(agent.systemAgentKey, "summarise"))),
		);
		expect(scribe?.model).toBe("chosen-model");
	});

	it("gives each workspace its own pair", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });
		await agents.ensureSystemAgents({ workspaceId: otherWorkspaceId, createdById: creatorId });
		await agents.setSystemAgentModel(workspaceId, "facilitate", "one-workspace-only");

		const listed = await administration.systemAgents(otherWorkspaceId);
		expect(listed.map(({ key, model }) => ({ key, model }))).toEqual([
			{ key: "summarise", model: null },
			{ key: "facilitate", model: null },
		]);
	});

	it("reports a workspace with no rows as one that is not set up", async () => {
		const listed = await administration.systemAgents(workspaceId);

		expect(listed.map(({ key, model }) => ({ key, model }))).toEqual([
			{ key: "summarise", model: null },
			{ key: "facilitate", model: null },
		]);
	});

	it("turns one off by taking its model away", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });
		await agents.setSystemAgentModel(workspaceId, "summarise", "chosen-model");

		const turnedOff = await administration.setSystemAgentModel({
			workspaceId,
			key: "summarise",
			model: null,
		});

		expect(turnedOff.model).toBeNull();
	});

	it("stops every pod routing through the Facilitator when it is turned off", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });
		await agents.setSystemAgentModel(workspaceId, "facilitate", "chosen-model");
		const routed = await placePod("routed", { facilitator: true });
		const quiet = await placePod("quiet", { facilitator: false });

		await administration.setSystemAgentModel({ workspaceId, key: "facilitate", model: null });

		const after = await onDatabase((db) =>
			db
				.select({ slug: pod.slug, routing: pod.routing })
				.from(pod)
				.where(eq(pod.workspaceId, workspaceId))
				.orderBy(pod.slug),
		);
		expect(after).toEqual([
			{ slug: quiet.slug, routing: { facilitator: false } },
			{ slug: routed.slug, routing: { facilitator: false } },
		]);
	});

	it("leaves pod routing alone when the Scribe is turned off", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });
		await agents.setSystemAgentModel(workspaceId, "summarise", "chosen-model");
		await agents.setSystemAgentModel(workspaceId, "facilitate", "chosen-model");
		const routed = await placePod("routed", { facilitator: true });

		await administration.setSystemAgentModel({ workspaceId, key: "summarise", model: null });

		const [after] = await onDatabase((db) =>
			db.select({ routing: pod.routing }).from(pod).where(eq(pod.id, routed.id)),
		);
		expect(after?.routing).toEqual({ facilitator: true });
	});

	async function placePod(slug: string, routing: { facilitator: boolean }) {
		const [made] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					kind: "shared",
					name: slug,
					slug: `${slug}-${crypto.randomUUID()}`,
					routing,
				})
				.returning(),
		);
		if (!made) throw new Error("could not create the pod");
		return made;
	}

	it("refuses a second Scribe in the same workspace", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });

		await expect(
			onDatabase((db) =>
				db.insert(agent).values({
					workspaceId,
					podId: null,
					name: "Second Scribe",
					handle: "second-scribe",
					systemAgentKey: "summarise",
					color: "orange",
					face: "arc",
					model: null,
				}),
			),
		).rejects.toThrow();
	});
});
