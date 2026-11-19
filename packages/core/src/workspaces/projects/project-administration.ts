export * as ProjectAdministration from "./project-administration.ts";

import {
	type Bot,
	newProjectSchema,
	PROJECT_DESCRIPTION_MAX_LENGTH,
	PROJECT_NAME_MAX_LENGTH,
	type Project,
	type ProjectColor,
	type ProjectMember,
	type ProjectUpdate,
	type ProjectVisibility,
	projectSlugSchema,
	slugify,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Context, Data, Effect, Layer, Schema } from "effect";
import {
	type AuthorizationDenied,
	joinedStanding,
	listedProjectStandingsFor,
	ResourceHidden,
} from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { projectPermissions } from "../../authorization/permissions.ts";
import type { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { query, serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { personFacingBotRow, toBot } from "../bots/bot.ts";
import { projectSeenBy } from "./project.ts";
import type { LeadsProjects } from "./project-leads.ts";
import { projectHeadcounts, projectMembers } from "./project-reads.ts";
import { ProjectRepository } from "./project-repository.ts";

/**
 * A workspace's projects, who is in them, and their bots. Projects are
 * returned as the current actor sees them, permissions and all. A bot's
 * default project is never listed, and nothing here changes one: its
 * permissions refuse it (see `mayInProject`).
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
		| ProjectRepository.ProjectSlugTaken
		| ProjectRepository.BotNotPublic,
		CurrentActor.Service
	>;
	/** Changes the project, its lead bot included, which must be public. */
	readonly update: (input: {
		projectId: string;
		changes: ProjectUpdate;
	}) => Effect.Effect<
		Project,
		| AuthorizationDenied
		| EmptyProjectUpdate
		| ProjectRepository.ProjectGone
		| ProjectRepository.ProjectSlugTaken
		| ProjectRepository.BotNotPublic,
		CurrentActor.Service
	>;
	/**
	 * Deletes the project, with everything in it. Its computer is destroyed at
	 * its provider first, since its record is the only way to find the machine:
	 * when the provider can't be reached the project is kept, to try again.
	 */
	readonly remove: (input: {
		projectId: string;
	}) => Effect.Effect<void, AuthorizationDenied | Computers.Unavailable, CurrentActor.Service>;
	readonly members: (input: {
		projectId: string;
	}) => Effect.Effect<ProjectMember[], AuthorizationDenied, CurrentActor.Service>;
	/** Adds `userId` to the project. Adding somebody already in it changes nothing. */
	readonly addMember: (input: {
		projectId: string;
		userId: string;
	}) => Effect.Effect<void, AuthorizationDenied | NotInWorkspace, CurrentActor.Service>;
	/** Takes `userId` out of the project. Refuses an administrator, who belongs to every one. */
	readonly removeMember: (input: {
		projectId: string;
		userId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | AdministratorInEveryProject | NotInProject,
		CurrentActor.Service
	>;
	/** Takes the caller out of the project, on the same terms as {@link Interface.removeMember}. */
	readonly leave: (input: {
		projectId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | AdministratorInEveryProject | NotInProject,
		CurrentActor.Service
	>;
	/** Puts the caller in a public project. Joining one they are in changes nothing. */
	readonly join: (input: {
		projectId: string;
	}) => Effect.Effect<Project, AuthorizationDenied, CurrentActor.Service>;
	/** The project's bots, by name. */
	readonly bots: (input: {
		projectId: string;
	}) => Effect.Effect<Bot[], AuthorizationDenied, CurrentActor.Service>;
	readonly addBot: (input: {
		projectId: string;
		botId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | ProjectRepository.BotNotPublic,
		CurrentActor.Service
	>;
	/** Refused for the project's lead bot, until another is chosen. */
	readonly removeBot: (input: {
		projectId: string;
		botId: string;
	}) => Effect.Effect<void, AuthorizationDenied | LeadsProjects, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ProjectAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ProjectAdministration");
	const authorization = yield* Authorization.Service;
	const projects = yield* ProjectRepository.Service;
	const projectComputers = yield* ProjectComputers.Service;

	const takeOut = (project: schema.ProjectRow, userId: string) =>
		Effect.gen(function* () {
			const outcome = yield* projects.removeMember(project.workspaceId, project.id, userId);
			switch (outcome) {
				case "removed":
					return;
				case "administrator":
					return yield* new AdministratorInEveryProject();
				case "not_a_member":
					return yield* new NotInProject();
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
						listedProjectStandingsFor(db, workspaceId, actor.userId),
					);
					// Counted only where the actor may list who is in the project, as its own lists would.
					const headcountOf = yield* projectHeadcounts(
						listed
							.filter((standing) => standing.may("project.read"))
							.map(({ project }) => project.id),
					);
					return listed.map((standing): Project => {
						const seen = projectSeenBy(standing);
						return standing.may("project.read") ? { ...seen, ...headcountOf(seen.id) } : seen;
					});
				}),
			),

		create: ({ workspace, slug: givenSlug, ...input }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"project.create",
					);
					// A bot the person can't see is answered as if it weren't there.
					yield* authorization.bot(input.leadBotId, "bot.read");
					// Checked here, not only by the HTTP API, for callers such as the
					// Personal Assistant that don't come through it.
					const details = yield* Schema.decodeUnknownEffect(projectDetailsSchema)({
						name: input.name,
						description: input.description,
					}).pipe(Effect.mapError(() => new InvalidProjectDetails()));
					// Checked before anything is written, so an unsluggable name such as
					// "!!!" is refused for the name rather than as a taken address.
					const slug = yield* Schema.decodeUnknownEffect(projectSlugSchema)(
						givenSlug ?? slugify(details.name),
					).pipe(Effect.mapError(() => new UnusableProjectName()));
					const row = yield* projects.create(workspaceId, {
						creatorId: actor.userId,
						slug,
						...input,
						...details,
					});
					return projectSeenBy(joinedStanding(row, actor));
				}),
			),

		update: ({ projectId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const standing = yield* authorization.project(projectId, "project.update");
					if (Object.values(changes).every((value) => value === undefined)) {
						return yield* new EmptyProjectUpdate();
					}
					if (changes.leadBotId !== undefined) {
						yield* authorization.bot(changes.leadBotId, "bot.read");
					}
					const updated = yield* projects.update(
						standing.project.workspaceId,
						standing.project.id,
						changes,
					);
					return projectSeenBy({ ...standing, project: updated });
				}),
			),

		remove: ({ projectId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { project } = yield* authorization.project(projectId, "project.delete");
					yield* projectComputers.destroy({
						workspaceId: project.workspaceId,
						projectId: project.id,
					});
					yield* projects.remove(project.workspaceId, project.id);
				}),
			),

		members: ({ projectId }) =>
			operation(
				"members",
				Effect.flatMap(authorization.project(projectId, "project.read"), ({ project }) =>
					projectMembers(project.id),
				),
			),

		addMember: ({ projectId, userId }) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					const { project } = yield* authorization.project(projectId, "project.members.manage");
					const outcome = yield* projects.addMember(project.workspaceId, project.id, userId);
					if (outcome === "not_workspace_member") return yield* new NotInWorkspace();
				}),
			),

		removeMember: ({ projectId, userId }) =>
			operation(
				"removeMember",
				Effect.gen(function* () {
					const { project } = yield* authorization.project(projectId, "project.members.manage");
					return yield* takeOut(project, userId);
				}),
			),

		leave: ({ projectId }) =>
			operation(
				"leave",
				Effect.gen(function* () {
					const { project, actor } = yield* authorization.project(projectId, "project.leave");
					return yield* takeOut(project, actor.userId);
				}),
			),

		join: ({ projectId }) =>
			operation(
				"join",
				Effect.gen(function* () {
					const standing = yield* authorization.projectFound(projectId);
					const project = standing.project;
					if (!standing.facts.isMember) {
						// A project the actor may not join, a private one or a bot's default
						// project, is answered as if it weren't there.
						const isPublic = project.visibility === "public";
						if (!projectPermissions(standing.actor, { ...standing.facts, isPublic }).join) {
							return yield* new ResourceHidden({ resource: "project" });
						}
						yield* projects.addMember(project.workspaceId, project.id, standing.actor.userId);
					}
					return projectSeenBy(joinedStanding(project, standing.actor));
				}),
			),

		bots: ({ projectId }) =>
			operation(
				"bots",
				Effect.gen(function* () {
					const { project, actor } = yield* authorization.project(projectId, "project.read");
					return (yield* projects.bots(project.id, actor.userId)).flatMap((row) => {
						const bot = personFacingBotRow(row);
						return bot
							? [
									toBot(
										{ ...bot, defaultProjectId: row.defaultProjectId, createdBy: row.createdBy },
										{ actor, pinned: row.pinned },
									),
								]
							: [];
					});
				}),
			),

		addBot: ({ projectId, botId }) =>
			operation(
				"addBot",
				Effect.gen(function* () {
					const { project } = yield* authorization.project(projectId, "project.bots.manage");
					// A bot the person can't see is answered as if it weren't there.
					yield* authorization.bot(botId, "bot.read");
					yield* projects.addBot(project.workspaceId, project.id, botId);
				}),
			),

		removeBot: ({ projectId, botId }) =>
			operation(
				"removeBot",
				Effect.flatMap(authorization.project(projectId, "project.bots.manage"), ({ project }) =>
					projects.removeBot(project.workspaceId, project.id, botId),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, ProjectRepository.layer, ProjectComputers.layer]),
);

