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
 * A personal bot's automation runs, a Personal Assistant's included, as a step
 * loads them: they act for its creator, as their turns store, though the
 * message the run answers is the automation's; a run started from outside
 * acts only within its chat.
 */
describe.skipIf(!process.env.DATABASE_URL)("a personal bot's runs", async () => {
	const services = await chatServicesForTests({ publishCommitted: async () => undefined });
	const run = runOver(services);
	const authentication = Context.get(services, TurnAuthentication.Service);
	let workspaceId: string;
	let patId: string;
	const personalBots: Record<string, { id: string; automation: string }> = {};

	beforeAll(async () => {
		workspaceId = await seedWorkspace();
		patId = await seedMember(workspaceId, "editor");
		const made = {
			"Personal Assistant": { assistantOf: patId },
			"personal bot": { createdById: patId },
		};
		for (const [kind, fields] of Object.entries(made)) {
			const bot = await seedBot(workspaceId, { ...fields, visibility: "personal" });
			personalBots[kind] = {
				id: bot.id,
				automation: await seedAutomation(workspaceId, bot.defaultProject),
			};
		}
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** Loads the first step of a turn of the `kind` bot's run, started as `startedBy` says. */
	const loadRunStarted = async (kind: string, startedBy: "routine" | "webhook") => {
		const bot = personalBots[kind];
		if (!bot) throw new Error(`No ${kind}`);
		const started = await seedRun(workspaceId, bot.automation, bot.id, startedBy);
		const turnId = await seedTurn(started.chat, bot.id, started.triggerMessage, {
			reason: "automation",
		});
		await seedMessage(started.chat, { bot: bot.id, turn: turnId });
		const principal = await runOnPostgres(authentication.authenticate(turnId));
		const loaded = await run(
			asRunningTurn(principal, { chatId: started.chat, turnId }, (runsTurn) =>
				Effect.flatMap(TurnRecords.Service, (records) => records.load(runsTurn, 0)),
			),
		);
		return { loaded };
	};

	it.each([
		["Personal Assistant", "routine"],
		["Personal Assistant", "webhook"],
		["personal bot", "routine"],
		["personal bot", "webhook"],
	] as const)("loads a %s's %s run's step for its creator", async (kind, startedBy) => {
		const { loaded } = await loadRunStarted(kind, startedBy);
		expect(loaded).toMatchObject({ _tag: "Begun", setting: { askerId: patId } });
	});
});
