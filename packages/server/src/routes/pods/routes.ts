import { sharedPodSlugSchema, slugify } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import { userText } from "@sugabots/errors";
import { Effect, Result, Schema, SchemaIssue } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

const slugIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** Channels, and who and which bots are in them. `PodAdministration` decides who may do what. */
export const podRoutes = HttpApiBuilder.group(ServerApi, "pods", (handlers) =>
	Effect.gen(function* () {
		const pods = yield* PodAdministration.Service;
		return handlers
			.handle("list", ({ params }) =>
				pods.list({ workspace: params.workspace }).pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("create", ({ params, payload }) =>
				Effect.gen(function* () {
					// Derived before anything is written, so an unsluggable name such as
					// "!!!" is a bad request about the name rather than a slug conflict.
					const proposedSlug = payload.slug ?? slugify(payload.name);
					const slug = Schema.decodeResult(sharedPodSlugSchema)(proposedSlug);
					if (Result.isFailure(slug)) {
						return yield* new BadRequest({
							message: userText`That name cannot be a channel's address`,
							details: slugIssues(slug.failure.issue).issues,
						});
					}
					return yield* pods
						.create({
							workspace: params.workspace,
							name: payload.name,
							slug: slug.success,
							color: payload.color,
							description: payload.description,
							visibility: payload.visibility,
						})
						.pipe(asSessionUser, asHttpError(podErrors));
				}),
			)
			.handle("update", ({ params, payload }) =>
				pods
					.update({ podId: params.podId, changes: payload })
					.pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("remove", ({ params }) =>
				pods.remove({ podId: params.podId }).pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("listMembers", ({ params }) =>
				pods.members({ podId: params.podId }).pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("addMember", ({ params, payload }) =>
				pods
					.addMember({ podId: params.podId, userId: payload.userId })
					.pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("removeMember", ({ params }) =>
				pods
					.removeMember({ podId: params.podId, userId: params.userId })
					.pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("leave", ({ params }) =>
				pods.leave({ podId: params.podId }).pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("join", ({ params }) =>
				pods.join({ podId: params.podId }).pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("listBots", ({ params }) =>
				pods.bots({ podId: params.podId }).pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("addBot", ({ params, payload }) =>
				pods
					.addBot({ podId: params.podId, agentId: payload.agentId })
					.pipe(asSessionUser, asHttpError(podErrors)),
			)
			.handle("removeBot", ({ params }) =>
				pods
					.removeBot({ podId: params.podId, agentId: params.agentId })
					.pipe(asSessionUser, asHttpError(podErrors)),
			);
	}),
);

/** What each way a channel write can fail means over HTTP. */
const podErrors = {
	...refusals,
	PodSlugTaken: Conflict,
	EmptyPodUpdate: BadRequest,
	PodGone: NotFound,
	AdministratorInEveryChannel: BadRequest,
	NotInWorkspace: BadRequest,
	NotInPod: NotFound,
	BotNotPublic: BadRequest,
};
