import {
	modelIdSchema,
	newPodMemberSchema,
	newPodSchema,
	podSlugSchema,
	podUpdateSchema,
	slugify,
} from "@sugabots/contracts";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import {
	type FacilitatorNotSetUp,
	type PersonalPodFixed,
	type PodStore,
	podSeenBy,
	type SlugTaken,
} from "@sugabots/core/workspaces/pods/store";
import { Result, Schema } from "effect";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requirePod, requireWorkspace } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

/**
 * Pods, and who is in them.
 *
 * Every route names the action it performs and `requireWorkspace` /
 * `requirePod` decide it, so the rules live in
 * `packages/core/src/workspaces/permissions.ts` and not in each handler.
 *
 * Domain law — a Personal pod cannot be renamed, deleted or given other
 * members — is separate from who may act, and lives in the store, which is the
 * only thing that can enforce it whatever reaches it. The handlers here only
 * say what each refusal means over HTTP.
 *
 * The chain matters: `packages/sdk` is typed from the shape of the chain,
 * so a route registered on a separate statement would be invisible to it.
 */

export interface PodRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	pods: PodStore;
	modelProviders: Pick<ModelProviderStore, "isEnabled">;
}

export function createPodRoutes({
	resolveSession,
	authorization,
	run,
	pods,
	modelProviders,
}: PodRoutesOptions) {
	const session = requireSession(resolveSession);
	const inWorkspace = requireWorkspace(authorization, run, "workspace.read");
	const mayCreatePods = requireWorkspace(authorization, run, "pod.create");
	const readsPod = requirePod(authorization, run, "pod.read");
	const updatesPod = requirePod(authorization, run, "pod.update");
	const deletesPod = requirePod(authorization, run, "pod.delete");
	const managesMembers = requirePod(authorization, run, "pod.members.manage");

	return (
		new Hono<AuthEnv>()
			.get("/workspaces/:workspaceId/pods", session, inWorkspace, async (c) => {
				const { workspaceId, actor } = c.get("workspace");
				return c.json(await run(pods.listVisible(workspaceId, actor)));
			})

			.post(
				"/workspaces/:workspaceId/pods",
				session,
				mayCreatePods,
				body(newPodSchema),
				async (c) => {
					const input = c.req.valid("json");
					// Derived here rather than in the store, so an unsluggable name such
					// as "!!!" is a bad request about the name, not a slug conflict.
					const slug = Schema.decodeResult(podSlugSchema)(input.slug ?? slugify(input.name));
					if (Result.isFailure(slug)) {
						throw new HttpError("bad_request", "A pod name needs letters or numbers");
					}

					const pod = await run(
						pods
							.create(c.get("workspace").workspaceId, c.get("workspace").actor, {
								name: input.name,
								slug: slug.success,
							})
							.pipe(asHttpError(podErrors)),
					);
					return c.json(pod, 201);
				},
			)

			.post(
				"/workspaces/:workspaceId/personal-pod",
				session,
				inWorkspace,
				body(Schema.Struct({ model: modelIdSchema })),
				async (c) => {
					const model = c.req.valid("json").model;
					const { workspaceId, actor } = c.get("workspace");
					if (!(await run(modelProviders.isEnabled(workspaceId, model)))) {
						throw new HttpError("bad_request", "That model is not enabled in this workspace");
					}
					const personal = await run(pods.ensurePersonal(workspaceId, actor, model));
					return c.json(personal, 201);
				},
			)

			.get("/pods/:podId", session, readsPod, (c) => c.json(podSeenBy(c.get("pod"))))

			.patch("/pods/:podId", session, updatesPod, body(podUpdateSchema), async (c) => {
				const input = c.req.valid("json");
				if (input.name === undefined && input.slug === undefined && input.routing === undefined) {
					throw new HttpError("bad_request", "Nothing to change");
				}
				const standing = c.get("pod");
				const updated = await run(
					pods
						.update(standing.pod.workspaceId, standing.pod.id, input)
						.pipe(asHttpError(podErrors)),
				);
				return c.json(podSeenBy({ ...standing, pod: updated }));
			})

			.delete("/pods/:podId", session, deletesPod, async (c) => {
				const { pod } = c.get("pod");
				await run(pods.remove(pod.workspaceId, pod.id).pipe(asHttpError(podErrors)));
				return c.body(null, 204);
			})

			.get("/pods/:podId/members", session, readsPod, async (c) =>
				c.json(await run(pods.listMembers(c.get("pod").pod.id))),
			)

			// Reached without pod membership: this is how the first person is added
			// to a pod the admin is not in themselves.
			.post(
				"/pods/:podId/members",
				session,
				managesMembers,
				body(newPodMemberSchema),
				async (c) => {
					const { userId } = c.req.valid("json");
					const { pod } = c.get("pod");
					const outcome = await run(pods.addMember(pod.workspaceId, pod.id, userId));
					if (outcome === "personal_pod") {
						throw new HttpError("bad_request", "Personal pods cannot have other members");
					}
					if (outcome === "not_workspace_member") {
						throw new HttpError("bad_request", "That person is not in this workspace");
					}
					return c.body(null, 204);
				},
			)

			.delete("/pods/:podId/members/:userId", session, managesMembers, async (c) => {
				const { pod } = c.get("pod");
				const outcome = await run(
					pods.removeMember(pod.workspaceId, pod.id, c.req.param("userId")),
				);
				if (outcome === "personal_pod") {
					throw new HttpError("bad_request", "Personal pod membership cannot be changed");
				}
				if (outcome === "not_a_member") {
					throw new HttpError("not_found", "That person is not in this pod");
				}
				return c.body(null, 204);
			})
	);
}

/** What each way a pod write can fail means over HTTP. */
const podErrors = {
	SlugTaken: (failure: SlugTaken) => new HttpError("conflict", failure.message),
	PersonalPodFixed: (failure: PersonalPodFixed) => new HttpError("bad_request", failure.message),
	FacilitatorNotSetUp: (failure: FacilitatorNotSetUp) =>
		new HttpError("bad_request", failure.message),
	PodGone: () => new HttpError("not_found", "No such pod"),
};
