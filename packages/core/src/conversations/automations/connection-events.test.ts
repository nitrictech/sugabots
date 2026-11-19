import { handleFromName } from "@sugabots/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { automationRun, bot as botTable, connection } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../database/testing.ts";
import type { RepositoryActivity } from "../../providers/connections/github/github-events.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { conversationsForTests } from "../testing.ts";
import { Automations } from "./automations.ts";
import { anAutomationOwner } from "./testing.ts";

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
describe.skipIf(!process.env.DATABASE_URL)("connection automations, against Postgres", async () => {
	const conversations = await conversationsForTests(
		EventBus.inProcess({ store: EventStore.inMemory() }),
	);
	const events = onPostgres(Context.get(conversations, Automations.ConnectionEvents));
	let automations: Promised<Automations.Interface>;
	let owner: Awaited<ReturnType<typeof anAutomationOwner>>;
	let connectionId: string;

	afterAll(closeDatabase);

	beforeEach(async () => {
		owner = await anAutomationOwner();
		automations = onPostgresAs(owner.userId)(Context.get(conversations, Automations.Service));
		connectionId = await gitHubConnectionWith(owner.workspaceId, owner.ownProjectId, "acme/web");
	});

	const repositoryAutomation = (
		repository: string,
		events: RepositoryActivity["event"][],
		on = { projectId: owner.ownProjectId, connectionId },
	) =>
		automations.create(
			{ projectId: on.projectId },
			{
				name: `Reviews ${crypto.randomUUID()}`,
				instructions: "Review it.",
				triggers: [{ kind: "github", connectionId: on.connectionId, repository, events }],
			},
		);

	const deliver = (deliveryId: string, activity = opened) =>
		events.accept({ workspaceId: owner.workspaceId, connectionId, deliveryId, activity });

	it("takes only a repository its bot's GitHub app has, written as the connection has it", async () => {
		await expect(repositoryAutomation("acme/infra", ["push"])).rejects.toMatchObject({
			_tag: "AutomationRepositoryNotConnected",
		});

		const made = await repositoryAutomation("ACME/Web", ["pull_request_opened"]);

		expect(made.automation.triggers).toEqual([
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
		await repositoryAutomation("acme/web", ["pull_request_opened"]);
		const deliveryId = crypto.randomUUID();

		const [first] = await deliver(deliveryId);
		const [again] = await deliver(deliveryId);
		const pushed = await deliver(crypto.randomUUID(), { ...opened, event: "push" });

		expect(first?.duplicate).toBe(false);
		expect(again).toEqual({ ...first, duplicate: true });
		expect(pushed).toEqual([]);
	});

	it("doesn't run once the connection no longer has the repository", async () => {
		await repositoryAutomation("acme/web", ["pull_request_opened"]);
		await onDatabase((db) =>
			db
				.update(connection)
				.set({ settings: sql`${connection.settings} || '{"repositories": []}'::jsonb` })
				.where(eq(connection.id, connectionId)),
		);

		expect(await deliver(crypto.randomUUID())).toEqual([]);
	});

	it("runs only the automations of the project whose GitHub app the delivery came to", async () => {
		const other = await anotherBotOf(owner);
		const otherConnectionId = await gitHubConnectionWith(
			owner.workspaceId,
			other.projectId,
			"acme/web",
		);
		const ours = await repositoryAutomation("acme/web", ["pull_request_opened"]);
		await repositoryAutomation("acme/web", ["pull_request_opened"], {
			projectId: other.projectId,
			connectionId: otherConnectionId,
		});

		const accepted = await deliver(crypto.randomUUID());

		const ran = await onDatabase((db) =>
			db
				.select({ automationId: automationRun.automationId })
				.from(automationRun)
				.where(
					inArray(
						automationRun.id,
						accepted.map((one) => one.runId),
					),
				),
		);
		expect(ran).toEqual([{ automationId: ours.automation.id }]);
	});
});

/** The project's GitHub app, with `repository`, as one installed on its account. */
async function gitHubConnectionWith(workspaceId: string, projectId: string, repository: string) {
	const [connected] = await onDatabase((db) =>
		db
			.insert(connection)
			.values({
				workspaceId,
				projectId,
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

/** A second bot in the owner's workspace, with its default project. */
async function anotherBotOf(owner: { workspaceId: string; userId: string }) {
	const suffix = crypto.randomUUID();
	const [bot] = await onDatabase((db) =>
		db
			.insert(botTable)
			.values({
				workspaceId: owner.workspaceId,
				name: "Other Bot",
				handle: handleFromName(`Other Bot ${suffix}`),
				color: "green",
				face: "pill",
				model: "test/model",
				createdById: owner.userId,
			})
			.returning(),
	);
	if (!bot) throw new Error("fixture");
	return { botId: bot.id, projectId: await runOnPostgres(defaultProjectOf(bot.id)) };
}
