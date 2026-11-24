import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ProjectAdministration } from "@sugabots/core/workspaces/projects/project-administration";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
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
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("create", ({ params, payload }) =>
				projects
					.create({ workspace: params.workspace, ...payload })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("update", ({ params, payload }) =>
				projects
					.update({ projectId: params.projectId, changes: payload })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("remove", ({ params }) =>
				projects
					.remove({ projectId: params.projectId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("listMembers", ({ params }) =>
				projects
					.members({ projectId: params.projectId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("listMembersReaching", ({ params }) =>
				projects
					.membersReaching({ projectId: params.projectId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("addMember", ({ params, payload }) =>
				projects
					.addMember({ projectId: params.projectId, memberId: payload.memberId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("removeMember", ({ params }) =>
				projects
					.removeMember({ projectId: params.projectId, memberId: params.memberId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("leave", ({ params }) =>
				projects
					.leave({ projectId: params.projectId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("join", ({ params }) =>
				projects
					.join({ projectId: params.projectId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("listBots", ({ params }) =>
				projects
					.bots({ projectId: params.projectId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("addBot", ({ params, payload }) =>
				projects
					.addBot({ projectId: params.projectId, botId: payload.botId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
			)
			.handle("removeBot", ({ params }) =>
				projects
					.removeBot({ projectId: params.projectId, botId: params.botId })
					.pipe(asCurrentUser, asHttpError(projectErrors)),
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
	ComputerMadeMeanwhile: Conflict,
};
