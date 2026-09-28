export * as PodAdministration from "./pod-administration.ts";

import type { Pod, PodColor, PodMember, PodUpdate } from "@sugabots/contracts";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, podStanding } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { serviceOperations } from "../../database/database.ts";
import type { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { AgentRepository } from "../agents/agent-repository.ts";
import { FACILITATE_SYSTEM_AGENT } from "../agents/system-agents.ts";
import { PersonalPods } from "./personal-pods.ts";
import { podSeenBy } from "./pod.ts";
import { podMembers } from "./pod-reads.ts";
import { PodRepository } from "./pod-repository.ts";

/**
 * A workspace's pods, who is in them, and what each one is set up with. Pods
 * are returned as the current actor sees them, permissions and all.
 */
export interface Interface {
	/** The pods the actor reaches in the workspace, by name. */
	readonly list: (input: {
		workspace: string;
	}) => Effect.Effect<Pod[], AuthorizationDenied, CurrentActor.Service>;
	/** A shared pod with the actor in it. */
	readonly create: (input: {
		workspace: string;
		name: string;
		slug: string;
		color?: PodColor;
	}) => Effect.Effect<Pod, AuthorizationDenied | PodRepository.PodSlugTaken, CurrentActor.Service>;
	/** The actor's Personal pod, provisioned as {@link PersonalPods.Interface.provisionWithModel} does. */
	readonly ensurePersonal: (input: {
		workspace: string;
		model: string;
	}) => Effect.Effect<
		Pod,
		AuthorizationDenied | ModelProviderRepository.ModelNotEnabled,
		CurrentActor.Service
	>;
	readonly update: (input: {
		podId: string;
		changes: PodUpdate;
	}) => Effect.Effect<
		Pod,
		| AuthorizationDenied
		| EmptyPodUpdate
		| FacilitatorNotSetUp
		| PodRepository.PersonalPodFixed
		| PodRepository.PodGone
		| PodRepository.PodSlugTaken,
		CurrentActor.Service
	>;
	readonly remove: (input: {
		podId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | PodRepository.PersonalPodFixed,
		CurrentActor.Service
	>;
	readonly members: (input: {
		podId: string;
	}) => Effect.Effect<PodMember[], AuthorizationDenied, CurrentActor.Service>;
	/** Adds `userId` to the pod. Adding somebody already in it changes nothing. */
	readonly addMember: (input: {
		podId: string;
		userId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | PersonalPodMembershipFixed | NotInWorkspace,
		CurrentActor.Service
	>;
	/** Takes `userId` out of the pod. */
	readonly removeMember: (input: {
		podId: string;
		userId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | PersonalPodMembershipFixed | NotInPod,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PodAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PodAdministration");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const pods = yield* PodRepository.Service;
	const agents = yield* AgentRepository.Service;
	const personalPods = yield* PersonalPods.Service;

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(input.workspace, "workspace.read");
					return (yield* visibility.pods(workspaceId)).map(podSeenBy);
				}),
			),

		create: ({ workspace, name, slug, color }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(workspace, "pod.create");
					const row = yield* pods.create(workspaceId, {
						creatorId: actor.userId,
						name,
						slug,
						color,
					});
					return podSeenBy(podStanding(row, actor, true));
				}),
			),

		ensurePersonal: ({ workspace, model }) =>
			operation(
				"ensurePersonal",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"workspace.read",
					);
					const personal = yield* personalPods.provisionWithModel({
						workspaceId,
						userId: actor.userId,
						model,
					});
					return podSeenBy(podStanding(personal, actor, true));
				}),
			),

		update: ({ podId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const standing = yield* authorization.pod(podId, "pod.update");
					if (Object.values(changes).every((value) => value === undefined)) {
						return yield* new EmptyPodUpdate();
					}
					// The Facilitator runs on a model the workspace chooses once, so a pod
					// cannot hand it the floor before anybody has chosen one.
					if (
						changes.routing?.facilitator === true &&
						!(yield* agents.runnableSystemAgent(standing.pod.workspaceId, FACILITATE_SYSTEM_AGENT))
					) {
						return yield* new FacilitatorNotSetUp();
					}
					const updated = yield* pods.update(standing.pod.workspaceId, standing.pod.id, changes);
					return podSeenBy({ ...standing, pod: updated });
				}),
			),

		remove: ({ podId }) =>
			operation(
				"remove",
				Effect.flatMap(authorization.pod(podId, "pod.delete"), ({ pod }) =>
					pods.remove(pod.workspaceId, pod.id),
				),
			),

		members: ({ podId }) =>
			operation(
				"members",
				Effect.flatMap(authorization.pod(podId, "pod.read"), ({ pod }) => podMembers(pod.id)),
			),

		addMember: ({ podId, userId }) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					const { pod } = yield* authorization.pod(podId, "pod.members.manage");
					const outcome = yield* pods.addMember(pod.workspaceId, pod.id, userId);
					if (outcome === "personal_pod") {
						return yield* new PersonalPodMembershipFixed({ attempted: "add" });
					}
					if (outcome === "not_workspace_member") {
						return yield* new NotInWorkspace();
					}
				}),
			),

		removeMember: ({ podId, userId }) =>
			operation(
				"removeMember",
				Effect.gen(function* () {
					const { pod } = yield* authorization.pod(podId, "pod.members.manage");
					const outcome = yield* pods.removeMember(pod.workspaceId, pod.id, userId);
					if (outcome === "personal_pod") {
						return yield* new PersonalPodMembershipFixed({ attempted: "remove" });
					}
					if (outcome === "not_a_member") {
						return yield* new NotInPod();
					}
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		Visibility.layer,
		PodRepository.layer,
		AgentRepository.layer,
		PersonalPods.layer,
	]),
);

/**
 * A pod asked to route through the Facilitator before the workspace chose a
 * model for it: an impossible request rather than a forbidden one.
 */
export class FacilitatorNotSetUp
	extends Data.TaggedError("FacilitatorNotSetUp")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Choose a model for the Facilitator before a pod can route through it`;
	}
}

/** A pod update that names nothing to change. */
export class EmptyPodUpdate extends Data.TaggedError("EmptyPodUpdate") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Nothing to change`;
	}
}

/** A Personal pod has exactly one member, its owner. */
export class PersonalPodMembershipFixed
	extends Data.TaggedError("PersonalPodMembershipFixed")<{ readonly attempted: "add" | "remove" }>
	implements UserFacing
{
	get userMessage() {
		return this.attempted === "add"
			? UserMessage.of`Personal pods cannot have other members`
			: UserMessage.of`Personal pod membership cannot be changed`;
	}
}

/** Only a member of the pod's workspace can be added to it. */
export class NotInWorkspace extends Data.TaggedError("NotInWorkspace") implements UserFacing {
	get userMessage() {
		return UserMessage.of`That person is not in this workspace`;
	}
}

export class NotInPod extends Data.TaggedError("NotInPod") implements UserFacing {
	get userMessage() {
		return UserMessage.of`That person is not in this pod`;
	}
}
