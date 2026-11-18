export * as ChannelRepository from "./channel-repository.ts";

import {
	administersWorkspace,
	type ChannelColor,
	type ChannelUpdate,
	type ChannelVisibility,
	leastUsedChannelColor,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type * as schema from "../../database/schema.ts";
import { bot, channel, channelBot, channelMember, workspaceMember } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { channelColorOf } from "./channel.ts";

/**
 * The only writer of `channel`, `channel_member` and `channel_bot`: channels, the people
 * in them, and their bots.
 *
 * A channel's own rules are enforced here, so they hold however it is
 * reached: its slug is unique in its workspace, and only public bots are in
 * one. Whether somebody may ask for any of this is not decided here.
 */
export interface Interface {
	/**
	 * Creates a channel with `creatorId` as its first member. Without a colour
	 * it takes the one fewest of the workspace's channels have.
	 */
	readonly create: (
		workspaceId: string,
		input: {
			creatorId: string;
			name: string;
			slug: string;
			color?: ChannelColor;
			description?: string | null;
			visibility?: ChannelVisibility;
		},
	) => Effect.Effect<schema.ChannelRow, ChannelSlugTaken>;
	readonly update: (
		workspaceId: string,
		channelId: string,
		changes: ChannelUpdate,
	) => Effect.Effect<schema.ChannelRow, ChannelGone | ChannelSlugTaken>;
	/** Removes a channel. One already gone counts as removed. */
	readonly remove: (workspaceId: string, channelId: string) => Effect.Effect<void>;
	/** Adds a member of the channel's workspace. Adding somebody already in it changes nothing. */
	readonly addMember: (
		workspaceId: string,
		channelId: string,
		userId: string,
	) => Effect.Effect<"added" | "already_member" | "not_workspace_member">;
	/** Refuses an administrator, who belongs to every channel. */
	readonly removeMember: (
		workspaceId: string,
		channelId: string,
		userId: string,
	) => Effect.Effect<"removed" | "not_a_member" | "administrator">;
	/** Puts a public bot of the workspace in the channel. Adding one already in it changes nothing. */
	readonly addBot: (
		workspaceId: string,
		channelId: string,
		botId: string,
	) => Effect.Effect<void, BotNotPublic>;
	readonly removeBot: (
		workspaceId: string,
		channelId: string,
		botId: string,
	) => Effect.Effect<void>;
	/** The channel's bots, by name. */
	readonly bots: (channelId: string) => Effect.Effect<schema.BotRow[]>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ChannelRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChannelRepository");

	return Service.of({
		create: (workspaceId, { creatorId, name, slug, color, description, visibility }) =>
			operation(
				"create",
				// One unit, so a channel is never briefly without its members: whoever
				// made it, and every administrator.
				transaction(
					Effect.gen(function* () {
						const taken = yield* query((db) =>
							db
								.select({ color: channel.color })
								.from(channel)
								.where(eq(channel.workspaceId, workspaceId)),
						);
						const [row] = yield* query((db) =>
							db
								.insert(channel)
								.values({
									workspaceId,
									name,
									slug,
									color:
										color ?? leastUsedChannelColor(taken.map((one) => channelColorOf(one.color))),
									description: description ?? null,
									visibility: visibility ?? "public",
									createdById: creatorId,
								})
								.onConflictDoNothing({ target: [channel.workspaceId, channel.slug] })
								.returning(),
						);
						if (!row) {
							return yield* new ChannelSlugTaken({ slug });
						}
						// The `channel_administrators` trigger has already added every
						// administrator, the creator too if they are one.
						yield* query((db) =>
							db
								.insert(channelMember)
								.values({ workspaceId, channelId: row.id, userId: creatorId })
								.onConflictDoNothing({ target: [channelMember.channelId, channelMember.userId] }),
						);
						return row;
					}),
				),
			),

		update: (workspaceId, channelId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					// An UPDATE has no `on conflict`, so a taken slug arrives as a unique
					// violation. The slug is the only unique column a change can touch.
					const [row] = yield* queryCatching(
						(db) =>
							db
								.update(channel)
								.set(changes)
								.where(and(eq(channel.id, channelId), eq(channel.workspaceId, workspaceId)))
								.returning(),
						(failure) =>
							isUniqueViolation(failure) && changes.slug !== undefined
								? new ChannelSlugTaken({ slug: changes.slug })
								: undefined,
					);
					if (!row) {
						return yield* new ChannelGone({ channelId });
					}
					return row;
				}),
			),

		remove: (workspaceId, channelId) =>
			operation(
				"remove",
				query((db) =>
					db
						.delete(channel)
						.where(and(eq(channel.id, channelId), eq(channel.workspaceId, workspaceId))),
				).pipe(Effect.asVoid),
			),

		addMember: (workspaceId, channelId, userId) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					const inserted = yield* query((db) =>
						db.execute<{ id: string }>(
							sql`
							insert into ${channelMember} ("workspace_id", "channel_id", "user_id")
							select ${channel.workspaceId}, ${channel.id}, ${userId}
							from ${channel}
							inner join ${workspaceMember}
								on ${workspaceMember.workspaceId} = ${channel.workspaceId}
								and ${workspaceMember.userId} = ${userId}
							where ${channel.id} = ${channelId}
							and ${channel.workspaceId} = ${workspaceId}
							on conflict ("channel_id", "user_id") do nothing
							returning "id"
						`,
							"objects",
						),
					);

					if (inserted.length > 0) {
						return "added";
					}

					const [existing] = yield* query((db) =>
						db
							.select({ id: channelMember.id })
							.from(channelMember)
							.innerJoin(channel, eq(channel.id, channelMember.channelId))
							.innerJoin(
								workspaceMember,
								and(
									eq(workspaceMember.workspaceId, channel.workspaceId),
									eq(workspaceMember.userId, userId),
								),
							)
							.where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, userId)))
							.limit(1),
					);

					return existing ? "already_member" : "not_workspace_member";
				}),
			),

		removeMember: (workspaceId, channelId, userId) =>
			operation(
				"removeMember",
				transaction(
					Effect.gen(function* () {
						// Held until the transaction ends, so nobody is promoted between the
						// role check and the delete. The channel and role triggers take it too.
						yield* query((db) => db.execute(sql`select lock_channel_membership(${workspaceId})`));
						const [membership] = yield* query((db) =>
							db
								.select({ role: workspaceMember.role })
								.from(workspaceMember)
								.where(
									and(
										eq(workspaceMember.workspaceId, workspaceId),
										eq(workspaceMember.userId, userId),
									),
								)
								.limit(1),
						);
						if (administersWorkspace(membership?.role)) {
							return "administrator";
						}
						const removed = yield* query((db) =>
							db
								.delete(channelMember)
								.where(
									and(
										eq(channelMember.workspaceId, workspaceId),
										eq(channelMember.channelId, channelId),
										eq(channelMember.userId, userId),
									),
								)
								.returning({ id: channelMember.id }),
						);
						return removed.length > 0 ? "removed" : "not_a_member";
					}),
				),
			),

		addBot: (workspaceId, channelId, botId) =>
			operation(
				"addBot",
				Effect.gen(function* () {
					// The share lock waits for a change making the bot private to commit,
					// then checks the bot as it is: that change takes the bot out of its
					// channels, and the row added here would otherwise be one it missed.
					const added = yield* query((db) =>
						db.execute<{ bot_id: string }>(
							sql`
							insert into ${channelBot} ("workspace_id", "channel_id", "bot_id")
							select ${channel.workspaceId}, ${channel.id}, ${bot.id}
							from ${channel}
							inner join ${bot}
								on ${bot.workspaceId} = ${channel.workspaceId}
								and ${bot.id} = ${botId}
								and ${bot.visibility} = 'public'
								and ${bot.systemBotKey} is null
								and ${bot.assistantOf} is null
							where ${channel.id} = ${channelId}
							and ${channel.workspaceId} = ${workspaceId}
							for share of ${bot}
							on conflict do nothing
							returning "bot_id"
						`,
							"objects",
						),
					);
					if (added.length > 0) return;
					const [present] = yield* query((db) =>
						db
							.select({ botId: channelBot.botId })
							.from(channelBot)
							.where(and(eq(channelBot.channelId, channelId), eq(channelBot.botId, botId)))
							.limit(1),
					);
					if (!present) return yield* new BotNotPublic();
				}),
			),

		removeBot: (workspaceId, channelId, botId) =>
			operation(
				"removeBot",
				query((db) =>
					db
						.delete(channelBot)
						.where(
							and(
								eq(channelBot.workspaceId, workspaceId),
								eq(channelBot.channelId, channelId),
								eq(channelBot.botId, botId),
							),
						),
				).pipe(Effect.asVoid),
			),

		bots: (channelId) =>
			operation(
				"bots",
				query((db) =>
					db
						.select({ bot })
						.from(channelBot)
						.innerJoin(bot, eq(bot.id, channelBot.botId))
						.where(eq(channelBot.channelId, channelId))
						.orderBy(asc(bot.name)),
				).pipe(Effect.map((rows) => rows.map((row) => row.bot))),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** The slug is taken by another channel in this workspace. */
export class ChannelSlugTaken
	extends Data.TaggedError("ChannelSlugTaken")<{ readonly slug: string }>
	implements UserFacing
{
	override get message() {
		return `A channel with the slug "${this.slug}" already exists in this workspace`;
	}
	get userMessage() {
		return userText`A channel with that address already exists in this workspace`;
	}
}

/** The channel was deleted before the write reached it. */
export class ChannelGone
	extends Data.TaggedError("ChannelGone")<{ readonly channelId: string }>
	implements UserFacing
{
	override get message() {
		return `No channel with the id "${this.channelId}"`;
	}
	get userMessage() {
		return userText`No such channel`;
	}
}

/** Only a public bot of the workspace is put in a channel. */
export class BotNotPublic extends Data.TaggedError("BotNotPublic") implements UserFacing {
	get userMessage() {
		return userText`Only a public bot can be added to a channel`;
	}
}
