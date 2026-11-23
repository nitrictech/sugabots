import { handleFromName } from "@sugabots/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { automationRun, bot as botTable, connector } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	type Promised,
	runOnPostgres,
} from "../../database/testing.ts";
import type { RepositoryActivity } from "../../providers/connectors/github/github-events.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { chatServicesForTests } from "../testing.ts";
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
describe.skipIf(!process.env.DATABASE_URL)("connector automations, against Postgres", async () => {
	const services = await chatServicesForTests(EventBus.inProcess({ store: EventStore.inMemory() }));
	const events = onPostgres(Context.get(services, Automations.ConnectorEvents));
	let automations: Promised<Automations.Interface>;
	let owner: Awaited<ReturnType<typeof anAutomationOwner>>;
	let connectorId: string;

	afterAll(closeDatabase);

	beforeEach(async () => {
		owner = await anAutomationOwner();
		automations = onPostgresAs(owner.personId)(Context.get(services, Automations.Service));
		connectorId = await gitHubConnectorWith(owner.workspaceId, owner.ownProjectId, "acme/web");
	});

	const repositoryAutomation = (
		repository: string,
		events: RepositoryActivity["event"][],
		on = { projectId: owner.ownProjectId, connectorId },
	) =>
		automations.create(
			{ projectId: on.projectId },
			{
				name: `Reviews ${crypto.randomUUID()}`,
				instructions: "Review it.",
				triggers: [{ kind: "github", connectorId: on.connectorId, repository, events }],
			},
		);

	const deliver = (deliveryId: string, activity = opened) =>
		events.accept({ workspaceId: owner.workspaceId, connectorId, deliveryId, activity });

	it("takes only a repository its bot's GitHub app has, written as the connector has it", async () => {
		await expect(repositoryAutomation("acme/infra", ["push"])).rejects.toMatchObject({
			_tag: "AutomationRepositoryNotConnected",
		});

		const made = await repositoryAutomation("ACME/Web", ["pull_request_opened"]);

		expect(made.automation.triggers).toEqual([
			{
				id: expect.any(String),
				kind: "github",
				connectorId,
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

	it("doesn't run once the connector no longer has the repository", async () => {
		await repositoryAutomation("acme/web", ["pull_request_opened"]);
		await onDatabase((db) =>
			db
				.update(connector)
				.set({ settings: sql`${connector.settings} || '{"repositories": []}'::jsonb` })
				.where(eq(connector.id, connectorId)),
		);

		expect(await deliver(crypto.randomUUID())).toEqual([]);
	});

	it("runs only the automations of the project whose GitHub app the delivery came to", async () => {
		const other = await anotherBotOf(owner);
		const otherConnectorId = await gitHubConnectorWith(
			owner.workspaceId,
			other.projectId,
			"acme/web",
		);
		const ours = await repositoryAutomation("acme/web", ["pull_request_opened"]);
		await repositoryAutomation("acme/web", ["pull_request_opened"], {
			projectId: other.projectId,
			connectorId: otherConnectorId,
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
async function gitHubConnectorWith(workspaceId: string, projectId: string, repository: string) {
	const [connected] = await onDatabase((db) =>
		db
			.insert(connector)
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
async function anotherBotOf(owner: { workspaceId: string; personId: string }) {
	const suffix = crypto.randomUUID();
	const [bot] = await onDatabase((db) =>
		db
			.insert(botTable)
			.values({
				workspaceId: owner.workspaceId,
				name: "Other Bot",
				handle: handleFromName(`Other Bot ${suffix}`),
				color: "green",
				eyes: "pill",
				model: "test/model",
				createdById: owner.personId,
			})
			.returning(),
	);
	if (!bot) throw new Error("fixture");
	return { botId: bot.id, projectId: await runOnPostgres(defaultProjectOf(bot.id)) };
}
