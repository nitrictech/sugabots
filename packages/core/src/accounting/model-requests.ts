export * as ModelRequests from "./model-requests.ts";

import type { RequestUsage, Usd } from "@sugabots/accounting";
import type { ProviderPresetId } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query, serviceOperations, writtenRow } from "../database/database.ts";
import { modelRequest } from "./sql.ts";

/**
 * The only writer of `model_request`: every request sent to a model provider.
 * A request is recorded before it goes out and again when it ends, so one the
 * process never saw the end of is still counted.
 */
export interface Interface {
	/** Records that a request is about to be sent, and returns its id. */
	readonly start: (request: Started) => Effect.Effect<string>;
	/** Records how a started request ended. */
	readonly finish: (id: string, ending: Ending) => Effect.Effect<void>;
}

/** The ledger's writes, which `Models` builds for itself. */
export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ModelRequests");
	return {
		start: (request) =>
			operation(
				"start",
				query((db) =>
					db
						.insert(modelRequest)
						.values({
							workspaceId: request.workspaceId,
							purpose: request.activity.purpose,
							podId: "podId" in request.activity ? request.activity.podId : null,
							agentId: "agentId" in request.activity ? request.activity.agentId : null,
							threadId: "threadId" in request.activity ? request.activity.threadId : null,
							turnId: "turnId" in request.activity ? request.activity.turnId : null,
							step: request.step,
							providerId: request.providerId,
							preset: request.preset,
							model: request.model,
							outcome: "started",
							startedAt: request.startedAt,
						})
						.returning({ id: modelRequest.id }),
				).pipe(
					Effect.flatMap(writtenRow("model_request")),
					Effect.map(({ id }) => id),
				),
			),
		finish: (id, ending) =>
			operation(
				"finish",
				query((db) =>
					db
						.update(modelRequest)
						.set({
							outcome: ending.outcome,
							inputTokens: ending.usage?.inputTokens ?? null,
							cacheReadTokens: ending.usage?.cacheReadTokens ?? null,
							cacheWriteTokens: ending.usage?.cacheWriteTokens ?? null,
							outputTokens: ending.usage?.outputTokens ?? null,
							reasoningTokens: ending.usage?.reasoningTokens ?? null,
							costUsd: ending.cost?.usd ?? null,
							costSource: ending.cost?.source ?? null,
							endedAt: ending.endedAt,
						})
						.where(eq(modelRequest.id, id)),
				),
			),
	} satisfies Interface;
});

/**
 * What a model request was made for, which is whose spend it is. System work
 * names the conversation it served and no agent: it is never charged to a bot
 * that did not make it.
 */
export type Activity =
	| {
			readonly purpose: "agent-turn";
			readonly podId: string;
			readonly agentId: string;
			readonly threadId: string;
			readonly turnId: string;
	  }
	| { readonly purpose: "facilitation"; readonly podId: string; readonly threadId: string }
	| {
			readonly purpose: "summary" | "compaction";
			readonly podId: string;
			readonly threadId: string;
			/** The system agent's own turn, in its child thread. */
			readonly turnId: string;
	  }
	/**
	 * Trying a model out from settings: a trial before giving it to a system
	 * agent, or checking that a provider's enabled model answers at all.
	 */
	| { readonly purpose: "trial" | "provider-check" };

export type Purpose = Activity["purpose"];

/**
 * Where a request got to. `started` until it ends; a request still `started`
 * long after it began was cut off when its process stopped.
 */
export type Outcome = "started" | Ending["outcome"];

/** What one request cost, and where the figure came from. */
export interface Cost {
	readonly usd: Usd;
	/**
	 * `provider-reported` when the provider said, `local` for a server the
	 * workspace runs itself, `subscription` for one paid for by a flat
	 * subscription, and otherwise the price registry's version.
	 */
	readonly source: string;
}

export interface Started {
	readonly workspaceId: string;
	readonly activity: Activity;
	/** Which of its stream's requests this is, from zero. */
	readonly step: number;
	readonly providerId: string;
	readonly preset: ProviderPresetId | null;
	/** The model id sent to the provider. */
	readonly model: string;
	readonly startedAt: Date;
}

export interface Ending {
	/** Only a completed request reports what it used. */
	readonly outcome: "completed" | "failed" | "aborted";
	/** Absent when the provider reported nothing. */
	readonly usage: RequestUsage | undefined;
	/** Absent when the request could not be priced, which is not the same as free. */
	readonly cost: Cost | undefined;
	readonly endedAt: Date;
}