/** A project update that names nothing to change. */
export class EmptyProjectUpdate
	extends Data.TaggedError("EmptyProjectUpdate")
	implements UserFacing
{
	get userMessage() {
		return userText`Nothing to change`;
	}
}

/** Administrators belong to every project, so nobody takes one out of it. */
export class AdministratorInEveryProject
	extends Data.TaggedError("AdministratorInEveryProject")
	implements UserFacing
{
	get userMessage() {
		return userText`Administrators are in every project`;
	}
}

/** A project's name and description, as every caller must give them. */
const projectDetailsSchema = Schema.Struct({
	name: newProjectSchema.fields.name,
	description: newProjectSchema.fields.description,
});

/** A project's name is empty or too long, or its description too long. */
export class InvalidProjectDetails
	extends Data.TaggedError("InvalidProjectDetails")
	implements UserFacing
{
	get userMessage() {
		return userText`A project's name must be 1 to ${PROJECT_NAME_MAX_LENGTH} characters, and its description at most ${PROJECT_DESCRIPTION_MAX_LENGTH}.`;
	}
}

/** No address can be derived from the name a project was given. */
export class UnusableProjectName
	extends Data.TaggedError("UnusableProjectName")
	implements UserFacing
{
	get userMessage() {
		return userText`That name can't be a project's address. Choose another.`;
	}
}

/** Only a member of the project's workspace can be added to it. */
export class NotInWorkspace extends Data.TaggedError("NotInWorkspace") implements UserFacing {
	get userMessage() {
		return userText`That person is not in this workspace`;
	}
}

export class NotInProject extends Data.TaggedError("NotInProject") implements UserFacing {
	get userMessage() {
		return userText`That person is not in this project`;
	}
}
