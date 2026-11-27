import { ActionForbidden, BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { TurnFacts } from "../authentication/turn-facts.ts";
import { type Executor, query } from "../database/database.ts";
import { computer, computerProvider, placedChat, project } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import {
	decideReach,
	type MemberPlace,
	mayInProjectAs,
	type ProjectFacts,
	reachFacts,
	turnChatPlace,
	useTurnAdmission,
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
	readonly chat: string;
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
		chat: reach.chat.value,
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
	/** The enabled provider, including before the project has a computer. */
	readonly provider: string | null;
	/** The turn working on it, and which execution of the turn: the step that opened the computer. */
	readonly turn: string;
	readonly executionNumber: number;
}

const CanUseChatComputerProof = defineProof("CanUseChatComputer");

export class ComputerUseOff extends ActionForbidden {}

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
		const as = decision.as;
		if (
			as.kind !== "run" &&
			(as.kind !== "asker" ||
				!mayInProjectAs(as.place, useTurnAdmission(acting, facts).project, "project.change"))
		) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanUseComputer" }));
		}
		if (!facts.bot?.usesComputer) {
			return yield* Effect.fail(new ComputerUseOff({ proof: "CanUseComputer" }));
		}
		const [target] = yield* query((db) =>
			db
				.select({
					id: computer.id,
					machine: computer.providerComputerId,
					provider: computerProvider.id,
				})
				.from(project)
				.leftJoin(computer, eq(computer.projectId, project.id))
				.leftJoin(
					computerProvider,
					and(eq(computerProvider.workspaceId, project.workspaceId), computerProvider.enabled),
				)
				.where(eq(project.id, facts.project.id))
				.limit(1),
		);
		const proof: CanUseChatComputer<P, C> = CanUseChatComputerProof.prove([principal, chatId], {
			principal,
			chat: chatId,
			workspace: facts.project.workspace,
			project: facts.project.id,
			computer: target?.id ?? null,
			machine: target?.machine ?? null,
			provider: target?.provider ?? null,
			turn: acting.turn,
			executionNumber: acting.executionNumber,
		});
		return proof;
	});

/** turnUsesComputer checks the turn's admission and the bot's current computer setting. */
export const turnUsesComputer = (db: Executor, facts: TurnFacts, projectId: string) =>
	Effect.gen(function* () {
		if (facts.project !== projectId) return false;
		const place = yield* turnChatPlace(db, facts);
		if (!place?.bot?.usesComputer) return false;
		return place.member
			? mayInProjectAs(place.member, place.project, "project.change")
			: facts.askedBy.kind === "automation";
	});
