import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import { askerOf, turnFacts } from "../authentication/turn-facts.ts";
import { query } from "../database/database.ts";
import type { Principal } from "../principal.ts";
import { approverFacts } from "./approvers.ts";
import { managesProject, memberActing } from "./facts.ts";
import type { IsMember } from "./is-member.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { ReachesChat } from "./reaches-chat.ts";

/**
 * Who may steer or interrupt a turn, decided from the turn once its chat is
 * proven reachable. Only its asker steers it, so nobody steers a run's turns,
 * but a personal bot's creator steers those of its runs. Its asker may
 * interrupt it, and so may anyone who may manage its project and reaches its
 * chat, and, for a run's turn, anyone who may approve its calls; interrupting
 * takes a member.
 */

/** P is the turn T's asker, so a message P writes there steers it. */
export interface CanSteer<P, T> extends Proof<"CanSteer", [P, T]> {
	readonly principal: Named<P, Principal>;
	readonly turn: Named<T, string>;
}

/** P is a member who may interrupt the turn T. */
export interface CanInterrupt<P, T> extends Proof<"CanInterrupt", [P, T]> {
	readonly principal: Named<P, Principal>;
	readonly turn: Named<T, string>;
}

const CanSteerProof = defineProof("CanSteer");
const CanInterruptProof = defineProof("CanInterrupt");

/** The turn `turnId`, if it is in the chat `reach` proves. */
const turnInChat = <P, C>(reach: ReachesChat<P, C>, turnId: string) =>
	Effect.gen(function* () {
		const facts = yield* query((db) => turnFacts(db, turnId));
		if (!facts || facts.chat !== reach.chat.value) {
			return yield* Effect.fail(new ResourceHidden({ resource: "turn" }));
		}
		return facts;
	});

export const proveCanSteer = <P, C, T>(reach: ReachesChat<P, C>, turnId: Named<T, string>) =>
	Effect.gen(function* () {
		const facts = yield* turnInChat(reach, turnId.value);
		const acting = reach.principal.value;
		// A run's turns act for no member, so nobody steers them; a personal
		// bot's runs act for its creator, who may.
		if (acting._tag !== "MemberSession" || acting.member !== askerOf(facts)) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanSteer" }));
		}
		const proof: CanSteer<P, T> = CanSteerProof.prove([reach.principal, turnId], {
			principal: reach.principal,
			turn: turnId,
		});
		return proof;
	});

export const proveCanInterrupt = <P, C, T>(
	isMember: IsMember<P>,
	reach: ReachesChat<P, C>,
	turnId: Named<T, string>,
) =>
	Effect.gen(function* () {
		const facts = yield* turnInChat(reach, turnId.value);
		const { member } = isMember;
		const place = memberActing(reach.as);
		const asksIt = member === askerOf(facts);
		const managesIt = place !== undefined && managesProject(place, reach.project);
		const approvesIt =
			facts.askedBy.kind === "automation" &&
			facts.run !== null &&
			(yield* approverFacts(member, facts)).approver;
		if (!asksIt && !managesIt && !approvesIt) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanInterrupt" }));
		}
		const proof: CanInterrupt<P, T> = CanInterruptProof.prove([reach.principal, turnId], {
			principal: reach.principal,
			turn: turnId,
		});
		return proof;
	});
