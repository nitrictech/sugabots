import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Actor } from "../authorization/permissions.ts";
import { query } from "../database/database.ts";
import { bot, membership, workspace } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P belongs to the workspace W: a member by their membership, with its role;
 * a bot acting for its asker by the asker's, with the bot in W too; any other
 * principal by the work, automation, signer or page it comes from.
 */
export interface InWorkspace<P, W> extends Proof<"InWorkspace", [P, W]> {
	readonly principal: Named<P, Principal>;
	readonly workspace: Named<W, string>;
	/**
	 * Whose role gives P workspace permissions: a member's own, or an asker's in
	 * member bounds. None for a bot in chat bounds or any other principal.
	 */
	readonly permissionsOf: Actor | undefined;
}

const InWorkspaceProof = defineProof("InWorkspace");

const hidden = new ResourceHidden({ resource: "workspace" });

export const proveInWorkspace = <P, W>(
	principal: Named<P, Principal>,
	workspaceId: Named<W, string>,
) =>
	Effect.gen(function* () {
		const acting = principal.value;
		const id = workspaceId.value;
		if (!isUuid(id)) return yield* Effect.fail(hidden);
		const member =
			acting._tag === "MemberSession"
				? acting.member
				: acting._tag === "BotForAsker"
					? acting.asker
					: undefined;
		if (acting._tag !== "MemberSession" && acting.workspace !== id) {
			return yield* Effect.fail(hidden);
		}
		const botId = acting._tag === "BotForAsker" ? acting.bot : null;
		const [row] = yield* query((db) =>
			db
				.select({
					role: membership.role,
					botInWorkspace: sql<boolean>`${botId}::uuid is null or exists (
						select 1 from ${bot} where ${bot.id} = ${botId}::uuid and ${bot.workspaceId} = ${workspace.id}
					)`,
				})
				.from(workspace)
				.leftJoin(
					membership,
					and(
						eq(membership.workspaceId, workspace.id),
						eq(membership.memberId, sql`${member ?? null}::uuid`),
					),
				)
				.where(eq(workspace.id, id))
				.limit(1),
		);
		if (!row?.botInWorkspace) return yield* Effect.fail(hidden);
		if (member !== undefined && !row.role) return yield* Effect.fail(hidden);
		const givesPermissions =
			acting._tag === "MemberSession" ||
			(acting._tag === "BotForAsker" && acting.bounds.kind === "member");
		const proof: InWorkspace<P, W> = InWorkspaceProof.prove([principal, workspaceId], {
			principal,
			workspace: workspaceId,
			permissionsOf:
				givesPermissions && member && row.role
					? { memberId: member, workspaceRole: row.role }
					: undefined,
		});
		return proof;
	});
