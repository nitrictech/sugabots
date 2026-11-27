import type { ListedWrittenFile } from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { filesContracts } from "@sugabots/contracts/operations/files";
import { Effect } from "effect";
import { Files } from "../../files/files.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { proveReachesWrittenFile } from "../../proofs/reaches-file.ts";
import { defineOperation } from "../operation.ts";

export const listWritten = defineOperation(
	filesContracts["files.listWritten"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const files = yield* Files.Service;
			if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
				return yield* new ResourceHidden({ resource: "chat" });
			}
			return yield* named(
				principal,
				principal.chat,
				call,
				input,
				(principal, chat, call, approvedInput) =>
					Effect.gen(function* () {
						const reach = yield* proveReachesChat(principal, chat);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("files.listWritten"),
							approvedInput,
							chat,
						);
						const written = yield* files.listWritten(reach, approved);
						return { files: written.map(listing) };
					}),
			);
		}),
);

export const readWritten = defineOperation(
	filesContracts["files.readWritten"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const files = yield* Files.Service;
			return yield* named(
				principal,
				input.fileId.toLowerCase(),
				call,
				input,
				(principal, file, call, approvedInput) =>
					Effect.gen(function* () {
						const reach = yield* proveReachesWrittenFile(principal, file);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("files.readWritten"),
							approvedInput,
							file,
						);
						const written = yield* files.readWritten(reach, approved);
						return { status: "found" as const, ...listing(written), content: written.content };
					}),
			);
		}),
);

const listing = ({ id, kind, title, version, updatedAt }: ListedWrittenFile) => ({
	fileId: id,
	kind,
	title,
	version,
	updatedAt,
});
