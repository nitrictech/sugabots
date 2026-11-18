export * as ChannelAdministration from "./channel-administration.ts";

import type {
	Bot,
	Channel,
	ChannelColor,
	ChannelMember,
	ChannelUpdate,
	ChannelVisibility,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Context, Data, Effect, Layer } from "effect";
import {
	type AuthorizationDenied,
	joinedStanding,
	listedChannelStandingsFor,
	ResourceHidden,
} from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { personFacingBotRow, toBot } from "../bots/bot.ts";
import { channelSeenBy } from "./channel.ts";
import { channelMembers } from "./channel-reads.ts";
import { ChannelRepository } from "./channel-repository.ts";

/**
 * A workspace's channels, who is in them, and their bots. Channels are
 * returned as the current actor sees them, permissions and all.
 */
export interface Interface {
	/** The channels the actor is in, and the public ones they could join, by name. */
	readonly list: (input: {
		workspace: string;
	}) => Effect.Effect<Channel[], AuthorizationDenied, CurrentActor.Service>;
	/** A channel with the actor in it. */
	readonly create: (input: {
		workspace: string;
		name: string;
		slug: string;
		color?: ChannelColor;
		description?: string | null;
		visibility?: ChannelVisibility;
	}) => Effect.Effect<
		Channel,
		AuthorizationDenied | ChannelRepository.ChannelSlugTaken,
		CurrentActor.Service
	>;
	readonly update: (input: {
		channelId: string;
		changes: ChannelUpdate;
	}) => Effect.Effect<
		Channel,
		| AuthorizationDenied
		| EmptyChannelUpdate
		| ChannelRepository.ChannelGone
		| ChannelRepository.ChannelSlugTaken,
		CurrentActor.Service
	>;
	readonly remove: (input: {
		channelId: string;
	}) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
	readonly members: (input: {
		channelId: string;
	}) => Effect.Effect<ChannelMember[], AuthorizationDenied, CurrentActor.Service>;
	/** Adds `userId` to the channel. Adding somebody already in it changes nothing. */
	readonly addMember: (input: {
		channelId: string;
		userId: string;
	}) => Effect.Effect<void, AuthorizationDenied | NotInWorkspace, CurrentActor.Service>;
	/** Takes `userId` out of the channel. Refuses an administrator, who belongs to every one. */
	readonly removeMember: (input: {
		channelId: string;
		userId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | AdministratorInEveryChannel | NotInChannel,
		CurrentActor.Service
	>;
	/** Takes the caller out of the channel, on the same terms as {@link Interface.removeMember}. */
	readonly leave: (input: {
		channelId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | AdministratorInEveryChannel | NotInChannel,
		CurrentActor.Service
	>;
	/** Puts the caller in a public channel. Joining one they are in changes nothing. */
	readonly join: (input: {
		channelId: string;
	}) => Effect.Effect<Channel, AuthorizationDenied, CurrentActor.Service>;
	/** The channel's bots, by name. */
	readonly bots: (input: {
		channelId: string;
	}) => Effect.Effect<Bot[], AuthorizationDenied, CurrentActor.Service>;
	readonly addBot: (input: {
		channelId: string;
		botId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | ChannelRepository.BotNotPublic,
		CurrentActor.Service
	>;
	readonly removeBot: (input: {
		channelId: string;
		botId: string;
	}) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ChannelAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChannelAdministration");
	const authorization = yield* Authorization.Service;
	const channels = yield* ChannelRepository.Service;

	const takeOut = (channel: schema.ChannelRow, userId: string) =>
		Effect.gen(function* () {
			const outcome = yield* channels.removeMember(channel.workspaceId, channel.id, userId);
			switch (outcome) {
				case "removed":
					return;
				case "administrator":
					return yield* new AdministratorInEveryChannel();
				case "not_a_member":
					return yield* new NotInChannel();
			}
		});

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						input.workspace,
						"workspace.read",
					);
					const listed = yield* query((db) =>
						listedChannelStandingsFor(db, workspaceId, actor.userId),
					);
					return listed.map(channelSeenBy);
				}),
			),

		create: ({ workspace, ...input }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"channel.create",
					);
					const row = yield* channels.create(workspaceId, { creatorId: actor.userId, ...input });
					return channelSeenBy(joinedStanding(row, actor));
				}),
			),

		update: ({ channelId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const standing = yield* authorization.channel(channelId, "channel.update");
					if (Object.values(changes).every((value) => value === undefined)) {
						return yield* new EmptyChannelUpdate();
					}
					const updated = yield* channels.update(
						standing.channel.workspaceId,
						standing.channel.id,
						changes,
					);
					return channelSeenBy({ ...standing, channel: updated });
				}),
			),

		remove: ({ channelId }) =>
			operation(
				"remove",
				Effect.flatMap(authorization.channel(channelId, "channel.delete"), ({ channel }) =>
					channels.remove(channel.workspaceId, channel.id),
				),
			),

		members: ({ channelId }) =>
			operation(
				"members",
				Effect.flatMap(authorization.channel(channelId, "channel.read"), ({ channel }) =>
					channelMembers(channel.id),
				),
			),

		addMember: ({ channelId, userId }) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					const { channel } = yield* authorization.channel(channelId, "channel.members.manage");
					const outcome = yield* channels.addMember(channel.workspaceId, channel.id, userId);
					if (outcome === "not_workspace_member") return yield* new NotInWorkspace();
				}),
			),

		removeMember: ({ channelId, userId }) =>
			operation(
				"removeMember",
				Effect.gen(function* () {
					const { channel } = yield* authorization.channel(channelId, "channel.members.manage");
					return yield* takeOut(channel, userId);
				}),
			),

		leave: ({ channelId }) =>
			operation(
				"leave",
				Effect.gen(function* () {
					const { channel, actor } = yield* authorization.channel(channelId, "channel.leave");
					return yield* takeOut(channel, actor.userId);
				}),
			),

		join: ({ channelId }) =>
			operation(
				"join",
				Effect.gen(function* () {
					const standing = yield* authorization.channelFound(channelId);
					const channel = standing.channel;
					if (!standing.facts.isMember) {
						// Only a public channel is joined from the directory; a private one
						// is answered as if it weren't there.
						if (channel.visibility !== "public" || !standing.actor.workspaceRole) {
							return yield* new ResourceHidden({ resource: "channel" });
						}
						yield* channels.addMember(channel.workspaceId, channel.id, standing.actor.userId);
					}
					return channelSeenBy(joinedStanding(channel, standing.actor));
				}),
			),

		bots: ({ channelId }) =>
			operation(
				"bots",
				Effect.gen(function* () {
					const { channel, actor } = yield* authorization.channel(channelId, "channel.read");
					return (yield* channels.bots(channel.id)).flatMap((row) => {
						const bot = personFacingBotRow(row);
						return bot ? [toBot(bot, { actor })] : [];
					});
				}),
			),

		addBot: ({ channelId, botId }) =>
			operation(
				"addBot",
				Effect.gen(function* () {
					const { channel } = yield* authorization.channel(channelId, "channel.bots.manage");
					// A bot the person can't see is answered as if it weren't there.
					yield* authorization.bot(botId, "bot.read");
					yield* channels.addBot(channel.workspaceId, channel.id, botId);
				}),
			),

		removeBot: ({ channelId, botId }) =>
			operation(
				"removeBot",
				Effect.flatMap(authorization.channel(channelId, "channel.bots.manage"), ({ channel }) =>
					channels.removeBot(channel.workspaceId, channel.id, botId),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, ChannelRepository.layer]),
);

/** A channel update that names nothing to change. */
export class EmptyChannelUpdate
	extends Data.TaggedError("EmptyChannelUpdate")
	implements UserFacing
{
	get userMessage() {
		return userText`Nothing to change`;
	}
}

/** Administrators belong to every channel, so nobody takes one out of it. */
export class AdministratorInEveryChannel
	extends Data.TaggedError("AdministratorInEveryChannel")
	implements UserFacing
{
	get userMessage() {
		return userText`Administrators are in every channel`;
	}
}

/** Only a member of the channel's workspace can be added to it. */
export class NotInWorkspace extends Data.TaggedError("NotInWorkspace") implements UserFacing {
	get userMessage() {
		return userText`That person is not in this workspace`;
	}
}

export class NotInChannel extends Data.TaggedError("NotInChannel") implements UserFacing {
	get userMessage() {
		return userText`That person is not in this channel`;
	}
}
