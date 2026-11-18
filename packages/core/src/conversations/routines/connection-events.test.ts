import { handleFromName } from "@sugabots/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { agent, connection, routineExecution } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, type Promised } from "../../database/testing.ts";
import type { RepositoryActivity } from "../../providers/connections/github/github-events.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { conversationsForTests } from "../testing.ts";
import { Routines } from "./routines.ts";
import { aRoutineOwner } from "./testing.ts";

const opened: RepositoryActivity = {
	event: "pull_request_opened",
	repository: "acme/web",
	sender: "octocat",
	url: "https://github.com/acme/web/pull/3",
	number: 3,
	title: "Fix the login",
	text: "It redirects home.",
	branch: "fix-login",
};

/** Automations run by what happens at their bot's GitHub app's repositories, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)("connection routines, against Postgres", async () => {
	const conversations = await conversationsForTests(
		EventBus.inProcess({ store: EventStore.inMemory() }),
	);
	const events = onPostgres(Context.get(conversations, Routines.ConnectionEvents));
	let routines: Promised<Routines.Interface>;
	let owner: Awaited<ReturnType<typeof aRoutineOwner>>;
	let connectionId: string;

	afterAll(closeDatabase);

	beforeEach(async () => {
		owner = await aRoutineOwner();
		routines = onPostgresAs(owner.userId)(Context.get(conversations, Routines.Service));
		connectionId = await gitHubConnectionWith(owner.workspaceId, owner.agentId, "acme/web");
	});

	const repositoryRoutine = (
		repository: string,
		events: RepositoryActivity["event"][],
		on = { agentId: owner.agentId, connectionId },
	) =>
		routines.create(
			{ agentId: on.agentId },
			{
				name: `Reviews ${crypto.randomUUID()}`,
				instructions: "Review it.",
				triggers: [{ kind: "github", connectionId: on.connectionId, repository, events }],
			},
		);

	const deliver = (deliveryId: string, activity = opened) =>
		events.accept({ workspaceId: owner.workspaceId, connectionId, deliveryId, activity });

	it("takes only a repository its bot's GitHub app has, written as the connection has it", async () => {
		await expect(repositoryRoutine("acme/infra", ["push"])).rejects.toMatchObject({
			_tag: "RoutineRepositoryNotConnected",
		});

		const made = await repositoryRoutine("ACME/Web", ["pull_request_opened"]);

		expect(made.routine.triggers).toEqual([
			{
				id: expect.any(String),
				kind: "github",
				connectionId,
				repository: "acme/web",
				events: ["pull_request_opened"],
			},
		]);
	});

	it("runs once for each delivery of an event it listens for", async () => {
		await repositoryRoutine("acme/web", ["pull_request_opened"]);
		const deliveryId = crypto.randomUUID();

		const [first] = await deliver(deliveryId);
		const [again] = await deliver(deliveryId);
		const pushed = await deliver(crypto.randomUUID(), { ...opened, event: "push" });

		expect(first?.duplicate).toBe(false);
		expect(again).toEqual({ ...first, duplicate: true });
		expect(pushed).toEqual([]);
	});

	it("doesn't run once the connection no longer has the repository", async () => {
		await repositoryRoutine("acme/web", ["pull_request_opened"]);
		await onDatabase((db) =>
			db
				.update(connection)
				.set({ settings: sql`${connection.settings} || '{"repositories": []}'::jsonb` })
				.where(eq(connection.id, connectionId)),
		);

		expect(await deliver(crypto.randomUUID())).toEqual([]);
	});

	it("runs only the automations of the bot whose GitHub app the delivery came to", async () => {
		const other = await anotherBotOf(owner);
		const otherConnectionId = await gitHubConnectionWith(
			owner.workspaceId,
			other.agentId,
			"acme/web",
		);
		const ours = await repositoryRoutine("acme/web", ["pull_request_opened"]);
		await repositoryRoutine("acme/web", ["pull_request_opened"], {
			agentId: other.agentId,
			connectionId: otherConnectionId,
		});

		const accepted = await deliver(crypto.randomUUID());

		const ran = await onDatabase((db) =>
			db
				.select({ routineId: routineExecution.routineId })
				.from(routineExecution)
				.where(
					inArray(
						routineExecution.id,
						accepted.map((one) => one.executionId),
					),
				),
		);
		expect(ran).toEqual([{ routineId: ours.routine.id }]);
	});
});

/** The bot's GitHub app, with `repository`, as one installed on its account. */
async function gitHubConnectionWith(workspaceId: string, agentId: string, repository: string) {
	const [connected] = await onDatabase((db) =>
		db
			.insert(connection)
			.values({
				workspaceId,
				agentId,
				kind: "github",
				name: "GitHub",
				handle: "github",
				url: "https://github.com/acme",
				settings: {
					kind: "github",
					appId: 42,
					slug: `acme-sugabots-${crypto.randomUUID()}`,
					owner: { login: "acme", type: "Organization" },
					installationId: 7,
					account: "acme",
					repositories: [
						{ id: 1, path: repository, addedById: null, addedAt: "2026-10-16T00:00:00.000Z" },
					],
				},
				appCredentialEncrypted: "unused",
			})
			.returning(),
	);
	if (!connected) throw new Error("fixture");
	return connected.id;
}

/** A second bot in the owner's workspace. */
async function anotherBotOf(owner: { workspaceId: string; userId: string }) {
	const suffix = crypto.randomUUID();
	const [crew] = await onDatabase((db) =>
		db
			.insert(agent)
			.values({
				workspaceId: owner.workspaceId,
				name: "Other Agent",
				handle: handleFromName(`Other Agent ${suffix}`),
				color: "green",
				face: "pill",
				model: "test/model",
				createdById: owner.userId,
			})
			.returning(),
	);
	if (!crew) throw new Error("fixture");
	return { agentId: crew.id };
}
