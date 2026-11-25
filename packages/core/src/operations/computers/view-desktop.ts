import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect, Stream } from "effect";
import { DesktopViewer } from "../../chats/tools/browser/viewer.ts";
import type { Principal } from "../../principal.ts";
import { type ComputerUse, proveCanUseComputer } from "../../proofs/can-use-computer.ts";
import { type Named, named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { Streams } from "../../streams/streams.ts";
import { followerOf } from "../events/following.ts";
import { defineLongRunningOperation } from "../operation.ts";

/**
 * The desktop viewer: a long-running operation, which proves again, naming
 * its values afresh, each time who reaches what changes, and ends once the
 * member may no longer see the desktop as it was opened for them. Watching
 * needs reach; taking over needs permission to change things there, which
 * the member gets when they may.
 */
export const viewDesktop = defineLongRunningOperation(
	computersContracts["computers.viewDesktop"],
	(principal, input) =>
		Effect.gen(function* () {
			const viewer = yield* DesktopViewer.Service;
			const streams = yield* Streams.Service;
			const follower = yield* followerOf(principal);
			const found = yield* streams.chatOf(input.chatId);
			if (found === undefined) return yield* new ResourceHidden({ resource: "chat" });
			const opened = yield* named(principal, found.id, input.botId, (principal, chat, bot) =>
				Effect.gen(function* () {
					const computer = yield* viewer.openComputer(
						yield* proveReachesChat(principal, chat),
						yield* proveReachesBot(principal, bot),
					);
					return yield* named(computer.id, (computerId) =>
						Effect.flatMap(mostUse(principal, computerId), (canUse) =>
							viewer.show(computer, canUse),
						),
					);
				}),
			);
			const use: ComputerUse = opened.control ? "control" : "watch";
			// Refused as it starts listening, the desktop opened is never handed on.
			const ended = yield* streams.keep({
				principal: follower,
				workspace: found.workspace,
				prove: named(principal, found.id, input.botId, (principal, chat, bot) =>
					Effect.gen(function* () {
						const computer = yield* viewer.stillShown(
							yield* proveReachesChat(principal, chat),
							yield* proveReachesBot(principal, bot),
						);
						yield* named(computer, (computerId) =>
							Effect.asVoid(proveCanUseComputer(principal, computerId, use)),
						);
					}),
				),
			});
			return { stream: Stream.make(opened), ended };
		}),
);

/** Taking the computer over where the principal may, else watching it. */
const mostUse = <P, M>(principal: Named<P, Principal>, computer: Named<M, string>) =>
	proveCanUseComputer(principal, computer, "control").pipe(
		Effect.catchIf(
			(refusal): refusal is ActionForbidden => refusal instanceof ActionForbidden,
			() => proveCanUseComputer(principal, computer, "watch"),
		),
	);
