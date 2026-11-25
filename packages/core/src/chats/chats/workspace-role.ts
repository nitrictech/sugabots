import { handleFromName, type WorkspaceRole } from "@sugabots/contracts";
import type { OutputOf } from "@sugabots/contracts/operations";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
	rolesGrantedInWorkspace,
	type WorkspacePermission,
} from "../../authorization/permissions.ts";
import { type Database, query } from "../../database/database.ts";
import { chatParticipant, member, membership } from "../../database/schema.ts";

import type { Approved } from "../../proofs/approved.ts";
import type { ReachesChat } from "../../proofs/reaches-chat.ts";

const MAX_HELPERS = 5;
type WorkspaceRoleResult = OutputOf<"chats.workspaceRole">;
type MemberRole = Extract<WorkspaceRoleResult, { member: unknown }>["member"];

export const lookUpWorkspaceRole = Effect.fn("ChatMembership.lookUpWorkspaceRole")(function* <
	P,
	C,
	X,
>(
	reach: ReachesChat<P, C>,
	handle: string,
	_approved: Approved<P, X>,
): Effect.fn.Return<WorkspaceRoleResult, never, Database> {
	const { chat, workspace } = reach;
	const members = yield* query((db) =>
		db
			.select({ name: member.name, role: membership.role })
			.from(chatParticipant)
			.innerJoin(member, eq(member.id, chatParticipant.memberId))
			.leftJoin(
				membership,
				and(
					eq(membership.memberId, member.id),
					eq(membership.workspaceId, workspace),
					eq(membership.leaving, false),
				),
			)
			.where(eq(chatParticipant.chatId, chat.value))
			.orderBy(asc(chatParticipant.createdAt)),
	);
	const asked = handle.trim().replace(/^@/, "").toLowerCase();
	const found = members.find((candidate) => handleFromName(candidate.name) === asked);
	if (!found) {
		const handles = members.map((candidate) => `@${handleFromName(candidate.name)}`);
		return {
			refused: `Nobody in this chat has the handle @${asked}. The members here are: ${handles.join(", ") || "nobody"}.`,
		};
	}
	const changedBy = rolesThatChange(found.role);
	if (changedBy.length === 0) return { member: memberAccess(found), canHelp: [], more: false };
	const helpers = yield* query((db) =>
		db
			.select({ name: member.name, role: membership.role })
			.from(membership)
			.innerJoin(member, eq(member.id, membership.memberId))
			.where(
				and(
					eq(membership.workspaceId, workspace),
					inArray(membership.role, changedBy),
					eq(membership.leaving, false),
				),
			)
			.orderBy(sql`${membership.role} = 'owner' desc`, asc(membership.createdAt))
			// One more than is returned, to tell whether there are more.
			.limit(MAX_HELPERS + 1),
	);
	return {
		member: memberAccess(found),
		canHelp: helpers.slice(0, MAX_HELPERS).map(memberAccess),
		more: helpers.length > MAX_HELPERS,
	};
});

/** The roles that may change what someone with `role` may do, or invite back someone without one. */
function rolesThatChange(role: WorkspaceRole | null): WorkspaceRole[] {
	const permission = permissionToChange(role);
	return permission ? rolesGrantedInWorkspace(permission) : [];
}

function permissionToChange(role: WorkspaceRole | null): WorkspacePermission | undefined {
	switch (role) {
		case "owner":
			return undefined;
		case "admin":
			return "workspace.admins.manage";
		default:
			return "workspace.members.manage";
	}
}

function memberAccess({ name, role }: { name: string; role: WorkspaceRole | null }): MemberRole {
	return { name, handle: handleFromName(name), role: role ?? "none" };
}
