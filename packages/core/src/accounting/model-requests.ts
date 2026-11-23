export * as ModelRequests from "./model-requests.ts";

import type { RequestUsage, Usd } from "@sugabots/accounting";
import type { BuiltInProviderId } from "@sugabots/contracts";
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
							purpose: request.purpose.name,
							botId: "botId" in request.purpose ? request.purpose.botId : null,
							chatId: "chatId" in request.purpose ? request.purpose.chatId : null,
							turnId: "turnId" in request.purpose ? request.purpose.turnId : null,
							step: request.step,
							providerId: request.providerId,
							builtIn: request.builtIn,
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
 * What a model request was made for, which is whose usage it counts as.
 * Background work names the chat it served and no bot: it is never charged
 * to a bot that did not make it.
 */
export type RequestPurpose =
	| {
			readonly name: "bot-turn";
			readonly botId: string;
			readonly chatId: string;
			readonly turnId: string;
	  }
	| {
			readonly name: "compaction";
			readonly chatId: string;
			/** The system bot's own turn, in a chat of its own. */
			readonly turnId: string;
	  }
	/** Test questions put to a model before system bots run on it. */
	| { readonly name: "model-test" };

export type PurposeName = RequestPurpose["name"];

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
	readonly purpose: RequestPurpose;
	/** Which of its stream's requests this is, from zero. */
	readonly step: number;
	readonly providerId: string;
	readonly builtIn: BuiltInProviderId | null;
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
