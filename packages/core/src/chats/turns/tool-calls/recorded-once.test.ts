import { eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TurnAuthentication } from "../../../authentication/turn.ts";
import { violatedUniqueConstraint } from "../../../database/errors.ts";
import { toolCall, turn } from "../../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../../database/testing.ts";
import { asMember } from "../../../operations/chats/testing.ts";
import { servedOperations } from "../../../operations/testing.ts";
import { chatServicesForTests } from "../../testing.ts";
import type { ApprovalBinding } from "../loop-values.ts";
import { CHANGED_SINCE_SENT, TurnRecords } from "../records.ts";
import {
	aChatAwaitingReply,
	asTheLoop,
	type OpenedTurnForTests,
	openTurn,
	runningTurns,
	runOver,
} from "../testing.ts";

import { INTERRUPTED_CALL } from "./lifecycle.ts";

/**
 * Each tool call is recorded as sent before it is sent, once, under its
 * turn, its step and the model's id for it. An execution that resumes the
 * turn and finds a call recorded already sends it again only if it changes
 * nothing and never finished.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"tool calls recorded once, against Postgres",
	async () => {
		const services = await chatServicesForTests({ publishCommitted: async () => undefined });
		const run = runOver(services);
		const call = await servedOperations({ chats: services });
		const chatsAs = (memberId: string) => asMember(call, memberId);
		const authentication = Context.get(services, TurnAuthentication.Service);
		let opened: OpenedTurnForTests;

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			const { chatId } = await aChatAwaitingReply(chatsAs);
			const [running] = await runOnPostgres(runningTurns(chatId));
			if (!running) throw new Error("no turn running");
			opened = await run(openTurn(running));
		});

		/**
		 * Records the step's call `sdk-1` as `of`'s execution of the turn: by
		 * default to a built-in tool that changes something when `writeOrDelete`.
		 */
		const record = (
			of: OpenedTurnForTests,
			writeOrDelete: boolean,
			call: { readonly tool?: string; readonly binding?: ApprovalBinding } = {},
		) =>
			run(
				asTheLoop(of, (runsTurn) =>
					Effect.flatMap(TurnRecords.Service, (records) =>
						records.recordToolCall(runsTurn, {
							step: 0,
							toolCallId: "sdk-1",
							tool: call.tool ?? (writeOrDelete ? "run_command" : "read_file"),
							input: { path: "notes.md" },
							writeOrDelete,
							binding: call.binding ?? { kind: "built-in" },
						}),
					),
				),
			);

		/** The connector tool `wiki__lookup`, as its connector's revision `revision` binds it. */
		const lookup = (revision: number) => ({
			tool: "wiki__lookup",
			binding: {
				kind: "connector" as const,
				connectorId: crypto.randomUUID(),
				connectorRevision: revision,
				remoteToolName: "lookup",
			},
		});

		/** The turn as a newer execution has it, once it resumed. */
		const resumed = async (): Promise<OpenedTurnForTests> => ({
			...opened,
			principal: await runOnPostgres(authentication.authenticate(opened.turnId)),
		});

		const callsOfTurn = () =>
			onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.turnId, opened.turnId)));

		it("keeps a call made before steps were recorded unique under its turn and the model's id", async () => {
			const unstepped = {
				chatId: opened.run.request.chatId,
				messageId: opened.replyMessageId,
				turnId: opened.turnId,
				tool: "read_file",
				sdkToolCallId: "sdk-old",
				input: {},
				atOffset: 0,
			};
			await onDatabase((db) => db.insert(toolCall).values(unstepped));

			await expect(onDatabase((db) => db.insert(toolCall).values(unstepped))).rejects.toSatisfy(
				(error: unknown) => violatedUniqueConstraint(error) === "tool_call_unstepped_call_idx",
			);
		});

		it("records a call with its step and the model's id, to be sent", async () => {
			const recorded = await record(opened, false);

			expect(recorded).toEqual({ _tag: "Send", id: expect.any(String) });
			expect(await callsOfTurn()).toMatchObject([
				{ id: recorded.id, step: 0, sdkToolCallId: "sdk-1", status: "running" },
			]);
		});

		it("marks a write/delete call an earlier execution sent and never finished as interrupted, rather than send it again", async () => {
			const first = await record(opened, true);

			const again = await record(await resumed(), true);

			expect(again).toEqual({
				_tag: "Interrupted",
				id: first.id,
				error: INTERRUPTED_CALL,
			});
			const calls = await callsOfTurn();
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({
				status: "failed",
				error: INTERRUPTED_CALL,
			});
			const [stored] = await onDatabase((db) =>
				db.select().from(turn).where(eq(turn.id, opened.turnId)),
			);
			// The turn acted, so it is not run again from the start if it fails.
			expect(stored).toMatchObject({ status: "running", writeOrDeleteStarted: true });
		});

		it("doesn't send a call again once its tool is classed as changing things, nor twice under one key", async () => {
			const bound = lookup(1);
			const first = await record(opened, false, bound);
			expect(first).toEqual({ _tag: "Send", id: expect.any(String) });

			// The same connector tool is reclassified as write/delete, and two calls
			// arrive at once with the model's same id for it.
			const [again, alsoAgain] = await Promise.all([
				record(opened, true, bound),
				record(opened, true, bound),
			]);

			expect([again, alsoAgain]).toEqual(
				expect.arrayContaining([
					{ _tag: "NotSent", id: first.id, error: CHANGED_SINCE_SENT },
					{ _tag: "Finished", id: first.id, outcome: { error: CHANGED_SINCE_SENT } },
				]),
			);

			expect(await callsOfTurn()).toMatchObject([
				{ id: first.id, status: "failed", error: CHANGED_SINCE_SENT },
			]);
			const [stored] = await onDatabase((db) =>
				db.select().from(turn).where(eq(turn.id, opened.turnId)),
			);
			expect(stored).toMatchObject({ writeOrDeleteStarted: false });
		});

		it("doesn't send a call again once its connector changed since it was sent", async () => {
			const first = await record(opened, false, lookup(1));

			const again = await record(await resumed(), false, { ...lookup(2) });

			expect(again).toMatchObject({ _tag: "NotSent", id: first.id });
		});

		it("sends a call that changes nothing once per execution, however often it is asked for", async () => {
			const bound = lookup(1);
			const first = await record(opened, false, bound);
			// The same execution asks again, as concurrent calls with one id do.
			const duplicates = await Promise.all([
				record(opened, false, bound),
				record(opened, false, bound),
			]);
			expect(duplicates).toEqual([
				{ _tag: "NotSent", id: first.id, error: expect.any(String) },
				{ _tag: "NotSent", id: first.id, error: expect.any(String) },
			]);

			const newer = await resumed();
			const resends = await Promise.all([record(newer, false, bound), record(newer, false, bound)]);

			expect(resends.filter(({ _tag }) => _tag === "Send")).toEqual([
				{ _tag: "Send", id: first.id },
			]);
			expect(resends.filter(({ _tag }) => _tag === "NotSent")).toHaveLength(1);
			expect(await callsOfTurn()).toHaveLength(1);
		});

		it("sends again, under the same record, a call that changes nothing and never finished", async () => {
			const first = await record(opened, false);

			const again = await record(await resumed(), false);

			expect(again).toEqual({ _tag: "Send", id: first.id });
			expect(await callsOfTurn()).toHaveLength(1);
		});

		it("gives back what a call an earlier execution finished returned", async () => {
			const first = await record(opened, true);
			await run(
				asTheLoop(opened, (runsTurn) =>
					Effect.flatMap(TurnRecords.Service, (records) =>
						records.finishToolCall(runsTurn, first.id, { output: { exitCode: 0 } }),
					),
				),
			);

			const again = await record(await resumed(), true);

			expect(again).toEqual({
				_tag: "Finished",
				id: first.id,
				outcome: { output: { exitCode: 0 } },
			});
		});
	},
);
