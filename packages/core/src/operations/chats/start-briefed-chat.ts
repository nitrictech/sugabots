import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { approvalRule, proveApprovedAsResolved } from "../../proofs/approved.ts";
import { withBriefRecipient } from "../../proofs/may-brief.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

export const startBriefedChat = defineOperation(
	chatsContracts["chats.startBriefedChat"],
	(principal, input, call) =>
		named(principal, call, input, (principal, call, approvedInput) =>
			withBriefRecipient(principal, { handle: input.with }, (mayBrief) =>
				Effect.gen(function* () {
					if (mayBrief.model === null) return yield* new BotHasNoModel();
					const chats = yield* Chats.Service;
					const approved = yield* proveApprovedAsResolved(
						principal,
						call,
						approvalRule("chats.startBriefedChat"),
						approvedInput,
						{ bot: mayBrief.bot.value, project: mayBrief.project },
						mayBrief.bot,
					);
					return { chat: yield* chats.startBriefedChat(mayBrief, approved) };
				}),
			),
		),
);
