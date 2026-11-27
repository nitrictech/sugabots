import { filesContracts } from "@sugabots/contracts/operations/files";
import { Effect } from "effect";
import { Files } from "../../files/files.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesPage } from "../../proofs/reaches-page.ts";
import { defineOperation } from "../operation.ts";

export const servePage = defineOperation(filesContracts["files.servePage"], (principal, input) =>
	Effect.gen(function* () {
		const files = yield* Files.Service;
		return yield* named(principal, input.fileId, (principal, file) =>
			Effect.flatMap(proveReachesPage(principal, file), files.servePage),
		);
	}),
);
