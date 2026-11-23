export * as AssistantGuide from "./assistant-guide.ts";

import { userText } from "@sugabots/errors";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { reachesProjectFor } from "../../authorization/access.ts";
import { AuthenticatedUserId, CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { automation, project } from "../../database/schema.ts";
import { Installation } from "../../installation/installation.ts";
import {
	approvalPath,
	automationsPagePath,
	botPath,
	inboxPath,
	projectPath,
} from "../../installation/web-app-paths.ts";
import type { UserFacing } from "../../user-message.ts";
import { BotAdministration } from "../../workspaces/bots/bot-administration.ts";
import { ProjectAdministration } from "../../workspaces/projects/project-administration.ts";
import type { ProjectRepository } from "../../workspaces/projects/project-repository.ts";
import { automationFailing } from "../automations/execution.ts";
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
	/** Makes a project with `person` in it, led by the public bot with the handle `lead`. */
	readonly createProject: (
		person: Person,
		project: { name: string; lead: string; description?: string; private?: boolean },
	) => Effect.Effect<Place, Refused>;
	/** Puts `person` in the public project `project`, by its address. */
	readonly joinProject: (person: Person, project: string) => Effect.Effect<Place, Refused>;
	/** Adds the public bot `bot`, by its handle, to the project `project`. */
	readonly addBotToProject: (
		person: Person,
		target: { project: string; bot: string },
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
	const projectAdministration = yield* ProjectAdministration.Service;
	const bots = yield* BotAdministration.Service;
	const view = yield* ChatView.Service;
	const { webAppUrl } = yield* Installation.Service;

	/** `path` from the web app's root, as a link the person can follow. */
	const linkTo = (path: string) => `${webAppUrl}${path}`;

	/** Runs `work` as the person, who is talking to their assistant. */
	const asPerson = <A, E, R>(person: Person, work: Effect.Effect<A, E, R>) =>
		work.pipe(CurrentActor.provide(AuthenticatedUserId.vouchedFor(person.userId)));

	// Exactly the address and handle the person approved: a looser match, such as
	// by name, could act on a project or bot they didn't mean.
	const projectAt = (person: Person, address: string) =>
		Effect.flatMap(projectAdministration.list({ workspace: person.workspaceId }), (listed) => {
			const wanted = address.trim().replace(/^#/, "");
			const found = listed.find((project) => project.slug === wanted);
			return found ? Effect.succeed(found) : Effect.fail(new NothingNamed({ what: "project" }));
		});

	const botWithHandle = (person: Person, handle: string) =>
		Effect.flatMap(bots.list({ workspace: person.workspaceId }), (listed) => {
			const wanted = handle.trim().replace(/^@/, "");
			const found = listed.find((bot) => bot.handle === wanted && !bot.assistant);
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
						const projects = yield* projectAdministration.list({ workspace });
						// The person's own Personal Assistant is among the bots they reach, but is
						// no bot to suggest to them: it is only named for its failing automations.
						const reachedBots = yield* bots.list({ workspace });
						const workspaceBots = reachedBots.filter((bot) => !bot.assistant);
						const handleOf = new Map(workspaceBots.map((bot) => [bot.id, `@${bot.handle}`]));
						const leadHandleOf = (botId: string | null) => (botId && handleOf.get(botId)) ?? null;
						// As things stand, not since the person last looked: reading a
						// failed run's conversation doesn't mend the automation. By the
						// project each is in, which the person reaches.
						const failing = yield* query((db) =>
							db
								.select({
									projectId: project.id,
									defaultOfBotId: project.defaultOfBotId,
									count: sql<number>`count(*)::int`,
								})
								.from(automation)
								.innerJoin(project, eq(project.id, automation.projectId))
								.where(
									and(
										eq(automation.workspaceId, workspace),
										isNull(automation.deletedAt),
										automationFailing(),
										reachesProjectFor(project.id, person.userId),
									),
								)
								.groupBy(project.id, project.defaultOfBotId),
						);
						const unreadMentions = yield* view.unreadMentions(workspace, LISTED_ITEMS);
						const approvals = yield* view.approvals(workspace);
						const { workspaceSlug } = person;
						return {
							projects: projects.map((project) => ({
								name: project.name,
								address: project.slug,
								link: linkTo(projectPath(workspaceSlug, project.slug)),
								description: project.description,
								private: project.visibility === "private",
								youAreIn: project.isMember,
								lead: leadHandleOf(project.leadBotId),
							})),
							bots: workspaceBots.map((bot) => ({
								name: bot.name,
								handle: `@${bot.handle}`,
								link: linkTo(botPath(workspaceSlug, bot.handle)),
								description: bot.description,
								private: bot.visibility === "private",
								pinned: bot.pinned,
								youCanTalkToIt: bot.permissions.talk,
							})),
							waitingOnYou: {
								approvals: approvals.waiting.slice(0, LISTED_ITEMS).map((request) => ({
									bot: request.bot.name,
									tool: request.call.tool,
									link: linkTo(approvalPath(workspaceSlug, request.call.id)),
								})),
								unreadMentions: unreadMentions.map((mention) => ({
									from: mention.authorName,
									preview: mention.preview,
									link: linkTo(
										inboxPath(workspaceSlug, mention.rootConversationId, {
											message: mention.messageId,
										}),
									),
								})),
								// A bot's own automations are in its default project, and named by the bot.
								failingAutomations: failing.flatMap(
									({ projectId, defaultOfBotId, count }): FailingAutomations[] => {
										const bot = reachedBots.find((one) => one.id === defaultOfBotId);
										if (bot) {
											return [
												{
													bot: bot.name,
													failing: count,
													link: linkTo(
														automationsPagePath({ workspaceSlug, botHandle: bot.handle }),
													),
												},
											];
										}
										const inProject = projects.find((one) => one.id === projectId);
										return inProject
											? [
													{
														project: inProject.name,
														failing: count,
														link: linkTo(
															automationsPagePath({ workspaceSlug, projectSlug: inProject.slug }),
														),
													},
												]
											: [];
									},
								),
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

		createProject: (person, project) =>
			operation(
				"createProject",
				asPerson(
					person,
					Effect.gen(function* () {
						const lead = yield* botWithHandle(person, project.lead);
						const made = yield* projectAdministration.create({
							workspace: person.workspaceId,
							name: project.name,
							description: project.description ?? null,
							visibility: project.private ? "private" : "public",
							leadBotId: lead.id,
						});
						return { name: made.name, link: linkTo(projectPath(person.workspaceSlug, made.slug)) };
					}),
				),
			),

		joinProject: (person, address) =>
			operation(
				"joinProject",
				asPerson(
					person,
					Effect.gen(function* () {
						const found = yield* projectAt(person, address);
						const joined = yield* projectAdministration.join({ projectId: found.id });
						return {
							name: joined.name,
							link: linkTo(projectPath(person.workspaceSlug, joined.slug)),
						};
					}),
				),
			),

		addBotToProject: (person, target) =>
			operation(
				"addBotToProject",
				asPerson(
					person,
					Effect.gen(function* () {
						const project = yield* projectAt(person, target.project);
						const bot = yield* botWithHandle(person, target.bot);
						yield* projectAdministration.addBot({ projectId: project.id, botId: bot.id });
						return {
							name: project.name,
							link: linkTo(projectPath(person.workspaceSlug, project.slug)),
						};
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
						return { name: bot.name, link: linkTo(botPath(person.workspaceSlug, bot.handle)) };
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
		Layer.provide([ProjectAdministration.layer, BotAdministration.layer, ChatView.layer]),
	),
);

/** The person a Personal Assistant works for, in their workspace. */
export interface Person {
	readonly userId: string;
	readonly workspaceId: string;
	readonly workspaceSlug: string;
}

/** A project or bot something was done to, by its name and where it opens. */
export interface Place {
	readonly name: string;
	readonly link: string;
}

/** The most of each kind of waiting item the guide lists. */
const LISTED_ITEMS = 10;

/** The workspace as the assistant's person sees it. */
export interface Guide {
	readonly projects: ReadonlyArray<{
		name: string;
		address: string;
		link: string;
		description: string | null;
		private: boolean;
		youAreIn: boolean;
		/** The lead bot's handle; null until somebody chooses one. */
		lead: string | null;
	}>;
	readonly bots: ReadonlyArray<{
		name: string;
		handle: string;
		link: string;
		description: string | null;
		private: boolean;
		pinned: boolean;
		youCanTalkToIt: boolean;
	}>;
	readonly waitingOnYou: {
		approvals: ReadonlyArray<{ bot: string; tool: string; link: string }>;
		unreadMentions: ReadonlyArray<{ from: string; preview: string; link: string }>;
		failingAutomations: ReadonlyArray<FailingAutomations>;
	};
}

/**
 * How many automations are failing in one place the person reaches: a bot's
 * own, named by the bot, or a project's, named by the project.
 */
type FailingAutomations = ({ bot: string } | { project: string }) & {
	failing: number;
	link: string;
};

/** Why something the assistant did for its person was refused, in words it can pass on. */
export type Refused =
	| AuthorizationDenied
	| NothingNamed
	| ProjectAdministration.InvalidProjectDetails
	| ProjectAdministration.UnusableProjectName
	| ProjectRepository.ProjectSlugTaken
	| ProjectRepository.BotNotPublic
	| ProjectAdministration.NotInWorkspace;

/** No project or bot the person can see has the address or handle the assistant gave. */
export class NothingNamed
	extends Data.TaggedError("NothingNamed")<{ readonly what: "project" | "bot" }>
	implements UserFacing
{
	get userMessage() {
		return this.what === "project"
			? userText`There is no project at that address that you can see.`
			: userText`There is no bot with that handle that you can see.`;
	}
}
