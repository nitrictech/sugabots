/**
 * Who answers a call that waits for approval, by the first rule that fits.
 * `CanDecide` asks it of the member deciding, and `Approved` again of the
 * member who decided, when the call runs. It makes no proof.
 */

import { Effect } from "effect";
import { askerOf, type TurnFacts } from "../authentication/turn-facts.ts";
import { HOST_REQUEST_TOOL } from "../chats/tools/host-request/name.ts";
import { query } from "../database/database.ts";
import {
	administers,
	botRecord,
	managesBot,
	managesProject,
	memberReaches,
	reachFacts,
} from "./facts.ts";

/**
 * The approver rule for a call, by the first that fits.
 *
 * 1. `computerRequest`: a request to change a computer, such as a host
 *    request: those who may manage the computer's project.
 * 2. `assistant`: a Personal Assistant's call, or one in its runs: only its member.
 * 3. `run`: a call in an automation's run: admins and the managers of the
 *    run's bot, among those who reach its chat.
 * 4. `asker`: any other turn's call, a helper's included: its asker.
 */
export type ApproverRule = "computerRequest" | "assistant" | "run" | "asker";

/** The rule for a call to `tool` in the turn `facts` describe. */
export function approverRuleOf(facts: TurnFacts, tool: string): ApproverRule {
	if (asksToChangeComputer(tool)) return "computerRequest";
	if (facts.assistantOf !== null) return "assistant";
	if (facts.askedBy.kind === "automation" && facts.run) return "run";
	return "asker";
}

/** Whether `memberId` answers a call by `rule` in the turn, and whether they reach its chat. */
export const approverFacts = (memberId: string, facts: TurnFacts, rule: ApproverRule) =>
	Effect.gen(function* () {
		const reach = facts.project
			? yield* query((db) => reachFacts(db, facts.project ?? "", { member: memberId }))
			: undefined;
		const place = reach?.member;
		const reachesChat = reach !== undefined && memberReaches(place, reach.project);
		const approver = yield* Effect.gen(function* () {
			switch (rule) {
				case "computerRequest":
					return reach !== undefined && place !== undefined && managesProject(place, reach.project);
				case "assistant":
					return memberId === facts.assistantOf;
				case "run": {
					const runBot = facts.run && (yield* query((db) => botRecord(db, facts.run?.bot ?? "")));
					return (
						reachesChat &&
						place !== undefined &&
						(administers(place.actor) ||
							(runBot !== undefined && runBot !== null && managesBot(place.actor, runBot)))
					);
				}
				case "asker":
					return memberId === askerOf(facts);
			}
		});
		return { approver, reachesChat };
	});

/**
 * Whether a call to `tool` asks to change a computer. Until tools are
 * operations, whose manifest entries say so with their approvers, the host
 * request is the one tool that does. Compared when asked rather than kept in a
 * list built at load, which an import cycle can build before the name exists.
 */
function asksToChangeComputer(tool: string): boolean {
	return tool === HOST_REQUEST_TOOL;
}
