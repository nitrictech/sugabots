import { PERSONAL_POD_SLUG, sharedPodSlugSchema, slugify } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import { Effect, Result, Schema, SchemaIssue } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

const slugIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** Pods, and who is in them. `PodAdministration` decides who may do what. */
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
					// "!!!", or one only a Personal pod may have, is a bad request about
					// the name rather than a slug conflict.
					const proposedSlug = payload.slug ?? slugify(payload.name);
					const slug = Schema.decodeResult(sharedPodSlugSchema)(proposedSlug);
					if (Result.isFailure(slug)) {
						return yield* new BadRequest({
							message:
								proposedSlug === PERSONAL_POD_SLUG
									? `"${PERSONAL_POD_SLUG}" is reserved for your Personal pod. Choose another name.`
									: "That name cannot be a pod's address",
							details: slugIssues(slug.failure.issue).issues,
						});
					}
					return yield* pods
						.create({
							workspace: params.workspace,
							name: payload.name,
							slug: slug.success,
							color: payload.color,
						})
						.pipe(asSessionUser, asHttpError(podErrors));
				}),
			)
			.handle("ensurePersonal", ({ params, payload }) =>
				pods
					.ensurePersonal({ workspace: params.workspace, model: payload.model })
					.pipe(asSessionUser, asHttpError(podErrors)),
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
			);
	}),
);

/** What each way a pod write can fail means over HTTP. */
const podErrors = {
	...refusals,
	PodSlugTaken: Conflict,
	PersonalPodFixed: BadRequest,
	FacilitatorNotSetUp: BadRequest,
	ModelNotEnabled: BadRequest,
	EmptyPodUpdate: BadRequest,
	PodGone: NotFound,
	PersonalPodMembershipFixed: BadRequest,
	AdministratorInEverySharedPod: BadRequest,
	NotInWorkspace: BadRequest,
	NotInPod: NotFound,
};
