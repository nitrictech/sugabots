import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Files } from "../../files/files.ts";
import { proveCanManageChats } from "../../proofs/chat-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesFile } from "../../proofs/reaches-file.ts";
import { defineOperation } from "../operation.ts";

export const removeWrittenFile = defineOperation(
	chatsContracts["files.remove"],
	(principal, input) =>
		Effect.gen(function* () {
			const files = yield* Files.Service;
			return yield* named(principal, input.fileId.toLowerCase(), (principal, file) =>
				Effect.gen(function* () {
					const reach = yield* proveReachesFile(principal, file);
					const canManage = yield* proveCanManageChats(reach);
					return yield* files.remove(reach, canManage);
				}),
			);
		}),
);
