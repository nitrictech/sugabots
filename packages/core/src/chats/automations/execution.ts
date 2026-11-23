import type { AutomationListStatus, Run, RunState } from "@sugabots/contracts";
import { desc, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { BotFacts } from "../../authorization/permissions.ts";
import { type Executor, query } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import {
	automation,
	automationRun,
	bot,
	chatRead,
	message,
	placedChat,
} from "../../database/schema.ts";
import { lineageOf } from "../store/tree.ts";

/**
 * A run as the API describes it, listed in the chat `rootChatId`,
 * which `posted` a result or not (see `resultPosted`).
 */
export function toRun(row: schema.RunRow, rootChatId: string, posted: boolean): Run {
	return {
		id: row.id,
		automationId: row.automationId,
		workspaceId: row.workspaceId,
		botId: row.botId,
		chatId: row.chatId,
		rootChatId,
		automationName: row.automationName,
		instructions: row.instructions,
		trigger: row.trigger,
		state: row.state,
		error: row.error,
		posted,
		acceptedAt: row.acceptedAt.toISOString(),
		startedAt: row.startedAt?.toISOString() ?? null,
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

/**
 * Whether the run `runId` posted a result, as a SQL condition. Every
 * result is posted in the automation's feed, whatever else it goes to.
 */
export const resultPosted = (runId: SQLWrapper) =>
	sql<boolean>`exists (select 1 from ${message} where ${message.runId} = ${runId})`;

/**
 * The automation run a chat belongs to, found through its ancestors, as a
 * scalar subquery: a collaboration an automation's bot starts is part of the run.
 */
export const runIdOf = (chatId: SQLWrapper) => sql<string | null>`(
	select execution.id
	from ${automationRun} execution
	join ${lineageOf(chatId)} as lineage on lineage.id = execution.chat_id
	limit 1
)`;

export const findRunId = Effect.fn("Run.findRunId")(function* (db: Executor, chatId: string) {
	const rows = yield* db.execute<{ id: string | null }>(
		sql`select ${runIdOf(sql`${chatId}`)} as id`,
		"objects",
	);
	return rows[0]?.id ?? undefined;
});

/**
 * The bot doing the automation run a chat belongs to (see `runIdOf`), as
 * a scalar subquery; null for a chat outside a run.
 */
export const runBotIdOf = (chatId: SQLWrapper) => sql<string | null>`(
	select execution.bot_id
	from ${automationRun} execution
	join ${lineageOf(chatId)} as lineage on lineage.id = execution.chat_id
	limit 1
)`;

/**
 * What who decides a run's approvals is decided from about the bot doing
 * the run a chat belongs to (see `mayDecideToolCall`), as a scalar jsonb
 * subquery, which `select distinct` can compare; null outside a run.
 */
export const runBotFactsOf = (chatId: SQLWrapper) => sql<BotFacts | null>`(
	select jsonb_build_object(
		'visibility', run_bot.visibility,
		'createdById', run_bot.created_by_id,
		'assistantOf', run_bot.assistant_of
	)
	from ${bot} run_bot
	where run_bot.id = ${runBotIdOf(chatId)}
)`;

/** The bot doing the run the chat `chatId` belongs to, as `runBotFactsOf` reads it; undefined outside a run. */
export const findRunBot = Effect.fn("Run.findRunBot")(function* (db: Executor, chatId: string) {
	const rows = yield* db.execute<{ bot: BotFacts | null }>(
		sql`select ${runBotFactsOf(sql`${chatId}`)} as bot`,
		"objects",
	);
	return rows[0]?.bot ?? undefined;
});

/**
 * lockAutomationSettlement holds the settlement lock of the automation run
 * `runId` until the transaction ends. Settling the run holds it, so an
 * answer read under it about whether the run still takes work stands until
 * the transaction ends.
 *
 * Lock order: only settlement, in a transaction of its own after the events
 * that trigger it commit, and a transaction admitting work into the run
 * (`automationAcceptsWork`) take this lock, both before any row they lock.
 * Settlement skips the running turns, collaborations and waiting lane
 * requests another transaction holds; that transaction's own events settle
 * the run again.
 */
export const lockAutomationSettlement = (runId: string) =>
	query((db) =>
		db.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`automation-settle:${runId}`}, 0))`,
		),
	).pipe(Effect.asVoid);

/**
 * lockAutomationSettlementOf holds the settlement lock of the automation run the
 * chat `chatId` belongs to, if any, as `lockAutomationSettlement` does, and
 * returns the run's id.
 */
const lockAutomationSettlementOf = Effect.fn("Run.lockAutomationSettlementOf")(function* (
	chatId: string,
) {
	const runId = yield* query((db) => findRunId(db, chatId));
	if (runId) yield* lockAutomationSettlement(runId);
	return runId;
});

/**
 * automationAcceptsWork reports whether the automation run the chat `chatId`
 * belongs to still takes turns and tool calls: it is queued or running, and
 * nothing has started ending it. A chat outside any run takes work. The
 * run's settlement lock is held until the transaction ends, so the answer
 * stands while the caller admits the work.
 */
export const automationAcceptsWork = Effect.fn("Run.automationAcceptsWork")(function* (
	chatId: string,
) {
	const runId = yield* lockAutomationSettlementOf(chatId);
	if (!runId) return true;
	const [execution] = yield* query((db) =>
		db
			.select({
				state: automationRun.state,
				pendingTerminalState: automationRun.pendingTerminalState,
			})
			.from(automationRun)
			.where(eq(automationRun.id, runId))
			.limit(1),
	);
	return (
		execution !== undefined &&
		execution.pendingTerminalState === null &&
		(execution.state === "queued" || execution.state === "running")
	);
});

/**
 * Whether the automation `of` names is failing, as a value for a query over
 * it: it paused itself after its runs kept failing, or it is enabled and its
 * latest run failed. One paused by hand is not failing, whatever its last run
 * did. `latestRunState` is the state of its latest run, null before it has
 * one: a column of `latestRunOf` where a query joins it, else looked up. The
 * lists, the sidebar, the details panel and the Personal Assistant all count
 * failing automations by this.
 */
export function automationFailing(
	of: typeof automation = automation,
	latestRunState: SQLWrapper = latestRunStateOf(of.id),
): SQL<boolean> {
	return sql<boolean>`(${of.pausedAfterFailuresAt} is not null or (${of.state} = 'enabled' and coalesce(${latestRunState} = 'failed', false)))`;
}

/**
 * Whether the automation `of` names is failing (see `automationFailing`) and
 * `personId` has not opened its feed since its latest run ended: what marks it
 * for them until they look.
 */
export function unseenAutomationFailure(
	personId: string,
	of: typeof automation = automation,
	latestRunState?: SQLWrapper,
): SQL<boolean> {
	return sql<boolean>`(${automationFailing(of, latestRunState)} and ${latestRunUnseenBy(of.id, personId)})`;
}

/**
 * The latest run of each automation in a query over `automation`, by when it
 * was accepted, the later id breaking a tie, as a subquery to left join
 * laterally: `.leftJoinLateral(latest, sql\`true\`)`. No row before it has run.
 */
export function latestRunOf(db: Executor) {
	return db
		.select({
			id: automationRun.id,
			state: automationRun.state,
			error: automationRun.error,
			acceptedAt: automationRun.acceptedAt,
			posted: sql<boolean>`${resultPosted(automationRun.id)}`.as("latest_run_posted"),
		})
		.from(automationRun)
		.where(eq(automationRun.automationId, automation.id))
		.orderBy(desc(automationRun.acceptedAt), desc(automationRun.id))
		.limit(1)
		.as("latest_run");
}

/**
 * The columns {@link toListStatus} reads, to select in a query over
 * `automation` that left joins `latest`, a {@link latestRunOf}, laterally.
 */
export function listStatusColumns(latest: ReturnType<typeof latestRunOf>) {
	return {
		latestRun: {
			id: latest.id,
			state: latest.state,
			error: latest.error,
			acceptedAt: latest.acceptedAt,
			posted: latest.posted,
		},
		failing: automationFailing(automation, latest.state),
	};
}

/** How a listed automation stands, from its `latestRunOf` row, none before it has run, and whether it is failing. */
export function toListStatus(row: {
	failing: boolean;
	latestRun: {
		id: string;
		state: RunState;
		error: string | null;
		acceptedAt: Date;
		posted: boolean;
	} | null;
}): AutomationListStatus {
	const latest = row.latestRun;
	return {
		failing: row.failing,
		latestRun: latest && { ...latest, acceptedAt: latest.acceptedAt.toISOString() },
	};
}

/**
 * Whether `personId` has not opened the feed of the automation `automationId`
 * since its latest run ended, as a value for a query; false while it has no
 * run that ended. Opening the feed reads it through its newest run's end.
 */
function latestRunUnseenBy(automationId: SQLWrapper, personId: string): SQL<boolean> {
	return sql<boolean>`coalesce((
		select ${automationRun.finishedAt} is not null and not exists (
			select 1 from ${chatRead} join ${placedChat} on ${placedChat.id} = ${chatRead.chatId}
			where ${placedChat.automationId} = ${automationId}
				and ${chatRead.personId} = ${personId}
				and ${chatRead.readThrough} >= ${automationRun.finishedAt}
		)
		from ${automationRun}
		where ${automationRun.automationId} = ${automationId}
		order by ${automationRun.acceptedAt} desc, ${automationRun.id} desc
		limit 1
	), false)`;
}

/** The state of the latest run of the automation `automationId`, or null before it has run, as a value for a query. */
function latestRunStateOf(automationId: SQLWrapper): SQL<RunState | null> {
	return sql<RunState | null>`(
		select ${automationRun.state} from ${automationRun}
		where ${automationRun.automationId} = ${automationId}
		order by ${automationRun.acceptedAt} desc, ${automationRun.id} desc
		limit 1
	)`;
}
