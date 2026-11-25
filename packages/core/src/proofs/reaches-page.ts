import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, gte } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { query } from "../database/database.ts";
import { file, placedChat, project, workspace } from "../database/schema.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

export interface ReachesPage<P, F> extends Proof<"ReachesPage", [P, F]> {
	readonly file: Named<F, string>;
	readonly chat: string;
	readonly version: number;
}

const ReachesPageProof = defineProof("ReachesPage");

export const proveReachesPage = <P, F>(principal: Named<P, Principal>, fileId: Named<F, string>) =>
	Effect.gen(function* () {
		const address = principal.value;
		const hidden = new ResourceHidden({ resource: "file" });
		if (address._tag !== "PageAddress" || address.file !== fileId.value) return yield* hidden;
		if (address.expiresAt <= (yield* Clock.currentTimeMillis)) return yield* hidden;

		const [page] = yield* query((db) =>
			db
				.select({ chat: file.chatId })
				.from(file)
				.innerJoin(placedChat, eq(placedChat.id, file.chatId))
				.innerJoin(project, eq(project.id, placedChat.projectId))
				.innerJoin(workspace, eq(workspace.id, project.workspaceId))
				.where(
					and(
						eq(file.id, address.file),
						eq(file.kind, "html"),
						gte(file.currentVersion, address.version),
						eq(workspace.id, address.workspace),
						eq(workspace.deleting, false),
						eq(project.deleting, false),
					),
				),
		);
		if (!page) return yield* hidden;
		const proof: ReachesPage<P, F> = ReachesPageProof.prove([principal, fileId], {
			file: fileId,
			chat: page.chat,
			version: address.version,
		});
		return proof;
	});
