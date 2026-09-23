import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getDb } from "../../database/client.ts";
import { agent, pod, user, workspace } from "../../database/schema.ts";
import { closeDatabase, onPostgres } from "../../database/testing.ts";
import { systemAgentStore } from "./system-agent-store.ts";
import { ensureSystemAgents } from "./system-agents.ts";

describe.skipIf(!process.env.DATABASE_URL)("the workspace's system agents", () => {
	const db = getDb();
	const store = onPostgres(systemAgentStore);
	let workspaceId: string;
	let otherWorkspaceId: string;
	let creatorId: string;

	afterAll(async () => {
		await closeDatabase();
		await closePool();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const made = await db
			.insert(workspace)
			.values([
				{ name: `Test ${stamp}`, slug: `system-${stamp}` },
				{ name: `Other ${stamp}`, slug: `system-other-${stamp}` },
			])
			.returning();
		const [space, other] = made;
		const [person] = await db
			.insert(user)
			.values({ name: "Ada", email: `ada-${stamp}@example.com` })
			.returning();
		if (!space || !other || !person) throw new Error("could not create the fixtures");
		workspaceId = space.id;
		otherWorkspaceId = other.id;
		creatorId = person.id;
	});

	const placed = () =>
		db
			.select({ key: agent.systemAgentKey, podId: agent.podId, model: agent.model })
			.from(agent)
			.where(eq(agent.workspaceId, workspaceId))
			.orderBy(agent.name);

	it("gives a workspace one of each, in no pod and with no model", async () => {
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));

		expect(await placed()).toEqual([
			{ key: "facilitate", podId: null, model: null },
			{ key: "summarise", podId: null, model: null },
		]);
	});

	it("creates nothing more when run again", async () => {
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));

		expect(await placed()).toHaveLength(2);
	});

	it("does not put a chosen model back to unset when run again", async () => {
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));
		await store.setModel(workspaceId, "summarise", "chosen-model");

		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));

		const [scribe] = await db
			.select({ model: agent.model })
			.from(agent)
			.where(and(eq(agent.workspaceId, workspaceId), eq(agent.systemAgentKey, "summarise")));
		expect(scribe?.model).toBe("chosen-model");
	});

	it("gives each workspace its own pair", async () => {
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));
		await db.transaction((tx) =>
			ensureSystemAgents(tx, { workspaceId: otherWorkspaceId, createdById: creatorId }),
		);
		await store.setModel(workspaceId, "facilitate", "one-workspace-only");

		const listed = await store.list(otherWorkspaceId);
		expect(listed.map(({ key, model }) => ({ key, model }))).toEqual([
			{ key: "summarise", model: null },
			{ key: "facilitate", model: null },
		]);
	});

	it("reports a workspace with no rows as one that is not set up", async () => {
		const listed = await store.list(workspaceId);

		expect(listed.map(({ key, model }) => ({ key, model }))).toEqual([
			{ key: "summarise", model: null },
			{ key: "facilitate", model: null },
		]);
	});

	it("turns one off by taking its model away", async () => {
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));
		await store.setModel(workspaceId, "summarise", "chosen-model");

		const turnedOff = await store.setModel(workspaceId, "summarise", null);

		expect(turnedOff.model).toBeNull();
	});

	it("stops every pod routing through the Facilitator when it is turned off", async () => {
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));
		await store.setModel(workspaceId, "facilitate", "chosen-model");
		const routed = await placePod("routed", { facilitator: true });
		const quiet = await placePod("quiet", { facilitator: false });

		await store.setModel(workspaceId, "facilitate", null);

		const after = await db
			.select({ slug: pod.slug, routing: pod.routing })
			.from(pod)
			.where(eq(pod.workspaceId, workspaceId))
			.orderBy(pod.slug);
		expect(after).toEqual([
			{ slug: quiet.slug, routing: { facilitator: false } },
			{ slug: routed.slug, routing: { facilitator: false } },
		]);
	});

	it("leaves pod routing alone when the Scribe is turned off", async () => {
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));
		await store.setModel(workspaceId, "summarise", "chosen-model");
		await store.setModel(workspaceId, "facilitate", "chosen-model");
		const routed = await placePod("routed", { facilitator: true });

		await store.setModel(workspaceId, "summarise", null);

		const [after] = await db
			.select({ routing: pod.routing })
			.from(pod)
			.where(eq(pod.id, routed.id));
		expect(after?.routing).toEqual({ facilitator: true });
	});

	async function placePod(slug: string, routing: { facilitator: boolean }) {
		const [made] = await db
			.insert(pod)
			.values({
				workspaceId,
				kind: "shared",
				name: slug,
				slug: `${slug}-${crypto.randomUUID()}`,
				routing,
			})
			.returning();
		if (!made) throw new Error("could not create the pod");
		return made;
	}

	it("refuses a second Scribe in the same workspace", async () => {
		await db.transaction((tx) => ensureSystemAgents(tx, { workspaceId, createdById: creatorId }));

		await expect(
			db.insert(agent).values({
				workspaceId,
				podId: null,
				name: "Second Scribe",
				handle: "second-scribe",
				systemAgentKey: "summarise",
				hue: 36,
				face: "smile",
				model: null,
			}),
		).rejects.toThrow();
	});
});
