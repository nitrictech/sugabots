import { handleFromName, type WorkspaceRole } from "@sugabots/contracts";
import { tool } from "ai";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import {
	rolesGrantedInWorkspace,
	type WorkspacePermission,
} from "../../../authorization/permissions.ts";
import { type Executor, query, type RunEffect } from "../../../database/database.ts";
import { threadParticipant, user, workspaceMember } from "../../../database/schema.ts";

export const WORKSPACE_ACCESS_TOOL = "workspace_access";

/** Enough people to go to; a large workspace's every admin would only be noise. */
const MAX_HELPERS = 5;

export interface PersonAccess {
	name: string;
	handle: string;
	/** `none` for someone in the thread who has since left the workspace. */
	role: WorkspaceRole | "none";
}

export type WorkspaceAccessResult =
	| {
			person: PersonAccess;
			/**
			 * Who can change what the person may do, the owner first: the owner and
			 * admins for anyone else, the owner alone for an admin, and nobody for
			 * the owner.
			 */
			canHelp: PersonAccess[];
			/** Whether there are more admins than are listed. */
			more: boolean;
	  }
	| { refused: string };

/**
 * The `workspace_access` tool: a person's role, and who can change it. Only
 * for people in this thread, so a bot learns no more about the workspace's
 * members than someone needs to be pointed at the right person.
 */
export function workspaceAccessTool({
	threadId,
	workspaceId,
	run,
}: {
	threadId: string;
	workspaceId: string;
	run: RunEffect;
}) {
	return tool({
		description:
			"Look up a person's role in this workspace, and who can change what they may do: the owner and admins, or for an admin the owner alone; nobody can change the owner's. Use it when someone can't do something, a setting or tool seems missing for them, or they ask who to ask. What each role may do is in the docs.",
		inputSchema: Schema.Struct({
			person: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
				description: "The handle of a person in this thread, like @sam",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ person }): Promise<WorkspaceAccessResult> =>
			run(query((db) => lookUpAccess(db, { threadId, workspaceId, handle: person }))),
	});
}

const lookUpAccess = Effect.fn("WorkspaceAccess.lookUpAccess")(function* (
	db: Executor,
	{ threadId, workspaceId, handle }: { threadId: string; workspaceId: string; handle: string },
) {
	const people = yield* db
		.select({ name: user.name, role: workspaceMember.role })
		.from(threadParticipant)
		.innerJoin(user, eq(user.id, threadParticipant.userId))
		.leftJoin(
			workspaceMember,
			and(eq(workspaceMember.userId, user.id), eq(workspaceMember.workspaceId, workspaceId)),
		)
		.where(eq(threadParticipant.threadId, threadId))
		.orderBy(asc(threadParticipant.createdAt));
	const asked = handle.trim().replace(/^@/, "").toLowerCase();
	const found = people.find((candidate) => handleFromName(candidate.name) === asked);
	if (!found) {
		const handles = people.map((candidate) => `@${handleFromName(candidate.name)}`);
		return {
			refused: `Nobody in this thread has the handle @${asked}. The people here are: ${handles.join(", ") || "nobody"}.`,
		};
	}
	const changedBy = rolesThatChange(found.role);
	if (changedBy.length === 0) return { person: personAccess(found), canHelp: [], more: false };
	const helpers = yield* db
		.select({ name: user.name, role: workspaceMember.role })
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.where(
			and(eq(workspaceMember.workspaceId, workspaceId), inArray(workspaceMember.role, changedBy)),
		)
		.orderBy(sql`${workspaceMember.role} = 'owner' desc`, asc(workspaceMember.createdAt))
		// One more than is returned, to tell whether there are more.
		.limit(MAX_HELPERS + 1);
	return {
		person: personAccess(found),
		canHelp: helpers.slice(0, MAX_HELPERS).map(personAccess),
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

function personAccess({ name, role }: { name: string; role: WorkspaceRole | null }): PersonAccess {
	return { name, handle: handleFromName(name), role: role ?? "none" };
}
