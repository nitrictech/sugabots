import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { bot, invitation, placedChat, project, workspace } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";

/**
 * The id of the workspace `reference` names, by its id or its slug, for an
 * operation whose input names a workspace either way to name and prove. A
 * reference shaped like an id is taken as one, as no slug is shaped like an
 * id. A slug no workspace has comes back as it is, and proves hidden like an
 * id nobody reaches, so a refusal never says whether a slug is taken.
 */
export const workspaceIdOf = (reference: string) =>
	isUuid(reference)
		? // As it is stored, which names its stream and its lock however the caller wrote it.
			Effect.succeed(reference.toLowerCase())
		: query((db) =>
				db
					.select({ id: workspace.id })
					.from(workspace)
					.where(eq(workspace.slug, reference))
					.limit(1),
			).pipe(Effect.map(([found]) => found?.id ?? reference));

/**
 * The slug of the workspace `workspaceId`, which a principal already proved it
 * is in, for a link into it. Dies when there is none: a workspace is deleted
 * only once nothing works in it.
 */
export const workspaceSlugOf = (workspaceId: string) =>
	query((db) =>
		db
			.select({ slug: workspace.slug })
			.from(workspace)
			.where(eq(workspace.id, workspaceId))
			.limit(1),
	).pipe(
		Effect.flatMap(([found]) =>
			found ? Effect.succeed(found.slug) : Effect.die(new Error("The workspace is gone")),
		),
	);

/**
 * The workspace of the project `projectId`, if there is one: whose lock an
 * operation that changes the project's members takes before it names and
 * proves anything.
 */
export const workspaceOfProject = (projectId: string) =>
	isUuid(projectId)
		? query((db) =>
				db
					.select({ workspace: project.workspaceId })
					.from(project)
					.where(eq(project.id, projectId))
					.limit(1),
			).pipe(Effect.map(([found]) => found?.workspace))
		: Effect.succeed(undefined);

/**
 * The workspace of the bot `botId`, if there is one: whose lock an operation
 * that changes who reaches the bot takes before it names and proves anything.
 */
export const workspaceOfBot = (botId: string) =>
	isUuid(botId)
		? query((db) =>
				db.select({ workspace: bot.workspaceId }).from(bot).where(eq(bot.id, botId)).limit(1),
			).pipe(Effect.map(([found]) => found?.workspace))
		: Effect.succeed(undefined);

/**
 * The workspace of the chat `chatId`, if there is one: whose lock a read of
 * the chat shares while it proves reach and reads.
 */
export const workspaceOfChat = (chatId: string) =>
	isUuid(chatId)
		? query((db) =>
				db
					.select({ workspace: placedChat.workspaceId })
					.from(placedChat)
					.where(eq(placedChat.id, chatId))
					.limit(1),
			).pipe(Effect.map(([found]) => found?.workspace))
		: Effect.succeed(undefined);

/**
 * The workspace of the invitation `invitationId`, if there is one: whose lock
 * accepting or cancelling it takes before it names and proves anything.
 */
export const workspaceOfInvitation = (invitationId: string) =>
	isUuid(invitationId)
		? query((db) =>
				db
					.select({ workspace: invitation.workspaceId })
					.from(invitation)
					.where(eq(invitation.id, invitationId))
					.limit(1),
			).pipe(Effect.map(([found]) => found?.workspace))
		: Effect.succeed(undefined);
