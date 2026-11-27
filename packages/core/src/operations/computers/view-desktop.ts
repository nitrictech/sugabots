import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Effect, Stream } from "effect";
import { DesktopViewer } from "../../chats/tools/browser/viewer.ts";
import { type ComputerUse, proveCanUseComputer } from "../../proofs/can-use-computer.ts";
import { named } from "../../proofs/proof.ts";
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
			const opened = yield* named(follower, found.id, input.botId, (principal, chat, bot) =>
				Effect.gen(function* () {
					const reach = yield* proveReachesChat(principal, chat).pipe(
						Effect.catchTag("BotCannotReach", () =>
							Effect.fail(new ResourceHidden({ resource: "chat" })),
						),
					);
					const computer = yield* viewer.openComputer(reach, bot);
					return yield* named(computer.id, (computerId) =>
						Effect.flatMap(proveCanUseComputer(reach, computerId), (canUse) =>
							Effect.map(viewer.show(computer, canUse), (desktop) => ({
								desktop,
								computerId: computer.id,
							})),
						),
					);
				}),
			);
			const use: ComputerUse = opened.desktop.control ? "control" : "watch";
			// Refused as it starts listening, the desktop opened is never handed on.
			const ended = yield* streams.keep({
				principal: follower,
				workspace: found.workspace,
				prove: named(follower, found.id, input.botId, (principal, chat, bot) =>
					Effect.gen(function* () {
						const reach = yield* proveReachesChat(principal, chat).pipe(
							Effect.catchTag("BotCannotReach", () =>
								Effect.fail(new ResourceHidden({ resource: "chat" })),
							),
						);
						const computer = yield* viewer.stillShown(reach, bot);
						if (computer !== opened.computerId)
							return yield* new ResourceHidden({ resource: "computer" });
						yield* named(computer, (computerId) =>
							Effect.asVoid(proveCanUseComputer(reach, computerId, use)),
						);
					}),
				),
			});
			return { stream: Stream.make(opened.desktop), ended };
		}),
);
