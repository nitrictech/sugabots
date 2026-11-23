export * as Usage from "./usage.ts";

import {
	DEFAULT_TIME_ZONE,
	type UsageMonth,
	type UsageQuery,
	type WorkspaceUsage,
} from "@sugabots/contracts";
import { and, eq, gte, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { query, serviceOperations } from "../database/database.ts";
import { bot, modelProvider, modelRequest, providerModel, workspace } from "../database/schema.ts";

/** What a workspace's models cost, from the request ledger. */
export interface Interface {
	/**
	 * One month's usage in a workspace named by its id or its slug, with the
	 * month and its days in the workspace's time zone. It shows every bot's
	 * usage, so it takes the current actor's `workspace.usage.manage`; the
	 * Personal Assistants', each its own person's, only together.
	 */
	readonly month: (
		input: UsageQuery & { workspace: string },
	) => Effect.Effect<WorkspaceUsage, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Usage") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Usage");
	const authorization = yield* Authorization.Service;
	return Service.of({
		month: ({ workspace, month }) =>
			operation(
				"month",
				Effect.flatMap(
					authorization.workspace(workspace, "workspace.usage.manage"),
					({ workspaceId }) => loadMonth(workspaceId, month),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Authorization.layer));

/**
 * How long a request can be out before it is taken to have been cut off by
 * its process stopping: twice the longest a request is waited on, which is
 * compaction's five minutes. One started more recently is still going, and is
 * left out rather than counted as of unknown cost.
 */
const INTERRUPTED_AFTER_MINUTES = 10;

const loadMonth = Effect.fn("Usage.loadMonth")(function* (workspaceId: string, month: UsageMonth) {
	const [place] = yield* query((db) =>
		db
			.select({ timeZone: workspace.timeZone })
			.from(workspace)
			.where(eq(workspace.id, workspaceId)),
	);
	const timeZone = place?.timeZone ?? DEFAULT_TIME_ZONE;
	const interruptedBefore = DateTime.toDate(
		DateTime.subtract(yield* DateTime.now, { minutes: INTERRUPTED_AFTER_MINUTES }),
	);
	const firstDay = `${month}-01`;
	const inMonth = and(
		eq(modelRequest.workspaceId, workspaceId),
		gte(modelRequest.startedAt, sql`(${firstDay}::timestamp at time zone ${timeZone})`),
		lt(
			modelRequest.startedAt,
			sql`((${firstDay}::date + interval '1 month')::timestamp at time zone ${timeZone})`,
		),
		or(ne(modelRequest.outcome, "started"), lt(modelRequest.startedAt, interruptedBefore)),
	);
	const byBots = eq(modelRequest.purpose, "bot-turn");
	const bySystemBots = ne(modelRequest.purpose, "bot-turn");
	const byPersonalAssistants = sql`exists (
		select 1 from ${bot}
		where ${bot.id} = ${modelRequest.botId} and ${bot.assistantOf} is not null
	)`;
	const usageColumns = {
		usd: sql<number>`coalesce(sum(${modelRequest.costUsd}), 0)`.mapWith(Number),
		// A failed request answered nothing, which providers don't charge for.
		// Any other request without a price might have cost something.
		unknownCostRequests:
			sql<number>`count(*) filter (where ${modelRequest.costUsd} is null and ${modelRequest.outcome} <> 'failed')`.mapWith(
				Number,
			),
	};
	const usageWhere = (where: SQL | undefined) =>
		query((db) => db.select(usageColumns).from(modelRequest).where(where)).pipe(
			Effect.map(([row]) => row ?? { usd: 0, unknownCostRequests: 0 }),
		);

	// One query at a time: inside a transaction the executor is one connection,
	// which runs them one after another anyway.
	const total = yield* usageWhere(inMonth);
	const systemBots = yield* usageWhere(and(inMonth, bySystemBots));
	const personalAssistants = yield* usageWhere(and(inMonth, byBots, byPersonalAssistants));
	const dayRows = yield* query((db) =>
		db
			.select({
				date: sql<string>`to_char(${modelRequest.startedAt} at time zone ${timeZone}, 'YYYY-MM-DD')`,
				usd: usageColumns.usd,
			})
			.from(modelRequest)
			.where(inMonth)
			// By position: the time zone is a parameter, and the same expression
			// written again would be a different one to Postgres.
			.groupBy(sql`1`),
	);
	const bots = yield* query((db) =>
		db
			.select({
				botId: modelRequest.botId,
				name: bot.name,
				color: bot.color,
				eyes: bot.eyes,
				shape: bot.shape,
				...usageColumns,
			})
			.from(modelRequest)
			.leftJoin(bot, eq(bot.id, modelRequest.botId))
			.where(and(inMonth, byBots, isNull(bot.assistantOf)))
			.groupBy(modelRequest.botId, bot.name, bot.color, bot.eyes, bot.shape),
	);
	const models = yield* query((db) =>
		db
			.select({
				model: modelRequest.model,
				displayName: providerModel.displayName,
				providerName: modelProvider.name,
				builtIn: modelRequest.builtIn,
				...usageColumns,
			})
			.from(modelRequest)
			.leftJoin(modelProvider, eq(modelProvider.id, modelRequest.providerId))
			.leftJoin(
				providerModel,
				and(
					eq(providerModel.providerId, modelRequest.providerId),
					eq(providerModel.modelId, modelRequest.model),
				),
			)
			.where(inMonth)
			.groupBy(
				modelRequest.model,
				modelRequest.providerId,
				modelRequest.builtIn,
				modelProvider.name,
				providerModel.displayName,
			),
	);
	const costByDay = new Map(dayRows.map((row) => [row.date, row.usd]));
	return {
		month,
		timeZone,
		...total,
		days: datesIn(month).map((date) => ({ date, usd: costByDay.get(date) ?? 0 })),
		bots: mostExpensiveFirst(
			bots.flatMap(({ botId, ...rest }) => (botId ? [{ botId, ...rest }] : [])),
		),
		models: mostExpensiveFirst(models),
		systemBots,
		personalAssistants,
	} satisfies WorkspaceUsage;
});

function mostExpensiveFirst<Row extends { usd: number; unknownCostRequests: number }>(
	rows: readonly Row[],
): Row[] {
	return rows.toSorted(
		(left, right) => right.usd - left.usd || right.unknownCostRequests - left.unknownCostRequests,
	);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Every date of `month`, as `YYYY-MM-DD`, first to last. */
function datesIn(month: UsageMonth): string[] {
	const [year = 0, monthNumber = 1] = month.split("-").map(Number);
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const days = monthNumber === 2 && leap ? 29 : (DAYS_IN_MONTH[monthNumber - 1] ?? 30);
	return Array.from(
		{ length: days },
		(_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
	);
}
