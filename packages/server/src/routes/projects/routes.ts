import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ProjectAdministration } from "@sugabots/core/workspaces/projects/project-administration";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** Projects, and who and which bots are in them. `ProjectAdministration` decides who may do what. */
export const projectRoutes = HttpApiBuilder.group(ServerApi, "projects", (handlers) =>
	Effect.gen(function* () {
		const projects = yield* ProjectAdministration.Service;
		return handlers
			.handle("list", ({ params }) =>
				projects
					.list({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("create", ({ params, payload }) =>
				projects
					.create({ workspace: params.workspace, ...payload })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("update", ({ params, payload }) =>
				projects
					.update({ projectId: params.projectId, changes: payload })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("remove", ({ params }) =>
				projects
					.remove({ projectId: params.projectId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("listMembers", ({ params }) =>
				projects
					.members({ projectId: params.projectId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("addMember", ({ params, payload }) =>
				projects
					.addMember({ projectId: params.projectId, userId: payload.userId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("removeMember", ({ params }) =>
				projects
					.removeMember({ projectId: params.projectId, userId: params.userId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("leave", ({ params }) =>
				projects
					.leave({ projectId: params.projectId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("join", ({ params }) =>
				projects
					.join({ projectId: params.projectId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("listBots", ({ params }) =>
				projects
					.bots({ projectId: params.projectId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("addBot", ({ params, payload }) =>
				projects
					.addBot({ projectId: params.projectId, botId: payload.botId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			)
			.handle("removeBot", ({ params }) =>
				projects
					.removeBot({ projectId: params.projectId, botId: params.botId })
					.pipe(asSessionUser, asHttpError(projectErrors)),
			);
	}),
);

/** What each way a project write can fail means over HTTP. */
const projectErrors = {
	...refusals,
	UnusableProjectName: BadRequest,
	InvalidProjectDetails: BadRequest,
	ProjectSlugTaken: Conflict,
	EmptyProjectUpdate: BadRequest,
	ProjectGone: NotFound,
	AdministratorInEveryProject: BadRequest,
	NotInWorkspace: BadRequest,
	NotInProject: NotFound,
	BotNotPublic: BadRequest,
	LeadsProjects: Conflict,
	ComputerUnavailable: Conflict,
};
