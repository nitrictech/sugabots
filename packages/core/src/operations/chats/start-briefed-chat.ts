import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { approvalRule, proveApprovedAsResolved } from "../../proofs/approved.ts";
import { withBriefRecipient } from "../../proofs/may-brief.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation, sameResolvedTargets } from "../operation.ts";

export const startBriefedChat = defineOperation(
	chatsContracts["chats.startBriefedChat"],
	(principal, input, call) =>
		named(principal, call, input, (principal, call, approvedInput) =>
			withBriefRecipient(principal, { handle: input.with }, (mayBrief) =>
				Effect.gen(function* () {
					const resolvedTargets = {
						bot: mayBrief.bot.value,
						project: mayBrief.project,
						briefBotName: mayBrief.name,
						briefProjectName: mayBrief.projectName,
					};
					const decision = call.value.kind === "approvalCheck" ? call.value.forDecision : undefined;
					if (
						(!decision || sameResolvedTargets(decision.recordedTargets, resolvedTargets)) &&
						mayBrief.model === null
					)
						return yield* new BotHasNoModel();
					const approved = yield* proveApprovedAsResolved(
						principal,
						call,
						approvalRule("chats.startBriefedChat"),
						approvedInput,
						resolvedTargets,
						mayBrief.bot,
					);
					const chats = yield* Chats.Service;
					return { chat: yield* chats.startBriefedChat(mayBrief, approved) };
				}),
			),
		),
);
