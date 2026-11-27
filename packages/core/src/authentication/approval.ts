import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { authenticated } from "../principal.ts";
import { turnBounds, turnFacts } from "./turn-facts.ts";

/** principalForApprovalCheck uses the approver's current permissions and leaves the turn's admission untouched. */
export const principalForApprovalCheck = (
	turnId: string,
	member: string,
	executionNumber: number,
) =>
	Effect.gen(function* () {
		const facts = yield* query((db) => turnFacts(db, turnId));
		if (!facts?.project) return yield* new ActionForbidden({ proof: "CanDecide" });
		return authenticated.botForAsker({
			workspace: facts.workspace,
			bot: facts.bot,
			asker: member,
			askedByAutomation: facts.askedBy.kind === "automation",
			chat: facts.chat,
			turn: facts.turn,
			executionNumber,
			admission: null,
			bounds: turnBounds(facts, member, facts.project),
		});
	});
