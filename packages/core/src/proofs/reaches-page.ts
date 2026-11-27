import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, gte } from "drizzle-orm";
import { Clock, Effect } from "effect";
import { query } from "../database/database.ts";
import { file, placedChat } from "../database/schema.ts";
import type { Principal } from "../principal.ts";
import { memberReaches, reachFacts } from "./facts.ts";
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
		if (address._tag !== "PageAddress" || address.file !== fileId.value || address.version < 1)
			return yield* hidden;
		if (address.expiresAt <= (yield* Clock.currentTimeMillis)) return yield* hidden;

		const [page] = yield* query((db) =>
			db
				.select({ chat: file.chatId, project: placedChat.projectId })
				.from(file)
				.innerJoin(placedChat, eq(placedChat.id, file.chatId))
				.where(
					and(
						eq(file.id, address.file),
						eq(file.kind, "html"),
						gte(file.currentVersion, address.version),
					),
				),
		);
		if (!page?.project) return yield* hidden;
		const projectId = page.project;
		const facts = yield* query((db) => reachFacts(db, projectId, { member: address.member }));
		if (
			!facts ||
			facts.project.workspace !== address.workspace ||
			!memberReaches(facts.member, facts.project)
		) {
			return yield* hidden;
		}
		const proof: ReachesPage<P, F> = ReachesPageProof.prove([principal, fileId], {
			file: fileId,
			chat: page.chat,
			version: address.version,
		});
		return proof;
	});
