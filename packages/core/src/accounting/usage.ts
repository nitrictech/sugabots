export * as Usage from "./usage.ts";

import {
	DEFAULT_TIME_ZONE,
	type UsageMonth,
	type UsageQuery,
	type WorkspaceUsage,
} from "@sugabots/contracts";
import { and, eq, gte, inArray, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { query, serviceOperations } from "../database/database.ts";
import {
	agent,
	modelProvider,
	modelRequest,
	pod,
	providerModel,
	workspace,
} from "../database/schema.ts";

/** What a workspace's models cost, from the request ledger. */
export interface Interface {
	/**
	 * One month's spend in a workspace named by its id or its slug, with the
	 * month and its days in the workspace's time zone. It shows every pod's and every bot's
	 * spend, so it takes the current actor's `workspace.usage.manage`.
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
 * left out rather than counted as unpriced.
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
	const byBots = eq(modelRequest.purpose, "agent-turn");
	const bySystemAgents = ne(modelRequest.purpose, "agent-turn");
	const spend = {
		usd: sql<number>`coalesce(sum(${modelRequest.costUsd}), 0)`.mapWith(Number),
		// A failed request answered nothing, which providers don't charge for.
		// Any other request without a price might have cost something.
		unpricedRequests:
			sql<number>`count(*) filter (where ${modelRequest.costUsd} is null and ${modelRequest.outcome} <> 'failed')`.mapWith(
				Number,
			),
	};
	const spendWhere = (where: SQL | undefined) =>
		query((db) => db.select(spend).from(modelRequest).where(where)).pipe(
			Effect.map(([row]) => row ?? { usd: 0, unpricedRequests: 0 }),
		);

	// One query at a time: inside a transaction the executor is one connection,
	// which runs them one after another anyway.
	const total = yield* spendWhere(inMonth);
	const systemAgents = yield* spendWhere(and(inMonth, bySystemAgents));
	const dayRows = yield* query((db) =>
		db
			.select({
				date: sql<string>`to_char(${modelRequest.startedAt} at time zone ${timeZone}, 'YYYY-MM-DD')`,
				usd: spend.usd,
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
				agentId: modelRequest.agentId,
				name: agent.name,
				color: agent.color,
				face: agent.face,
				podName: pod.name,
				...spend,
			})
			.from(modelRequest)
			.leftJoin(agent, eq(agent.id, modelRequest.agentId))
			.leftJoin(pod, eq(pod.id, agent.podId))
			.where(and(inMonth, byBots))
			.groupBy(modelRequest.agentId, agent.name, agent.color, agent.face, pod.name),
	);
	const models = yield* query((db) =>
		db
			.select({
				model: modelRequest.model,
				displayName: providerModel.displayName,
				providerName: modelProvider.name,
				preset: modelRequest.preset,
				...spend,
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
				modelRequest.preset,
				modelProvider.name,
				providerModel.displayName,
			),
	);
	const pods = yield* query((db) =>
		db
			.select({ podId: modelRequest.podId, name: pod.name, color: pod.color, ...spend })
			.from(modelRequest)
			.leftJoin(pod, eq(pod.id, modelRequest.podId))
			.where(and(inMonth, byBots))
			.groupBy(modelRequest.podId, pod.name, pod.color),
	);
	const podIds = pods.flatMap(({ podId }) => (podId ? [podId] : []));
	const botCounts =
		podIds.length === 0
			? []
			: yield* query((db) =>
					db
						.select({ podId: agent.podId, bots: sql<number>`count(*)`.mapWith(Number) })
						.from(agent)
						.where(and(inArray(agent.podId, podIds), isNull(agent.systemAgentKey)))
						.groupBy(agent.podId),
				);

	const spentByDay = new Map(dayRows.map((row) => [row.date, row.usd]));
	const botsIn = new Map(botCounts.map((row) => [row.podId, row.bots]));
	return {
		month,
		timeZone,
		...total,
		days: datesIn(month).map((date) => ({ date, usd: spentByDay.get(date) ?? 0 })),
		bots: mostExpensiveFirst(
			bots.flatMap(({ agentId, ...rest }) => (agentId ? [{ agentId, ...rest }] : [])),
		),
		models: mostExpensiveFirst(models),
		pods: mostExpensiveFirst(
			pods.flatMap(({ podId, ...rest }) =>
				podId ? [{ podId, ...rest, botCount: botsIn.get(podId) ?? 0 }] : [],
			),
		),
		systemAgents,
	} satisfies WorkspaceUsage;
});

function mostExpensiveFirst<Row extends { usd: number; unpricedRequests: number }>(
	rows: readonly Row[],
): Row[] {
	return rows.toSorted(
		(left, right) => right.usd - left.usd || right.unpricedRequests - left.unpricedRequests,
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
