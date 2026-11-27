import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { type Executor, query } from "../../../database/database.ts";
import { toolCall, turn } from "../../../database/schema.ts";
import { awaitsDecisions } from "../lifecycle.ts";
import { awaitsDecision } from "./lifecycle.ts";

export const readCurrentApproval = Effect.fn("readCurrentApproval")(function* (
	db: Executor,
	callId: string,
	approvalId: string,
	lock?: "update",
) {
	const current = db
		.select({
			call: toolCall,
			executionId: turn.executionId,
			executionNumber: turn.executionNumber,
			turn: { status: turn.status, endRequested: turn.endRequested },
		})
		.from(toolCall)
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.where(and(eq(toolCall.id, callId), eq(toolCall.approvalId, approvalId)))
		.limit(1);
	const [found] = yield* lock ? current.for(lock, { of: toolCall }) : current;
	if (!found || !awaitsDecisions(found.turn)) return undefined;
	return { ...found, pending: awaitsDecision(found.call) };
});

export const lockCurrentApproval = (callId: string, approvalId: string) =>
	Effect.gen(function* () {
		const [owner] = yield* query((db) =>
			db.select({ turnId: toolCall.turnId }).from(toolCall).where(eq(toolCall.id, callId)).limit(1),
		);
		if (!owner) return undefined;

		yield* query((db) =>
			db.select({ id: turn.id }).from(turn).where(eq(turn.id, owner.turnId)).for("update"),
		);
		return yield* query((db) => readCurrentApproval(db, callId, approvalId, "update"));
	});
