export * as WorkspaceGuide from "./workspace-guide.ts";

import type { WorkspaceGuide as Guide } from "@sugabots/contracts/workspace-guide";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import { automation, project } from "../../database/schema.ts";
import type { Approved } from "../../proofs/approved.ts";
import type { ReachSet } from "../../proofs/reach-set.ts";
import type { CanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import {
	approvalPath,
	automationsPagePath,
	botPath,
	chatPath,
	projectPath,
} from "../../server-settings/web-app-paths.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { workspaceSlugOf } from "../../workspaces/workspace-reference.ts";
import { automationFailing } from "../automations/execution.ts";
import { ChatView } from "../chats/chat-view.ts";

/**
 * A Personal Assistant's view of its member's workspace, for an operation
 * that proved what its reader reaches: the projects and bots its member sees,
 * with what each is for, and what is waiting on them, each with its link.
 */
export interface Interface {
	/**
	 * The workspace as the member `canRead` names sees it, and what waits on
	 * them in what `reach` reaches.
	 */
	readonly guide: <P, W, X>(
		canRead: CanReadWorkspace<P, W>,
		reach: ReachSet<P, W>,
		approved: Approved<NoInfer<P>, X>,
	) => Effect.Effect<Guide>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/WorkspaceGuide",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("WorkspaceGuide");
	const projects = yield* Projects.Service;
	const bots = yield* Bots.Service;
	const view = yield* ChatView.Service;
	const { webAppUrl } = yield* ServerSettings.Service;

	/** `path` from the web app's root, as a link the member can follow. */
	const linkTo = (path: string) => `${webAppUrl}${path}`;

	return Service.of({
		guide: (canRead, reach) =>
			operation(
				"guide",
				Effect.gen(function* () {
					const workspaceId = reach.workspace.value;
					const workspaceSlug = yield* workspaceSlugOf(workspaceId);
					const listedProjects = yield* projects.list(canRead);
					// The member's own Personal Assistant is among the bots they reach, but is
					// no bot to suggest to them: it is only named for its failing automations.
					const reachedBots = yield* bots.list(canRead);
					const workspaceBots = reachedBots.filter((bot) => !bot.assistant);
					const handleOf = new Map(workspaceBots.map((bot) => [bot.id, `@${bot.handle}`]));
					const leadHandleOf = (botId: string) => {
						const handle = handleOf.get(botId);
						// A lead is a public bot, which everyone in the workspace reaches.
						if (!handle) throw new Error("A project's lead bot is out of its member's reach");
						return handle;
					};
					const failing = yield* query((db) => failingAutomationsByProject(db, workspaceId, reach));
					const unreadMentions = yield* view.unreadMentions(canRead, reach, LISTED_ITEMS);
					const approvals = yield* view.approvals(canRead, reach);
					return {
						workspaceId,
						projects: listedProjects.map((listed) => ({
							id: listed.id,
							name: listed.name,
							address: listed.slug,
							link: linkTo(projectPath(workspaceSlug, listed.slug)),
							description: listed.description,
							private: listed.visibility === "private",
							youAreIn: listed.isMember,
							lead: leadHandleOf(listed.leadBotId),
						})),
						bots: workspaceBots.map((bot) => ({
							id: bot.id,
							name: bot.name,
							handle: `@${bot.handle}`,
							link: linkTo(botPath(workspaceSlug, bot.handle)),
							description: bot.description ?? null,
							personal: bot.visibility === "personal",
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
									chatPath({ workspaceSlug, projectSlug: mention.projectSlug }, mention.chatId, {
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
												link: linkTo(automationsPagePath({ workspaceSlug, botHandle: bot.handle })),
											},
										];
									}
									const inProject = listedProjects.find((one) => one.id === projectId);
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
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([Projects.layer, Bots.layer, ChatView.layer]));

type FailingAutomations = Guide["waitingOnYou"]["failingAutomations"][number];

/** The most of each kind of waiting item the guide lists. */
const LISTED_ITEMS = 10;

/**
 * How many automations are failing in each project of the workspace `reach`
 * reaches, as things stand, not since the member last looked: reading a
 * failed run's chat doesn't mend the automation.
 */
const failingAutomationsByProject = <P, W>(
	db: Executor,
	workspaceId: string,
	reach: ReachSet<P, W>,
) =>
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
				eq(automation.workspaceId, workspaceId),
				isNull(automation.deletedAt),
				automationFailing(),
				reach.reachesProject(project.id),
			),
		)
		.groupBy(project.id, project.defaultOfBotId);
