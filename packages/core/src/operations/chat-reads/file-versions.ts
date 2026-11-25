import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { Files } from "../../files/files.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesFile } from "../../proofs/reaches-file.ts";
import { defineOperation } from "../operation.ts";

export const fileVersions = defineOperation(
	chatReadsContracts["files.versions"],
	(principal, input) =>
		Effect.gen(function* () {
			const files = yield* Files.Service;
			return yield* named(principal, input.fileId.toLowerCase(), (principal, file) =>
				Effect.flatMap(proveReachesFile(principal, file), files.versions),
			);
		}),
);
