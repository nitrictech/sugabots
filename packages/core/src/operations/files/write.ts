import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { filesContracts } from "@sugabots/contracts/operations/files";
import { Effect } from "effect";
import { Files, newWrittenFile, writtenFileReplacement } from "../../files/files.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveCanChangeFile } from "../../proofs/can-change-file.ts";
import { proveCanChangeChat } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { proveReachesWrittenFile } from "../../proofs/reaches-file.ts";
import { defineOperation } from "../operation.ts";

export const write = defineOperation(filesContracts["files.write"], (principal, input, call) =>
	Effect.gen(function* () {
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun")
			return yield* writingForbidden();
		const files = yield* Files.Service;
		const rule = approvalRule("files.write");
		const { fileId } = input;
		if (!fileId) {
			// Refused before an approval is asked for a call that can't run.
			yield* newWrittenFile(input);
			return yield* named(
				principal,
				principal.chat,
				call,
				input,
				(principal, chat, call, approvedInput) =>
					Effect.gen(function* () {
						const canChange = yield* proveCanChangeChat(yield* proveReachesChat(principal, chat));
						const approved = yield* proveApproved(principal, call, rule, approvedInput, chat);
						return yield* files.create(canChange, approved);
					}),
			);
		}
		yield* writtenFileReplacement(input);
		return yield* named(
			principal,
			principal.chat,
			fileId.toLowerCase(),
			call,
			input,
			(principal, chat, file, call, approvedInput) =>
				Effect.gen(function* () {
					const working = yield* proveReachesChat(principal, chat);
					const reach = yield* proveReachesWrittenFile(principal, file);
					const canChange = yield* proveCanChangeFile(working, reach);
					const approved = yield* proveApproved(principal, call, rule, approvedInput, file);
					return yield* files.replace(canChange, approved);
				}),
		);
	}),
);

export const edit = defineOperation(filesContracts["files.edit"], (principal, input, call) =>
	Effect.gen(function* () {
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun")
			return yield* writingForbidden();
		const files = yield* Files.Service;
		return yield* named(
			principal,
			principal.chat,
			input.fileId.toLowerCase(),
			call,
			input,
			(principal, chat, file, call, approvedInput) =>
				Effect.gen(function* () {
					const working = yield* proveReachesChat(principal, chat);
					const reach = yield* proveReachesWrittenFile(principal, file);
					const canChange = yield* proveCanChangeFile(working, reach);
					const approved = yield* proveApproved(
						principal,
						call,
						approvalRule("files.edit"),
						approvedInput,
						file,
					);
					return yield* files.edit(canChange, approved);
				}),
		);
	}),
);

const writingForbidden = () => new ActionForbidden({ proof: "CanWriteFileInTurn" });
