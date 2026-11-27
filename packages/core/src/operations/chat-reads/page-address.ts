import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { FilePages } from "../../files/pages.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesFile } from "../../proofs/reaches-file.ts";
import { defineOperation } from "../operation.ts";

export const pageAddress = defineOperation(
	chatReadsContracts["files.pageAddress"],
	(principal, input) =>
		Effect.gen(function* () {
			const pages = yield* FilePages.Service;
			return yield* named(principal, input.fileId.toLowerCase(), (principal, file) =>
				Effect.gen(function* () {
					const reach = yield* proveReachesFile(principal, file);
					const url = yield* pages.address(reach, input.version);
					return { url: url ?? null };
				}),
			);
		}),
);
