import { PERSONAL_POD_SLUG, sharedPodSlugSchema, slugify } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import type { PodSandboxStore } from "@sugabots/core/sandboxes/store";
import {
	type FacilitatorNotSetUp,
	type PersonalPodFixed,
	type PodStore,
	podSeenBy,
	type SlugTaken,
} from "@sugabots/core/workspaces/pods/store";
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

export interface PodRoutesOptions {
	pods: PodStore;
	modelProviders: Pick<ModelProviderStore, "isEnabled">;
	/** So a deleted pod's sandbox goes with it, rather than running on with nothing pointing at it. */
	podSandboxes?: Pick<PodSandboxStore, "discard">;
}

const slugIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export function podRoutes({ pods, modelProviders, podSandboxes }: PodRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "pods", (handlers) =>
		handlers
			.handle("list", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					pods.listVisible(workspaceId, actor),
				),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* grantedWorkspace;
					// Derived here rather than in the store, so an unsluggable name such
					// as "!!!", or one only a Personal pod may have, is a bad request about
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
						.create(workspaceId, actor, {
							name: payload.name,
							slug: slug.success,
							color: payload.color,
						})
						.pipe(asHttpError(podErrors));
				}),
			)
			.handle("ensurePersonal", ({ payload }) =>
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* grantedWorkspace;
					if (!(yield* modelProviders.isEnabled(workspaceId, payload.model))) {
						return yield* new BadRequest({
							message: "That model is not enabled in this workspace",
						});
					}
					return yield* pods.ensurePersonal(workspaceId, actor, payload.model);
				}),
			)
			.handle("update", ({ payload }) =>
				Effect.gen(function* () {
					if (
						payload.name === undefined &&
						payload.slug === undefined &&
						payload.color === undefined &&
						payload.routing === undefined
					) {
						return yield* new BadRequest({ message: "Nothing to change" });
					}
					const standing = yield* grantedPod;
					const updated = yield* pods
						.update(standing.pod.workspaceId, standing.pod.id, payload)
						.pipe(asHttpError(podErrors));
					return podSeenBy({ ...standing, pod: updated });
				}),
			)
			.handle("remove", () =>
				Effect.flatMap(grantedPod, ({ pod }) =>
					(podSandboxes?.discard(pod.id) ?? Effect.void).pipe(
						Effect.andThen(pods.remove(pod.workspaceId, pod.id)),
						asHttpError(podErrors),
					),
				),
			)
			.handle("listMembers", () =>
				Effect.flatMap(grantedPod, ({ pod }) => pods.listMembers(pod.id)),
			)
			.handle("addMember", ({ payload }) =>
				Effect.gen(function* () {
					const { pod } = yield* grantedPod;
					const outcome = yield* pods.addMember(pod.workspaceId, pod.id, payload.userId);
					if (outcome === "personal_pod") {
						return yield* new BadRequest({ message: "Personal pods cannot have other members" });
					}
					if (outcome === "not_workspace_member") {
						return yield* new BadRequest({ message: "That person is not in this workspace" });
					}
				}),
			)
			.handle("removeMember", ({ params }) =>
				Effect.gen(function* () {
					const { pod } = yield* grantedPod;
					const outcome = yield* pods.removeMember(pod.workspaceId, pod.id, params.userId);
					if (outcome === "personal_pod") {
						return yield* new BadRequest({
							message: "Personal pod membership cannot be changed",
						});
					}
					if (outcome === "not_a_member") {
						return yield* new NotFound({ message: "That person is not in this pod" });
					}
				}),
			),
	);
}

/** What each way a pod write can fail means over HTTP. */
const podErrors = {
	SlugTaken: (failure: SlugTaken) => new Conflict({ message: failure.message }),
	PersonalPodFixed: (failure: PersonalPodFixed) => new BadRequest({ message: failure.message }),
	FacilitatorNotSetUp: (failure: FacilitatorNotSetUp) =>
		new BadRequest({ message: failure.message }),
	PodGone: () => new NotFound({ message: "No such pod" }),
};
