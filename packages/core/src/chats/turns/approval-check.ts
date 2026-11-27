import type { DomainError } from "@sugabots/errors";
import { Effect } from "effect";
import { type ApprovalCheck, ApprovalCheckReached } from "../../operations/operation.ts";

/** Checks the other proofs before an operation reaches its Approved checkpoint. */
export const checkApproval = (run: (call: ApprovalCheck) => Effect.Effect<unknown, DomainError>) =>
	Effect.suspend(() =>
		run({ kind: "approvalCheck" }).pipe(
			Effect.matchEffect({
				onFailure: (error) =>
					Effect.succeed(error instanceof ApprovalCheckReached ? error.details : undefined),
				onSuccess: () =>
					Effect.die(new Error("Operation finished an approval check without proving Approved")),
			}),
		),
	);
