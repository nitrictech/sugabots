import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import type { Database } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { segmentTurnOwner } from "./owner.ts";
import type { ClaimedTurn, TurnCheckpoint } from "./store.ts";
import type { SegmentOutcome } from "./turn.workflow.ts";

const claim = (attempts: number): ClaimedTurn => ({
	owner: "turn/thread/agent/message",
	threadId: "thread",
	payload: { agentId: "agent", triggerMessageId: "message" },
	attempts,
});

/** What the segment returns after `tell` reports how it ended. */
const outcomeAfter = (
	tell: (owner: ReturnType<typeof segmentTurnOwner>) => Effect.Effect<unknown, never, Database>,
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const outcome = yield* Ref.make<SegmentOutcome>({ _tag: "Finished" });
			const told = yield* tell(segmentTurnOwner(outcome));
			return { told, outcome: yield* Ref.get(outcome) };
		}).pipe(Effect.provide(noDatabase)),
	);

describe("a turn workflow segment's owner", () => {
	it("runs a retryable failure again until its third attempt", async () => {
		expect(await outcomeAfter((owner) => owner.failed(claim(2), "down", true))).toEqual({
			told: true,
			outcome: { _tag: "Retry" },
		});
		expect(await outcomeAfter((owner) => owner.failed(claim(3), "down", true))).toEqual({
			told: false,
			outcome: { _tag: "Finished" },
		});
		expect(await outcomeAfter((owner) => owner.failed(claim(1), "down", false))).toEqual({
			told: false,
			outcome: { _tag: "Finished" },
		});
	});

	it("waits for the batch of approvals the checkpoint names", async () => {
		const checkpoint = {
			approvals: [{ approvalId: "approval-1" }, { approvalId: "approval-2" }],
		} as TurnCheckpoint;

		const after = await outcomeAfter((owner) => owner.suspended(claim(1), checkpoint));

		expect(after.outcome).toEqual({ _tag: "Suspended", approvals: "approval-1" });
	});
});
