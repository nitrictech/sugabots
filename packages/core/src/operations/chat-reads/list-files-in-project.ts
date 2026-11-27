import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { Files } from "../../files/files.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { defineOperation } from "../operation.ts";

export const listFilesInProject = defineOperation(
	chatReadsContracts["files.listInProject"],
	(principal, input) =>
		Effect.gen(function* () {
			const files = yield* Files.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.flatMap(proveReachesProject(principal, project), files.listInProject),
			);
		}),
);
