import { ActionForbidden, BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { TurnFacts } from "../authentication/turn-facts.ts";
import { type Executor, query } from "../database/database.ts";
import { computer, placedChat } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import {
	decideReach,
	type MemberPlace,
	mayInProjectAs,
	type ProjectFacts,
	type ReachedAs,
	type ReachFacts,
	reachFacts,
	turnChatPlace,
	whoActs,
} from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { ReachesChat } from "./reaches-chat.ts";

/**
 * How a member uses a computer's desktop: watching it, or taking it over to
 * click and type. A bot always works on it.
 */
export type ComputerUse = "watch" | "control";

/**
 * P may view the desktop on computer M. Taking over needs
 * `computer.desktop.use` in its project.
 */
export interface CanUseComputer<P, M> extends Proof<"CanUseComputer", [P, M]> {
	readonly computer: Named<M, string>;
	readonly control: boolean;
}

const CanUseComputerProof = defineProof("CanUseComputer");

/**
 * Whether the member at `place`, who reaches the project, may take its
 * computer's desktop over to click and type, rather than only watch it.
 */
export function takesOverDesktop(place: MemberPlace, project: ProjectFacts): boolean {
	return mayInProjectAs(place, project, "computer.desktop.use");
}

export const proveCanUseComputer = <P, C, M>(
	reach: ReachesChat<P, C>,
	computerId: Named<M, string>,
	use?: ComputerUse,
): Effect.Effect<CanUseComputer<P, M>, ActionForbidden> => {
	if (reach.as.kind !== "member")
		return Effect.fail(new ActionForbidden({ proof: "CanUseComputer" }));
	const mayControl = takesOverDesktop(reach.as.place, reach.project);
	if (use === "control" && !mayControl) {
		return Effect.fail(new ActionForbidden({ proof: "CanUseComputer" }));
	}
	const proof: CanUseComputer<P, M> = CanUseComputerProof.prove([reach.principal, computerId], {
		computer: computerId,
		control: use !== "watch" && mayControl,
	});
	return Effect.succeed(proof);
};

/**
 * P, a bot in a turn in the chat C, may work on the computer of C's project:
 * `CanUseComputer` for a bot, proved about the chat the turn works in rather
 * than a computer, since a project's computer is made on its first use. A
 * personal computer would be proved apart: none exists yet.
 */
export interface CanUseChatComputer<P, C> extends Proof<"CanUseChatComputer", [P, C]> {
	readonly principal: Named<P, Principal>;
	readonly chat: Named<C, string>;
	/** C's workspace and project, whose computer it is, which services take from here. */
	readonly workspace: string;
	readonly project: string;
	/**
	 * The project's computer as this was proved, or null before one is made.
	 * Resetting a computer replaces it with another, so an approval to work
	 * on one doesn't cover its replacement.
	 */
	readonly computer: string | null;
	/**
	 * The provider's id for the machine `computer` was on as this was proved,
	 * or null before one is made. Its provider may recover or upgrade a
	 * computer onto a new machine under the same record, and an approval to
	 * work on one machine doesn't cover another.
	 */
	readonly machine: string | null;
	/** The turn working on it, and which execution of the turn: the step that opened the computer. */
	readonly turn: string;
	readonly executionNumber: number;
}

const CanUseChatComputerProof = defineProof("CanUseChatComputer");

/**
 * Proves a bot's turn may work on its chat's project's computer: only the
 * turn's own chat, within its bounds, with the bot's computer use on and, for
 * a bot acting for its asker, an asker who may change things there, so a
 * viewer's bot gets no computer.
 */
export const proveCanUseChatComputer = <P, C>(
	principal: Named<P, Principal>,
	chatId: Named<C, string>,
) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "computer" });
		const acting = principal.value;
		const id = chatId.value;
		if (acting._tag !== "BotForAsker" && acting._tag !== "AutomationRun") {
			return yield* Effect.fail(hidden);
		}
		// A turn works on the computer of the chat it is in, and no other.
		if (acting.chat !== id || !isUuid(id)) return yield* Effect.fail(hidden);
		const chatsProject = sql`(select ${placedChat.projectId} from ${placedChat} where ${placedChat.id} = ${id}::uuid)`;
		const facts = yield* query((db) => reachFacts(db, chatsProject, whoActs(acting)));
		if (!facts) return yield* Effect.fail(hidden);
		const decision = decideReach(acting, facts, id);
		if (decision.kind === "hidden") return yield* Effect.fail(hidden);
		if (decision.kind === "botCannotReach") {
			return yield* Effect.fail(new BotCannotReach({ resource: "computer" }));
		}
		if (!botUsesComputer(decision.as, facts)) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanUseComputer" }));
		}
		const [made] = yield* query((db) =>
			db
				.select({ id: computer.id, machine: computer.providerComputerId })
				.from(computer)
				.where(eq(computer.projectId, facts.project.id))
				.limit(1),
		);
		const proof: CanUseChatComputer<P, C> = CanUseChatComputerProof.prove([principal, chatId], {
			principal,
			chat: chatId,
			workspace: facts.project.workspace,
			project: facts.project.id,
			computer: made?.id ?? null,
			machine: made?.machine ?? null,
			turn: acting.turn,
			executionNumber: acting.executionNumber,
		});
		return proof;
	});

/**
 * Whether the turn `facts` describe may still work on the computer of the
 * project `projectId`, as `proveCanUseChatComputer` would decide for its
 * principal now: the project is its chat's, it still reaches the chat, its bot
 * still has computer use on and, acting for an asker, the asker may still
 * change things there.
 */
export const turnUsesComputer = (db: Executor, facts: TurnFacts, projectId: string) =>
	Effect.gen(function* () {
		if (facts.project !== projectId) return false;
		const place = yield* turnChatPlace(db, facts);
		if (!place?.bot?.usesComputer) return false;
		if (facts.askedBy.kind === "automation") return true;
		return (
			place.member !== undefined && mayInProjectAs(place.member, place.project, "project.change")
		);
	});

/**
 * Whether a bot reaching the project `facts` describe, as `as`, may work on
 * its computer: with its computer use on, and acting for an asker, one who
 * may change things there. A run may whatever its bot reaches.
 */
function botUsesComputer(as: ReachedAs, facts: ReachFacts): boolean {
	if (!facts.bot?.usesComputer) return false;
	switch (as.kind) {
		case "asker":
			return mayInProjectAs(as.place, facts.project, "project.change");
		case "run":
			return true;
		default:
			return false;
	}
}
