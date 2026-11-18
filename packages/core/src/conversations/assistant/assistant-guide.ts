export * as AssistantGuide from "./assistant-guide.ts";

import { sharedPodSlugSchema, slugify } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Schema } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { AuthenticatedUserId, CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { agentSummary, routine } from "../../database/schema.ts";
import { Installation } from "../../installation/installation.ts";
import type { UserFacing } from "../../user-message.ts";
import { AgentAdministration } from "../../workspaces/agents/agent-administration.ts";
import { PodAdministration } from "../../workspaces/pods/pod-administration.ts";
import type { PodRepository } from "../../workspaces/pods/pod-repository.ts";
import { ChatView } from "../chats/chat-view.ts";
import { latestRunFailed } from "../routines/execution.ts";

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
	const pods = yield* PodAdministration.Service;
	const agents = yield* AgentAdministration.Service;
	const view = yield* ChatView.Service;
	const { webAppUrl } = yield* Installation.Service;

	const base = (person: Person) => `${webAppUrl}/${person.workspaceSlug}`;

	/** Runs `work` as the person, who is talking to their assistant. */
	const asPerson = <A, E, R>(person: Person, work: Effect.Effect<A, E, R>) =>
		work.pipe(CurrentActor.provide(AuthenticatedUserId.vouchedFor(person.userId)));

	const channelNamed = (person: Person, address: string) =>
		Effect.flatMap(pods.list({ workspace: person.workspaceId }), (listed) => {
			const wanted = address.trim().replace(/^#/, "").toLowerCase();
			const found = listed.find((pod) => pod.slug === wanted || pod.name.toLowerCase() === wanted);
			return found ? Effect.succeed(found) : Effect.fail(new NothingNamed({ what: "channel" }));
		});

	const botNamed = (person: Person, handle: string) =>
		Effect.flatMap(agents.list({ workspace: person.workspaceId }), (listed) => {
			const wanted = handle.trim().replace(/^@/, "").toLowerCase();
			const found = listed.find(
				(agent) => agent.handle === wanted && agent.systemAgentKey === null && !agent.assistant,
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
						const channels = yield* pods.list({ workspace });
						const bots = (yield* agents.list({ workspace })).filter(
							(agent) => agent.systemAgentKey === null && !agent.assistant,
						);
						const talkable = bots.filter((agent) => agent.permissions.talk);
						const lately =
							talkable.length === 0
								? []
								: yield* query((db) =>
										db
											.select({ agentId: agentSummary.agentId, content: agentSummary.content })
											.from(agentSummary)
											.where(
												inArray(
													agentSummary.agentId,
													talkable.map((agent) => agent.id),
												),
											),
									);
						const latelyOf = new Map(lately.map((row) => [row.agentId, row.content]));
						// As things stand, not since the person last looked: reading a
						// failed run's thread doesn't mend the automation.
						const failing =
							talkable.length === 0
								? []
								: yield* query((db) =>
										db
											.select({ agentId: routine.agentId, count: sql<number>`count(*)::int` })
											.from(routine)
											.where(
												and(
													inArray(
														routine.agentId,
														talkable.map((agent) => agent.id),
													),
													isNull(routine.deletedAt),
													or(
														isNotNull(routine.pausedAfterFailuresAt),
														and(eq(routine.state, "enabled"), latestRunFailed(routine.id)),
													),
												),
											)
											.groupBy(routine.agentId),
									);
						const failingOf = new Map(failing.map((row) => [row.agentId, row.count]));
						const activity = yield* view.activity(workspace);
						const approvals = yield* view.approvals(workspace);
						const at = base(person);
						return {
							channels: channels.map((pod) => ({
								name: pod.name,
								address: pod.slug,
								link: `${at}/channels/${pod.slug}`,
								description: pod.description,
								private: pod.visibility === "private",
								youAreIn: pod.isMember,
							})),
							bots: bots.map((agent) => ({
								name: agent.name,
								handle: `@${agent.handle}`,
								link: `${at}/bots/${agent.handle}`,
								description: agent.description,
								private: agent.visibility === "private",
								pinned: agent.pinned,
								youCanTalkToIt: agent.permissions.talk,
								lately: latelyOf.get(agent.id) ?? null,
							})),
							waitingOnYou: {
								approvals: approvals.waiting.slice(0, LISTED_ITEMS).map((request) => ({
									bot: request.agent.name,
									tool: request.call.tool,
									link: `${at}/approvals/${request.call.id}`,
								})),
								unreadMentions: activity.items
									.filter((item) => item.kind === "mention" && item.unread)
									.slice(0, LISTED_ITEMS)
									.flatMap((item) =>
										item.kind === "mention"
											? [
													{
														from: item.author.name,
														preview: item.preview,
														link: `${at}/activity/${item.conversationId}?message=${item.messageId}`,
													},
												]
											: [],
									),
								failingAutomations: bots.flatMap((agent) => {
									const failing = failingOf.get(agent.id) ?? 0;
									return failing > 0
										? [{ bot: agent.name, failing, link: `${at}/bots/${agent.handle}/automations` }]
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
						const slug = yield* Schema.decodeUnknownEffect(sharedPodSlugSchema)(
							slugify(channel.name),
						).pipe(Effect.mapError(() => new UnusableChannelName()));
						const made = yield* pods.create({
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
						const found = yield* channelNamed(person, address);
						const joined = yield* pods.join({ podId: found.id });
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
						const channel = yield* channelNamed(person, target.channel);
						const bot = yield* botNamed(person, target.bot);
						yield* pods.addBot({ podId: channel.id, agentId: bot.id });
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
						const bot = yield* botNamed(person, target.bot);
						yield* agents.setPinned({ agentId: bot.id, pinned: target.pinned });
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
		Layer.provide([PodAdministration.layer, AgentAdministration.layer, ChatView.layer]),
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
	| PodRepository.PodSlugTaken
	| PodRepository.BotNotPublic
	| PodAdministration.NotInWorkspace;

/** No channel or bot the person can see goes by the name the assistant gave. */
export class NothingNamed
	extends Data.TaggedError("NothingNamed")<{ readonly what: "channel" | "bot" }>
	implements UserFacing
{
	get userMessage() {
		return userText`There is no ${this.what} by that name that you can see.`;
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
