import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { BotPrincipal } from "../principal.ts";
import { changesIn, proveCanChangeChat } from "./project-permissions.ts";
import { defineProof, named, type Proof } from "./proof.ts";
import { proveReachesChat, type ReachesChat } from "./reaches-chat.ts";
import type { ReachesFile } from "./reaches-file.ts";

export interface CanChangeFile<P, F> extends Proof<"CanChangeFile", [P, F]> {
	readonly reach: ReachesFile<P, F>;
}

const CanChangeFileProof = defineProof("CanChangeFile");

export const proveCanChangeFile = <P, C, F>(
	workingChat: ReachesChat<P, C>,
	reach: ReachesFile<P, F>,
): Effect.Effect<CanChangeFile<P, F>, ResourceHidden | ActionForbidden> => {
	if (workingChat.project.id !== reach.project.id) {
		return Effect.fail(new ResourceHidden({ resource: "file" }));
	}
	const acting = reach.principal.value;
	const actsForRun =
		acting._tag === "AutomationRun" || (acting._tag === "BotForAsker" && acting.askedByAutomation);
	if ((actsForRun && acting.chat !== reach.chat) || !changesIn(reach.as, reach.project)) {
		return Effect.fail(new ActionForbidden({ proof: "CanChangeFile" }));
	}
	const proof: CanChangeFile<P, F> = CanChangeFileProof.prove([reach.principal, reach.file], {
		reach,
	});
	return Effect.succeed(proof);
};

/** canWriteFilesInChat decides only whether to offer the file writing tools to principal. */
export const canWriteFilesInChat = (principal: BotPrincipal) =>
	named(principal, principal.chat, (principal, chat) =>
		proveReachesChat(principal, chat).pipe(
			Effect.flatMap(proveCanChangeChat),
			Effect.as(true),
			Effect.orElseSucceed(() => false),
		),
	);
