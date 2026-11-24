import { handleFromName, type WorkspaceRole } from "@sugabots/contracts";
import { tool } from "ai";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import {
	rolesGrantedInWorkspace,
	type WorkspacePermission,
} from "../../../authorization/permissions.ts";
import { type Executor, query, type RunEffect } from "../../../database/database.ts";
import { chatParticipant, member, membership } from "../../../database/schema.ts";

export const WORKSPACE_ROLE_TOOL = "workspace_role";

/** Enough members to go to; a large workspace's every admin would only be noise. */
const MAX_HELPERS = 5;

interface MemberRole {
	name: string;
	handle: string;
	/** `none` for someone in the chat who has since left the workspace. */
	role: WorkspaceRole | "none";
}

export type WorkspaceRoleResult =
	| {
			member: MemberRole;
			/**
			 * Who can change what the member may do, the owner first: the owner and
			 * admins for anyone else, the owner alone for an admin, and nobody for
			 * the owner.
			 */
			canHelp: MemberRole[];
			/** Whether there are more admins than are listed. */
			more: boolean;
	  }
	| { refused: string };

/**
 * The `workspace_role` tool: a member's role, and who can change it. Only
 * for members taking part in this chat, so a bot learns no more about the workspace's
 * members than someone needs to be pointed at the right member.
 */
export function workspaceRoleTool({
	chatId,
	workspaceId,
	run,
}: {
	chatId: string;
	workspaceId: string;
	run: RunEffect;
}) {
	return tool({
		description:
			"Look up a member's role in this workspace, and who can change what they may do: the owner and admins, or for an admin the owner alone; nobody can change the owner's. Use it when someone can't do something, a setting or tool seems missing for them, or they ask who to ask. What each role may do is in the docs.",
		inputSchema: Schema.Struct({
			member: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
				description: "The handle of a member in this chat, like @sam",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ member }): Promise<WorkspaceRoleResult> =>
			run(query((db) => lookUpAccess(db, { chatId, workspaceId, handle: member }))),
	});
}

const lookUpAccess = Effect.fn("WorkspaceAccess.lookUpAccess")(function* (
	db: Executor,
	{ chatId, workspaceId, handle }: { chatId: string; workspaceId: string; handle: string },
) {
	const members = yield* db
		.select({ name: member.name, role: membership.role })
		.from(chatParticipant)
		.innerJoin(member, eq(member.id, chatParticipant.memberId))
		.leftJoin(
			membership,
			and(eq(membership.memberId, member.id), eq(membership.workspaceId, workspaceId)),
		)
		.where(eq(chatParticipant.chatId, chatId))
		.orderBy(asc(chatParticipant.createdAt));
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
	const helpers = yield* db
		.select({ name: member.name, role: membership.role })
		.from(membership)
		.innerJoin(member, eq(member.id, membership.memberId))
		.where(and(eq(membership.workspaceId, workspaceId), inArray(membership.role, changedBy)))
		.orderBy(sql`${membership.role} = 'owner' desc`, asc(membership.createdAt))
		// One more than is returned, to tell whether there are more.
		.limit(MAX_HELPERS + 1);
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
