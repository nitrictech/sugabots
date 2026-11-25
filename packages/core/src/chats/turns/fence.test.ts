import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Effect, Exit, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TurnAuthentication } from "../../authentication/turn.ts";
import { file, message, toolCall, turn } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../../database/testing.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import { asMember } from "../../operations/chats/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { asRunningTurn } from "../../operations/turns/running-turn.ts";
import type { BotPrincipal } from "../../principal.ts";
import { proveEndsTurn } from "../../proofs/ends-turn.ts";
import { named } from "../../proofs/proof.ts";
import { chatServicesForTests } from "../testing.ts";
import { executionFence, holdRunningTurn } from "./fence.ts";
import { TurnRecords } from "./records.ts";
import { TurnStore } from "./store.ts";
import {
	aChatAwaitingReply,
	asTheLoop,
	endTurn,
	type OpenedTurnForTests,
	openTurn,
	parkTurn,
	recordToolCall,
	replyTurnOf,
	runningTurns,
	runOver,
} from "./testing.ts";

/**
 * The fence on what the bot loop writes for a turn: each write checks, in
 * its own SQL, that the turn hasn't ended and that its principal is still
 * the turn's current execution, as its authenticator last raised it.
 */
describe.skipIf(!process.env.DATABASE_URL)("a turn's fence, against Postgres", async () => {
	const services = await chatServicesForTests({ publishCommitted: async () => undefined });
	const run = runOver(services);
	const call = await servedOperations({ chats: services });
	const chatsAs = (memberId: string) => asMember(call, memberId);
	const authentication = Context.get(services, TurnAuthentication.Service);
	const turns = onPostgres(Context.get(services, TurnStore.Service));
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

	/** Writes `text` as the reply, as `principal`'s execution of the turn, and says how it went. */
	const writeAs = (principal: BotPrincipal, text: string) =>
		run(
			Effect.exit(
				asRunningTurn(
					principal,
					{ chatId: opened.run.request.chatId, turnId: opened.turnId },
					(runsTurn) =>
						Effect.flatMap(TurnStore.Service, (turns) =>
							turns.keepReply(runsTurn, { content: text, toolCalls: [] }),
						),
				),
			),
		);

	const storedReply = async () => {
		const [row] = await onDatabase((db) =>
			db.select().from(message).where(eq(message.id, opened.replyMessageId)),
		);
		return row;
	};

	it("lets the turn's current execution write", async () => {
		expect(Exit.isSuccess(await writeAs(opened.principal, "Hello"))).toBe(true);
		expect(await storedReply()).toMatchObject({ content: "Hello" });
	});

	it("refuses an older execution's writes once the turn resumed, writing nothing", async () => {
		const resumed = await runOnPostgres(authentication.authenticate(opened.turnId));

		const stale = await writeAs(opened.principal, "From the old process");

		expect(stale).toMatchObject({
			_tag: "Failure",
			cause: { reasons: [{ error: { _tag: "TurnExecutionSuperseded" } }] },
		});
		expect(await storedReply()).toMatchObject({ content: "" });
		expect(Exit.isSuccess(await writeAs(resumed, "From the new one"))).toBe(true);
		expect(await storedReply()).toMatchObject({ content: "From the new one" });
	});

	it("refuses an older execution's tool call between the newer execution loading and asking for approval", async () => {
		const asked = {
			toolCallId: "sdk-1",
			tool: "run_command",
			input: {},
			writeOrDelete: true,
			binding: { kind: "built-in" as const },
		};
		await run(
			asTheLoop(opened, (runsTurn) =>
				Effect.flatMap(TurnStore.Service, (store) =>
					store.recordModelRequest(runsTurn, {
						modelInput: { model: "test", system: "", messages: [] },
						messages: [],
						reply: { content: "", toolCalls: [] },
						calls: [{ ...asked, toolName: asked.tool }],
						contextTokens: undefined,
						last: false,
					}),
				),
			),
		);
		const newer = {
			...opened,
			principal: await runOnPostgres(authentication.authenticate(opened.turnId)),
		};
		const loaded = await run(
			asTheLoop(newer, (runsTurn) =>
				Effect.flatMap(TurnRecords.Service, (records) => records.load(runsTurn, 0)),
			),
		);
		expect(loaded).toMatchObject({
			_tag: "Begun",
			calls: [{ toolCallId: asked.toolCallId }],
			recordedCallIds: [],
		});

		await expect(run(recordToolCall(opened, asked))).rejects.toMatchObject({
			_tag: "TurnExecutionSuperseded",
		});
		expect(await run(parkTurn(newer, [asked]))).toMatchObject({ _tag: "Waiting" });
		expect(
			await onDatabase((db) =>
				db.select().from(toolCall).where(eq(toolCall.turnId, opened.turnId)),
			),
		).toMatchObject([{ sdkToolCallId: asked.toolCallId, status: "awaiting_approval" }]);
		const [stored] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, opened.turnId)),
		);
		expect(stored).toMatchObject({ status: "waiting", writeOrDeleteStarted: false });
	});

	it("refuses an older execution's ending of the turn, which the newer one carries on", async () => {
		await runOnPostgres(authentication.authenticate(opened.turnId));

		const stale = await run(
			Effect.exit(
				named(opened.principal, opened.turnId, (principal, turnId) =>
					Effect.gen(function* () {
						const endsTurn = yield* proveEndsTurn(principal, turnId);
						const records = yield* TurnRecords.Service;
						return yield* records.endLost(endsTurn, {
							_tag: "Failed",
							userMessage: userText`Lost the chat`,
						});
					}),
				),
			),
		);

		expect(stale).toMatchObject({
			_tag: "Failure",
			cause: { reasons: [{ error: { _tag: "TurnExecutionSuperseded" } }] },
		});
		const [stored] = await onDatabase((db) =>
			db.select().from(turn).where(eq(turn.id, opened.turnId)),
		);
		expect(stored).toMatchObject({ status: "running" });
	});

	const filesInChat = () =>
		onDatabase((db) => db.select().from(file).where(eq(file.chatId, opened.run.request.chatId)));

	it("shares no file an older execution's tool attaches once the turn resumed", async () => {
		await runOnPostgres(authentication.authenticate(opened.turnId));

		await expect(
			turns.attachFile(
				{ ...replyTurnOf(opened), executionNumber: opened.principal.executionNumber },
				{ name: "late.csv", contentType: "text/csv", content: new Uint8Array([0x61]) },
			),
		).rejects.toMatchObject({ _tag: "ReplyEnded" });
		expect(await turns.replyFiles(replyTurnOf(opened))).toEqual([]);
	});

	it("keeps no long result an older execution's call returns once the turn resumed", async () => {
		const [running] = await onDatabase((db) =>
			db
				.insert(toolCall)
				.values({
					chatId: opened.run.request.chatId,
					messageId: opened.replyMessageId,
					turnId: opened.turnId,
					tool: "read_file",
					sdkToolCallId: "sdk-1",
					step: 0,
					input: {},
					atOffset: 0,
				})
				.returning({ id: toolCall.id }),
		);
		if (!running) throw new Error("no call recorded");
		await runOnPostgres(authentication.authenticate(opened.turnId));

		// As a step's tools keep a long result: only while their execution runs the turn.
		const kept = await run(
			Effect.exit(
				Effect.flatMap(ChatFileStore.Service, (files) =>
					files.write({
						chatId: opened.run.request.chatId,
						toolCallId: running.id,
						content: {
							stream: Stream.make(new TextEncoder().encode("long")),
							contentType: "text/plain",
						},
						guard: holdRunningTurn(
							executionFence(opened.turnId, opened.principal.executionNumber),
							"share",
						),
					}),
				).pipe(Effect.provide(ChatFileStore.layer)),
			),
		);

		expect(kept).toMatchObject({
			_tag: "Failure",
			cause: { reasons: [{ error: { _tag: "TurnExecutionSuperseded" } }] },
		});
		expect(await filesInChat()).toEqual([]);
	});

	it("refuses a write for a turn that has ended as ended, whichever execution asks", async () => {
		await run(endTurn(opened, { kind: "cancelled" }));

		expect(await writeAs(opened.principal, "Too late")).toMatchObject({
			_tag: "Failure",
			cause: { reasons: [{ error: { _tag: "TurnEnded" } }] },
		});
	});
});
