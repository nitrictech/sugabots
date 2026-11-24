import { handleFromName } from "@sugabots/contracts";
import { and, asc, eq, ne } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { query } from "../../database/database.ts";
import { bot, connector, member, membership, workspace } from "../../database/schema.ts";
import { onDatabase, type Promised, runOnPostgres } from "../../database/testing.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import { Files } from "../../files/files.ts";
import { lane, laneRequest } from "../../workflows/sql.ts";
import { BotStore } from "../../workspaces/bots/bot-store.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import type { Chats } from "../chats/chats.ts";
import { startBotChat } from "../chats/testing.ts";
import { lanesForTests } from "../testing.ts";
import { ApprovedToolCalls } from "./approvals/approved-calls.ts";
import { type PreparedTurn, TurnExecution, type TurnRun, turnRunFor } from "./execution.ts";
import { TurnStore } from "./store.ts";
import { ToolCallStore } from "./tool-calls/store.ts";
import { admitTurn, Turn, TurnRequest, turnLane } from "./turn.workflow.ts";

// Turn internals the cases outside `turns/` drive or inspect directly.
export { modelPrompt } from "./context.ts";
export { type PreparedTurn, replyTurnOf, TurnExecution } from "./execution.ts";
export { TurnSignals } from "./signals.ts";
export { type TurnCheckpoint, TurnStore } from "./store.ts";
export { ToolCallStore } from "./tool-calls/store.ts";
export { Turn, turnLane } from "./turn.workflow.ts";

/**
 * The services a case drives a turn's steps through, which `Turns.layer`
 * hides; built over the chat services.
 */
export const turnInternalsForTests = Layer.mergeAll(
	TurnExecution.layer,
	TurnStore.layer,
	ToolCallStore.layer,
	ApprovedToolCalls.layer,
	BotStore.layer,
	ChatFileStore.layer,
	Files.authoringLayer,
);

/*
 * Turns for the Postgres cases. They are asked for through real lanes, but
 * their workflows here only hold their lanes: a case runs a turn's steps
 * itself, with `runningTurns`, and frees the lane with `releaseTurn`. `lanesForTests` is read only when
 * a helper runs, as `../testing.ts` imports this file.
 */

export const queueTurnForTests = (request: TurnRequest) =>
	Effect.flatMap(lanesForTests, (service) => admitTurn(service, request));

/** The turns running in the chat, each as its workflow runs it. */
export const runningTurns = (chatId: string) =>
	query((db) =>
		db
			.select()
			.from(lane)
			.where(and(eq(lane.subject, chatId), eq(lane.workflow, Turn._tag), ne(lane.state, "idle"))),
	).pipe(
		Effect.flatMap((rows) =>
			Effect.forEach(rows, (row) => turnRunFor(Schema.decodeUnknownSync(TurnRequest)(row.payload))),
		),
	);

/** The turns asked for while the bot's turn in the chat runs, oldest first. */
export const waitingTurns = (lane: Pick<TurnRequest, "chatId" | "botId">) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(laneRequest)
				.where(eq(laneRequest.laneKey, turnLane(lane)))
				.orderBy(asc(laneRequest.createdAt), asc(laneRequest.id)),
		),
		(rows) => rows.map((row) => Schema.decodeUnknownSync(TurnRequest)(row.payload)),
	);

/** Frees the turn's lane, as its workflow's last step does, starting the turn waiting in it. */
export const releaseTurn = (run: TurnRun) =>
	Effect.flatMap(lanesForTests, (service) =>
		service.release({ key: turnLane(run.request), executionId: run.executionId }),
	);

/** Prepares the run, for a case that needs its turn to run. */
export async function prepareRunnable(
	execution: Pick<Promised<TurnExecution.Interface>, "prepare">,
	run: TurnRun,
): Promise<PreparedTurn> {
	const preparation = await execution.prepare(run);
	if (preparation._tag !== "Prepared") {
		throw new Error(`The turn may not run: ${preparation.reason}`);
	}
	return preparation;
}

/**
 * A bot with a connector, whose admin has asked it something in a chat, so
 * its turn is asked for in the chat.
 */
export async function aChatAwaitingReply(
	chatsAs: (memberId: string) => Pick<Promised<Chats.Interface>, "startProjectChat">,
) {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [created] = await onDatabase((db) =>
		db
			.insert(workspace)
			.values({ name: `Turns ${suffix}`, slug: `turns-${suffix}` })
			.returning(),
	);
	const [admin] = await onDatabase((db) =>
		db
			.insert(member)
			.values({ name: "Sam", email: `turns-${suffix}@example.com` })
			.returning(),
	);
	if (!created || !admin) throw new Error("fixture");
	const workspaceId = created.id;
	const adminId = admin.id;
	await onDatabase((db) =>
		db.insert(membership).values({ workspaceId, memberId: adminId, role: "admin" }),
	);
	const [chatBot] = await onDatabase((db) =>
		db
			.insert(bot)
			.values({
				workspaceId,
				name: `Bot ${suffix}`,
				handle: handleFromName(`Bot ${suffix}`),
				color: "rose",
				eyes: "pill",
				model: "m",
				createdById: adminId,
			})
			.returning({ id: bot.id }),
	);
	if (!chatBot) throw new Error("fixture");
	// The bot's own connector, which its default project holds.
	const ownProjectId = await runOnPostgres(defaultProjectOf(chatBot.id));
	const [connected] = await onDatabase((db) =>
		db
			.insert(connector)
			.values({
				workspaceId,
				projectId: ownProjectId,
				name: `Linear ${suffix}`,
				handle: `linear-${suffix}`,
				url: "https://linear.example.com/mcp",
				authKind: "header",
				createdById: adminId,
			})
			.returning({ id: connector.id }),
	);
	if (!connected) throw new Error("fixture");
	const started = await startBotChat(chatsAs(adminId), {
		botId: chatBot.id,
		messageId: crypto.randomUUID(),
		content: "What does example.com say?",
	});
	const opened = started.chat;
	return {
		workspaceId,
		adminId,
		botId: chatBot.id,
		connectorId: connected.id,
		chatId: opened.id,
	};
}
