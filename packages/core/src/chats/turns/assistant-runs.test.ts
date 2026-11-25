import { Context, Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedAutomation,
	seedBot,
	seedMember,
	seedMessage,
	seedRun,
	seedTurn,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { TurnAuthentication } from "../../authentication/turn.ts";
import { closeDatabase, runOnPostgres } from "../../database/testing.ts";
import { asRunningTurn } from "../../operations/turns/running-turn.ts";
import { chatServicesForTests } from "../testing.ts";
import { TurnRecords } from "./records.ts";
import { runOver } from "./testing.ts";

/**
 * A Personal Assistant's automation runs, as a step loads them: they act for
 * its member, as their turns store, though the message the run answers is the
 * automation's; a run started from outside acts only within its chat.
 */
describe.skipIf(!process.env.DATABASE_URL)("a Personal Assistant's runs", async () => {
	const services = await chatServicesForTests({ publishCommitted: async () => undefined });
	const run = runOver(services);
	const authentication = Context.get(services, TurnAuthentication.Service);
	let workspaceId: string;
	let patId: string;
	let assistant: { id: string; defaultProject: string };
	let automationId: string;

	beforeAll(async () => {
		workspaceId = await seedWorkspace();
		patId = await seedMember(workspaceId, "editor");
		assistant = await seedBot(workspaceId, { assistantOf: patId, visibility: "personal" });
		automationId = await seedAutomation(workspaceId, assistant.defaultProject);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** Loads the first step of a turn of the assistant's run, started as `startedBy` says. */
	const loadRunStarted = async (startedBy: "routine" | "webhook") => {
		const started = await seedRun(workspaceId, automationId, assistant.id, startedBy);
		const turnId = await seedTurn(started.chat, assistant.id, started.triggerMessage, {
			reason: "automation",
		});
		await seedMessage(started.chat, { bot: assistant.id, turn: turnId });
		const principal = await runOnPostgres(authentication.authenticate(turnId));
		const loaded = await run(
			asRunningTurn(principal, { chatId: started.chat, turnId }, (runsTurn) =>
				Effect.flatMap(TurnRecords.Service, (records) => records.load(runsTurn, 0)),
			),
		);
		return { principal, loaded };
	};

	it("sets up a routine run's tools for the member it acts for, within what they reach", async () => {
		const { principal, loaded } = await loadRunStarted("routine");
		expect(loaded).toMatchObject({ _tag: "Begun", setting: { askerId: patId } });
		expect(principal).toMatchObject({ asker: patId, bounds: { kind: "member" } });
	});

	it("acts for its member only within its chat, for a run started from outside", async () => {
		const { principal, loaded } = await loadRunStarted("webhook");
		expect(loaded).toMatchObject({ _tag: "Begun", setting: { askerId: patId } });
		expect(principal).toMatchObject({ asker: patId, bounds: { kind: "chat" } });
	});
});
