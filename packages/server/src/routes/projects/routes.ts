import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** Projects, and who and which bots are in them, each endpoint its operation. */
export const projectRoutes = HttpApiBuilder.group(ServerApi, "projects", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("list", ({ params }) =>
				callOperation("projects.list", { workspace: params.workspace }).pipe(
					asHttpError(projectErrors),
				),
			)
			.handle("create", ({ params, payload }) =>
				callOperation("projects.create", { workspace: params.workspace, ...payload }).pipe(
					Effect.catchTags(botCallRefusals),
					asHttpError(projectErrors),
				),
			)
			.handle("update", ({ params, payload }) =>
				callOperation("projects.update", { projectId: params.projectId, changes: payload }).pipe(
					asHttpError(projectErrors),
				),
			)
			.handle("remove", ({ params }) =>
				callOperation("projects.remove", { projectId: params.projectId }).pipe(
					asHttpError(projectErrors),
				),
			)
			.handle("listMembers", ({ params }) =>
				callOperation("projects.listMembers", { projectId: params.projectId }).pipe(
					asHttpError(projectErrors),
				),
			)
			.handle("listMembersReaching", ({ params }) =>
				callOperation("projects.listMembersReaching", { projectId: params.projectId }).pipe(
					asHttpError(projectErrors),
				),
			)
			.handle("addMember", ({ params, payload }) =>
				callOperation("projects.addMember", {
					projectId: params.projectId,
					memberId: payload.memberId,
				}).pipe(asHttpError(projectErrors)),
			)
			.handle("removeMember", ({ params }) =>
				callOperation("projects.removeMember", {
					projectId: params.projectId,
					memberId: params.memberId,
				}).pipe(asHttpError(projectErrors)),
			)
			.handle("leave", ({ params }) =>
				callOperation("projects.leave", { projectId: params.projectId }).pipe(
					asHttpError(projectErrors),
				),
			)
			.handle("join", ({ params }) =>
				callOperation("projects.join", { projectId: params.projectId }).pipe(
					Effect.catchTags(botCallRefusals),
					asHttpError(projectErrors),
				),
			)
			.handle("listBots", ({ params }) =>
				callOperation("projects.listBots", { projectId: params.projectId }).pipe(
					asHttpError(projectErrors),
				),
			)
			.handle("addBot", ({ params, payload }) =>
				callOperation("projects.addBot", {
					projectId: params.projectId,
					botId: payload.botId,
				}).pipe(Effect.catchTags(botCallRefusals), asHttpError(projectErrors)),
			)
			.handle("removeBot", ({ params }) =>
				callOperation("projects.removeBot", {
					projectId: params.projectId,
					botId: params.botId,
				}).pipe(asHttpError(projectErrors)),
			),
	),
);

/** What each way a projects operation can fail means over HTTP. */
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
	ClaimLost: Conflict,
};

/**
 * How the operation refuses a bot's call, waiting for approval or outside
 * its turn, which a member signed in never meets.
 */
const botCallRefusals = {
	ApprovalNeeded: Effect.die,
	ApprovalRefused: Effect.die,
	TurnEnded: Effect.die,
	TurnExecutionSuperseded: Effect.die,
};
