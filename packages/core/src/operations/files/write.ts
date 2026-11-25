import { InvalidFileWrite } from "@sugabots/contracts/errors/files";
import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { filesContracts } from "@sugabots/contracts/operations/files";
import { Effect } from "effect";
import { Files } from "../../files/files.ts";
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
		const { fileId, kind, title, baseVersion, content } = input;
		if (!fileId) {
			if (kind === undefined || title === undefined) {
				return yield* new InvalidFileWrite({ missing: "kindAndTitle" });
			}
			return yield* named(principal, principal.chat, call, (principal, chat, call) =>
				Effect.gen(function* () {
					const canChange = yield* proveCanChangeChat(yield* proveReachesChat(principal, chat));
					const approved = yield* proveApproved(principal, call, rule, input);
					return yield* files.create(canChange, approved, { kind, title, content });
				}),
			);
		}
		if (baseVersion === undefined) return yield* new InvalidFileWrite({ missing: "baseVersion" });
		return yield* named(
			principal,
			principal.chat,
			fileId.toLowerCase(),
			call,
			(principal, chat, file, call) =>
				Effect.gen(function* () {
					const working = yield* proveReachesChat(principal, chat);
					const reach = yield* proveReachesWrittenFile(principal, file);
					const canChange = yield* proveCanChangeFile(working, reach);
					const approved = yield* proveApproved(principal, call, rule, input);
					return yield* files.replace(canChange, approved, {
						baseVersion,
						content,
						...(title !== undefined && { title }),
						...(kind !== undefined && { kind }),
					});
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
			(principal, chat, file, call) =>
				Effect.gen(function* () {
					const working = yield* proveReachesChat(principal, chat);
					const reach = yield* proveReachesWrittenFile(principal, file);
					const canChange = yield* proveCanChangeFile(working, reach);
					const approved = yield* proveApproved(principal, call, approvalRule("files.edit"), input);
					return yield* files.edit(canChange, approved, input);
				}),
		);
	}),
);

const writingForbidden = () => new ActionForbidden({ proof: "CanWriteFileInTurn" });
