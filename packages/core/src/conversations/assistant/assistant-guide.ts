export * as AssistantGuide from "./assistant-guide.ts";

import { channelSlugSchema, slugify } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { AuthenticatedUserId, CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { automation, botSummary } from "../../database/schema.ts";
import { Installation } from "../../installation/installation.ts";
import type { UserFacing } from "../../user-message.ts";
import { BotAdministration } from "../../workspaces/bots/bot-administration.ts";
import { ChannelAdministration } from "../../workspaces/channels/channel-administration.ts";
import type { ChannelRepository } from "../../workspaces/channels/channel-repository.ts";
import { latestRunFailed } from "../automations/execution.ts";
import { ChatView } from "../chats/chat-view.ts";

/**
 * What a Personal Assistant knows of its person's workspace, and what it does
 * there for them. Everything runs as the person, so it reads only what they
 * reach and does only what they may: the assistant can do what its person
 * can, and no more.
 */
export interface Interface {
	/** The workspace as `person` sees it, and what is waiting on them. */
	readonly guide: (person: Person) => Effect.Effect<Guide>;
	/** Makes a channel with `person` in it. */
	readonly createChannel: (
		person: Person,
		channel: { name: string; description?: string; private?: boolean },
	) => Effect.Effect<Place, Refused>;
	/** Puts `person` in the public channel `channel`, by its address. */
	readonly joinChannel: (person: Person, channel: string) => Effect.Effect<Place, Refused>;
	/** Adds the public bot `bot`, by its handle, to the channel `channel`. */
	readonly addBotToChannel: (
		person: Person,
		target: { channel: string; bot: string },
	) => Effect.Effect<Place, Refused>;
	/** Pins the bot `bot` to `person`'s sidebar, or unpins it. */
	readonly pinBot: (
		person: Person,
		target: { bot: string; pinned: boolean },
	) => Effect.Effect<Place, Refused>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AssistantGuide",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AssistantGuide");
	const channelAdministration = yield* ChannelAdministration.Service;
	const bots = yield* BotAdministration.Service;
	const view = yield* ChatView.Service;
	const { webAppUrl } = yield* Installation.Service;

	const base = (person: Person) => `${webAppUrl}/${person.workspaceSlug}`;

	/** Runs `work` as the person, who is talking to their assistant. */
	const asPerson = <A, E, R>(person: Person, work: Effect.Effect<A, E, R>) =>
		work.pipe(CurrentActor.provide(AuthenticatedUserId.vouchedFor(person.userId)));

	// Exactly the address and handle the person approved: a looser match, such as
	// by name, could act on a channel or bot they didn't mean.
	const channelAt = (person: Person, address: string) =>
		Effect.flatMap(channelAdministration.list({ workspace: person.workspaceId }), (listed) => {
			const wanted = address.trim().replace(/^#/, "");
			const found = listed.find((channel) => channel.slug === wanted);
			return found ? Effect.succeed(found) : Effect.fail(new NothingNamed({ what: "channel" }));
		});

	const botWithHandle = (person: Person, handle: string) =>
		Effect.flatMap(bots.list({ workspace: person.workspaceId }), (listed) => {
			const wanted = handle.trim().replace(/^@/, "");
			const found = listed.find(
				(bot) => bot.handle === wanted && bot.systemBotKey === null && !bot.assistant,
			);
			return found ? Effect.succeed(found) : Effect.fail(new NothingNamed({ what: "bot" }));
		});

	return Service.of({
		guide: (person) =>
			operation(
				"guide",
				asPerson(
					person,
					Effect.gen(function* () {
						const workspace = person.workspaceId;
						const channels = yield* channelAdministration.list({ workspace });
						const workspaceBots = (yield* bots.list({ workspace })).filter(
							(bot) => bot.systemBotKey === null && !bot.assistant,
						);
						const talkable = workspaceBots.filter((bot) => bot.permissions.talk);
						const lately =
							talkable.length === 0
								? []
								: yield* query((db) =>
										db
											.select({ botId: botSummary.botId, content: botSummary.content })
											.from(botSummary)
											.where(
												inArray(
													botSummary.botId,
													talkable.map((bot) => bot.id),
												),
											),
									);
						const latelyOf = new Map(lately.map((row) => [row.botId, row.content]));
						// As things stand, not since the person last looked: reading a
						// failed run's conversation doesn't mend the automation.
						const failing =
							talkable.length === 0
								? []
								: yield* query((db) =>
										db
											.select({ botId: automation.botId, count: sql<number>`count(*)::int` })
											.from(automation)
											.where(
												and(
													inArray(
														automation.botId,
														talkable.map((bot) => bot.id),
													),
													isNull(automation.deletedAt),
													or(
														isNotNull(automation.pausedAfterFailuresAt),
														and(eq(automation.state, "enabled"), latestRunFailed(automation.id)),
													),
												),
											)
											.groupBy(automation.botId),
									);
						const failingOf = new Map(failing.map((row) => [row.botId, row.count]));
						const unreadMentions = yield* view.unreadMentions(workspace, LISTED_ITEMS);
						const approvals = yield* view.approvals(workspace);
						const at = base(person);
						return {
							channels: channels.map((channel) => ({
								name: channel.name,
								address: channel.slug,
								link: `${at}/channels/${channel.slug}`,
								description: channel.description,
								private: channel.visibility === "private",
								youAreIn: channel.isMember,
							})),
							bots: workspaceBots.map((bot) => ({
								name: bot.name,
								handle: `@${bot.handle}`,
								link: `${at}/bots/${bot.handle}`,
								description: bot.description,
								private: bot.visibility === "private",
								pinned: bot.pinned,
								youCanTalkToIt: bot.permissions.talk,
								lately: latelyOf.get(bot.id) ?? null,
							})),
							waitingOnYou: {
								approvals: approvals.waiting.slice(0, LISTED_ITEMS).map((request) => ({
									bot: request.bot.name,
									tool: request.call.tool,
									link: `${at}/approvals/${request.call.id}`,
								})),
								unreadMentions: unreadMentions.flatMap((item) =>
									item.kind === "mention"
										? [
												{
													from: item.author.name,
													preview: item.preview,
													link: `${at}/inbox/${item.rootConversationId}?message=${item.messageId}`,
												},
											]
										: [],
								),
								failingAutomations: workspaceBots.flatMap((bot) => {
									const failing = failingOf.get(bot.id) ?? 0;
									return failing > 0
										? [{ bot: bot.name, failing, link: `${at}/bots/${bot.handle}/automations` }]
										: [];
								}),
							},
						} satisfies Guide;
					}),
				).pipe(
					// Anything the person can't reach is left out above, so a refusal here
					// is the person having left the workspace mid-turn.
					Effect.catch((denied) =>
						Effect.die(
							new Error(`The assistant's person cannot read the workspace: ${denied._tag}`),
						),
					),
				),
			),

		createChannel: (person, channel) =>
			operation(
				"createChannel",
				asPerson(
					person,
					Effect.gen(function* () {
						const slug = yield* Schema.decodeUnknownEffect(channelSlugSchema)(
							slugify(channel.name),
						).pipe(Effect.mapError(() => new UnusableChannelName()));
						const made = yield* channelAdministration.create({
							workspace: person.workspaceId,
							name: channel.name,
							slug,
							description: channel.description ?? null,
							visibility: channel.private ? "private" : "public",
						});
						return { name: made.name, link: `${base(person)}/channels/${made.slug}` };
					}),
				),
			),

		joinChannel: (person, address) =>
			operation(
				"joinChannel",
				asPerson(
					person,
					Effect.gen(function* () {
						const found = yield* channelAt(person, address);
						const joined = yield* channelAdministration.join({ channelId: found.id });
						return { name: joined.name, link: `${base(person)}/channels/${joined.slug}` };
					}),
				),
			),

		addBotToChannel: (person, target) =>
			operation(
				"addBotToChannel",
				asPerson(
					person,
					Effect.gen(function* () {
						const channel = yield* channelAt(person, target.channel);
						const bot = yield* botWithHandle(person, target.bot);
						yield* channelAdministration.addBot({ channelId: channel.id, botId: bot.id });
						return { name: channel.name, link: `${base(person)}/channels/${channel.slug}` };
					}),
				),
			),

		pinBot: (person, target) =>
			operation(
				"pinBot",
				asPerson(
					person,
					Effect.gen(function* () {
						const bot = yield* botWithHandle(person, target.bot);
						yield* bots.setPinned({ botId: bot.id, pinned: target.pinned });
						return { name: bot.name, link: `${base(person)}/bots/${bot.handle}` };
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/**
 * Suspended, because the turn's steps reach this module and it reaches the
 * services the turns' own modules import: the layers it is built from are
 * read once the layer is built, not while the modules load.
 */
export const layer = Layer.suspend(() =>
	layerNoDeps.pipe(
		Layer.provide([ChannelAdministration.layer, BotAdministration.layer, ChatView.layer]),
	),
);

/** The person a Personal Assistant works for, in their workspace. */
export interface Person {
	readonly userId: string;
	readonly workspaceId: string;
	readonly workspaceSlug: string;
}

/** A channel or bot something was done to, by its name and where it opens. */
export interface Place {
	readonly name: string;
	readonly link: string;
}

/** The most of each kind of waiting item the guide lists. */
const LISTED_ITEMS = 10;

/** The workspace as the assistant's person sees it. */
export interface Guide {
	readonly channels: ReadonlyArray<{
		name: string;
		address: string;
		link: string;
		description: string | null;
		private: boolean;
		youAreIn: boolean;
	}>;
	readonly bots: ReadonlyArray<{
		name: string;
		handle: string;
		link: string;
		description: string | null;
		private: boolean;
		pinned: boolean;
		youCanTalkToIt: boolean;
		/** What it has been doing lately, when the person may see into it. */
		lately: string | null;
	}>;
	readonly waitingOnYou: {
		approvals: ReadonlyArray<{ bot: string; tool: string; link: string }>;
		unreadMentions: ReadonlyArray<{ from: string; preview: string; link: string }>;
		failingAutomations: ReadonlyArray<{ bot: string; failing: number; link: string }>;
	};
}

/** Why something the assistant did for its person was refused, in words it can pass on. */
export type Refused =
	| AuthorizationDenied
	| NothingNamed
	| UnusableChannelName
	| ChannelRepository.ChannelSlugTaken
	| ChannelRepository.BotNotPublic
	| ChannelAdministration.NotInWorkspace;

/** No channel or bot the person can see has the address or handle the assistant gave. */
export class NothingNamed
	extends Data.TaggedError("NothingNamed")<{ readonly what: "channel" | "bot" }>
	implements UserFacing
{
	get userMessage() {
		return this.what === "channel"
			? userText`There is no channel at that address that you can see.`
			: userText`There is no bot with that handle that you can see.`;
	}
}

export class UnusableChannelName
	extends Data.TaggedError("UnusableChannelName")
	implements UserFacing
{
	get userMessage() {
		return userText`That name can't be a channel's address. Choose another.`;
	}
}
