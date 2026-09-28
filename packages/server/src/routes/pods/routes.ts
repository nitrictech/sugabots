import { PERSONAL_POD_SLUG, sharedPodSlugSchema, slugify } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import { Effect, Result, Schema, SchemaIssue } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedPod, grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

/**
 * Pods, and who is in them.
 *
 * Every endpoint names the action it performs in `PodsApi` and `Authorise`
 * decides it, so the rules live in
 * `packages/core/src/workspaces/permissions.ts` and not in each handler.
 */

const slugIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export const podRoutes = HttpApiBuilder.group(ServerApi, "pods", (handlers) =>
	Effect.gen(function* () {
		const pods = yield* PodAdministration.Service;
		return handlers
			.handle("list", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					pods.list({ workspaceId, actor }),
				),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* grantedWorkspace;
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
							workspaceId,
							creator: actor,
							name: payload.name,
							slug: slug.success,
							color: payload.color,
						})
						.pipe(asHttpError(podErrors));
				}),
			)
			.handle("ensurePersonal", ({ payload }) =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					pods
						.ensurePersonal({ workspaceId, owner: actor, model: payload.model })
						.pipe(asHttpError(podErrors)),
				),
			)
			.handle("update", ({ payload }) =>
				Effect.flatMap(grantedPod, (standing) =>
					pods.update({ standing, changes: payload }).pipe(asHttpError(podErrors)),
				),
			)
			.handle("remove", () =>
				Effect.flatMap(grantedPod, ({ pod }) =>
					pods.remove({ workspaceId: pod.workspaceId, podId: pod.id }).pipe(asHttpError(podErrors)),
				),
			)
			.handle("listMembers", () => Effect.flatMap(grantedPod, ({ pod }) => pods.members(pod.id)))
			.handle("addMember", ({ payload }) =>
				Effect.flatMap(grantedPod, ({ pod }) =>
					pods
						.addMember({ workspaceId: pod.workspaceId, podId: pod.id, userId: payload.userId })
						.pipe(asHttpError(podErrors)),
				),
			)
			.handle("removeMember", ({ params }) =>
				Effect.flatMap(grantedPod, ({ pod }) =>
					pods
						.removeMember({ workspaceId: pod.workspaceId, podId: pod.id, userId: params.userId })
						.pipe(asHttpError(podErrors)),
				),
			);
	}),
);

/** What each way a pod write can fail means over HTTP. */
const podErrors = {
	PodSlugTaken: Conflict,
	PersonalPodFixed: BadRequest,
	FacilitatorNotSetUp: BadRequest,
	ModelNotEnabled: BadRequest,
	EmptyPodUpdate: BadRequest,
	PodGone: NotFound,
	PersonalPodMembershipFixed: BadRequest,
	NotInWorkspace: BadRequest,
	NotInPod: NotFound,
};
