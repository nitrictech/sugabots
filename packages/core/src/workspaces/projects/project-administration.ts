export {
	InvalidProjectDetails,
	NotInWorkspace,
	UnusableProjectName,
} from "@sugabots/contracts/errors/projects";
export * as ProjectAdministration from "./project-administration.ts";

import type { Project, ProjectColor, ProjectVisibility } from "@sugabots/contracts";
import type {
	InvalidProjectDetails,
	UnusableProjectName,
} from "@sugabots/contracts/errors/projects";
import { Context, Effect, Layer } from "effect";
import {
	type AuthorizationDenied,
	joinedStanding,
	ResourceHidden,
} from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { projectPermissions } from "../../authorization/permissions.ts";
import { serviceOperations } from "../../database/database.ts";
import { newProjectDetails, projectSeenBy } from "./project.ts";
import { projectsListedTo } from "./project-reads.ts";
import { ProjectStore } from "./project-store.ts";

/**
 * What a Personal Assistant's project tools do for its member, as the current
 * actor: list the workspace's projects, make one, join one and add a bot to
 * one. It exists only because those tools still call services directly; it
 * goes when tools become operations, called in the bot loop like any other
 * entrypoint's. Everything else, and the HTTP API, goes through the projects
 * operations and the `Projects` service, which demands proofs.
 */
export interface Interface {
	/** The projects the actor is in, and the public ones they could join, by name. */
	readonly list: (input: {
		workspace: string;
	}) => Effect.Effect<Project[], AuthorizationDenied, CurrentActor.Service>;
	/**
	 * A project with the actor in it, led by the public bot `leadBotId`, at the
	 * address `slug`, or one derived from its name when that is left out.
	 */
	readonly create: (input: {
		workspace: string;
		name: string;
		slug?: string;
		color?: ProjectColor;
		description?: string | null;
		visibility?: ProjectVisibility;
		leadBotId: string;
	}) => Effect.Effect<
		Project,
		| AuthorizationDenied
		| InvalidProjectDetails
		| UnusableProjectName
		| ProjectStore.ProjectSlugTaken
		| ProjectStore.BotNotPublic,
		CurrentActor.Service
	>;
	/** Puts the caller in a public project. Joining one they are in changes nothing. */
	readonly join: (input: {
		projectId: string;
	}) => Effect.Effect<Project, AuthorizationDenied, CurrentActor.Service>;
	readonly addBot: (input: {
		projectId: string;
		botId: string;
	}) => Effect.Effect<void, AuthorizationDenied | ProjectStore.BotNotPublic, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ProjectAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ProjectAdministration");
	const authorization = yield* Authorization.Service;
	const projects = yield* ProjectStore.Service;

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						input.workspace,
						"workspace.read",
					);
					return yield* projectsListedTo(workspaceId, actor.memberId);
				}),
			),

		create: ({ workspace, ...input }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"project.create",
					);
					// A bot the member can't see is answered as if it weren't there.
					yield* authorization.bot(input.leadBotId, "bot.read");
					const details = yield* newProjectDetails(input);
					const row = yield* projects.create(workspaceId, {
						...input,
						...details,
						creatorId: actor.memberId,
					});
					return projectSeenBy(joinedStanding(row, actor));
				}),
			),

		join: ({ projectId }) =>
			operation(
				"join",
				Effect.gen(function* () {
					const { project, facts, actor } = yield* authorization.projectFound(projectId);
					if (facts.isMember) return projectSeenBy(joinedStanding(project, actor));
					// A project the actor may not join, a private one or a bot's default
					// project, is answered as if it weren't there; checked again as they
					// join, in case it is made private or they leave the workspace meanwhile.
					const isPublic = project.visibility === "public";
					if (!projectPermissions(actor, { ...facts, isPublic }).join) {
						return yield* new ResourceHidden({ resource: "project" });
					}
					const joined = yield* projects.join(project.workspaceId, project.id, actor.memberId);
					if (!joined) return yield* new ResourceHidden({ resource: "project" });
					return projectSeenBy(joinedStanding(joined, actor));
				}),
			),

		addBot: ({ projectId, botId }) =>
			operation(
				"addBot",
				Effect.gen(function* () {
					const { project } = yield* authorization.project(projectId, "project.bots.manage");
					// A bot the member can't see is answered as if it weren't there.
					yield* authorization.bot(botId, "bot.read");
					yield* projects.addBot(project.workspaceId, project.id, botId);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, ProjectStore.layer]));
