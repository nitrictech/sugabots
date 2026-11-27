import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { approvalRule, proveApprovedAsResolved } from "../../proofs/approved.ts";
import { briefRecipient, proveMayBrief } from "../../proofs/may-brief.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

export const startBriefedChat = defineOperation(
	chatsContracts["chats.startBriefedChat"],
	(principal, input, call) =>
		Effect.gen(function* () {
			if (principal._tag !== "BotForAsker") return yield* new ResourceHidden({ resource: "bot" });
			const chats = yield* Chats.Service;
			const recipient = yield* briefRecipient(principal, input.with);
			return yield* named(
				principal,
				recipient.id,
				call,
				input,
				(principal, bot, call, approvedInput) =>
					Effect.gen(function* () {
						const mayBrief = yield* proveMayBrief(principal, bot);
						if (recipient.model === null) return yield* new BotHasNoModel();
						// The handle is resolved again on each call, so an approval covers
						// the bot it named, and the project it chose, when it was given.
						const approved = yield* proveApprovedAsResolved(
							principal,
							call,
							approvalRule("chats.startBriefedChat"),
							approvedInput,
							{ bot: mayBrief.bot.value, project: mayBrief.project },
							bot,
						);
						return { chat: yield* chats.startBriefedChat(mayBrief, input, approved) };
					}),
			);
		}),
);
