export * as PodAdministration from "./pod-administration.ts";

import type { Pod, PodColor, PodMember, PodUpdate } from "@sugabots/contracts";
import { Context, Data, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { type PodStanding, podStanding } from "../access.ts";
import { AgentRepository } from "../agents/agent-repository.ts";
import { FACILITATE_SYSTEM_AGENT } from "../agents/system-agents.ts";
import type { Actor } from "../permissions.ts";
import { podSeenBy } from "./pod.ts";
import { podMembers, visiblePods } from "./pod-reads.ts";
import { PodRepository } from "./pod-repository.ts";

/** A workspace's pods, who is in them, and what each one is set up with. */
export interface Interface {
	/** The pods `actor` reaches in the workspace, by name. */
	readonly list: (input: { workspaceId: string; actor: Actor }) => Effect.Effect<Pod[]>;
	/** A shared pod with `creator` in it, as they see it. */
	readonly create: (input: {
		workspaceId: string;
		creator: Actor;
		name: string;
		slug: string;
		color?: PodColor;
	}) => Effect.Effect<Pod, PodRepository.PodSlugTaken>;
	/**
	 * Makes `userId`'s Personal pod and its Personal Assistant, each only if it
	 * is missing. A new assistant runs on
	 * {@link AgentRepository.FALLBACK_ASSISTANT_MODEL}.
	 */
	readonly provisionPersonal: (input: {
		workspaceId: string;
		userId: string;
	}) => Effect.Effect<schema.PodRow>;
	/**
	 * {@link Interface.provisionPersonal} on `model`, which the workspace must
	 * offer. An existing assistant moves to `model` only when the workspace
	 * does not offer the one it runs on, so a model its owner chose stays.
	 */
	readonly provisionPersonalWithModel: (input: {
		workspaceId: string;
		userId: string;
		model: string;
	}) => Effect.Effect<schema.PodRow, ModelProviderRepository.ModelNotEnabled>;
	/** {@link Interface.provisionPersonalWithModel} for `owner`, as they see the pod. */
	readonly ensurePersonal: (input: {
		workspaceId: string;
		owner: Actor;
		model: string;
	}) => Effect.Effect<Pod, ModelProviderRepository.ModelNotEnabled>;
	/** Changes the pod `standing` is towards, returning it as that caller sees it. */
	readonly update: (input: {
		standing: PodStanding;
		changes: PodUpdate;
	}) => Effect.Effect<
		Pod,
		| EmptyPodUpdate
		| FacilitatorNotSetUp
		| PodRepository.PersonalPodFixed
		| PodRepository.PodGone
		| PodRepository.PodSlugTaken
	>;
	readonly remove: (input: {
		workspaceId: string;
		podId: string;
	}) => Effect.Effect<void, PodRepository.PersonalPodFixed>;
	readonly members: (podId: string) => Effect.Effect<PodMember[]>;
	/** Adding somebody already in the pod changes nothing. */
	readonly addMember: (input: {
		workspaceId: string;
		podId: string;
		userId: string;
	}) => Effect.Effect<void, PersonalPodMembershipFixed | NotInWorkspace>;
	readonly removeMember: (input: {
		workspaceId: string;
		podId: string;
		userId: string;
	}) => Effect.Effect<void, PersonalPodMembershipFixed | NotInPod>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PodAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PodAdministration");
	const pods = yield* PodRepository.Service;
	const agents = yield* AgentRepository.Service;
	const modelProviders = yield* ModelProviderRepository.Service;

	const isOffered = (workspaceId: string, model: string | null) =>
		model === null ? Effect.succeed(false) : modelProviders.isEnabled(workspaceId, model);

	const provisionPersonal = (workspaceId: string, userId: string, model?: string) =>
		Effect.gen(function* () {
			const personal = yield* pods.provisionPersonal(workspaceId, userId);
			const assistant = yield* agents.provisionPersonalAssistant({
				workspaceId,
				podId: personal.id,
				userId,
				model,
			});
			return { personal, assistant };
		});

	const provisionPersonalWithModel = (workspaceId: string, userId: string, model: string) =>
		transaction(
			Effect.gen(function* () {
				if (!(yield* isOffered(workspaceId, model))) {
					return yield* new ModelProviderRepository.ModelNotEnabled({ model });
				}
				const { personal, assistant } = yield* provisionPersonal(workspaceId, userId, model);
				if (!(yield* isOffered(workspaceId, assistant.model))) {
					// Only the model of the assistant just read changes, so none of
					// `update`'s refusals can happen.
					yield* agents.update(workspaceId, assistant.id, { model }).pipe(Effect.orDie);
				}
				return personal;
			}),
		);

	return Service.of({
		list: ({ workspaceId, actor }) => operation("list", visiblePods(workspaceId, actor)),

		create: ({ workspaceId, creator, name, slug, color }) =>
			operation(
				"create",
				Effect.map(
					pods.create(workspaceId, { creatorId: creator.userId, name, slug, color }),
					(row) => podSeenBy(podStanding(row, creator, true)),
				),
			),

		provisionPersonal: ({ workspaceId, userId }) =>
			operation(
				"provisionPersonal",
				transaction(Effect.map(provisionPersonal(workspaceId, userId), ({ personal }) => personal)),
			),

		provisionPersonalWithModel: ({ workspaceId, userId, model }) =>
			operation(
				"provisionPersonalWithModel",
				provisionPersonalWithModel(workspaceId, userId, model),
			),

		ensurePersonal: ({ workspaceId, owner, model }) =>
			operation(
				"ensurePersonal",
				Effect.map(provisionPersonalWithModel(workspaceId, owner.userId, model), (personal) =>
					podSeenBy(podStanding(personal, owner, true)),
				),
			),

		update: ({ standing, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
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

		remove: ({ workspaceId, podId }) => operation("remove", pods.remove(workspaceId, podId)),

		members: (podId) => operation("members", podMembers(podId)),

		addMember: ({ workspaceId, podId, userId }) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					const outcome = yield* pods.addMember(workspaceId, podId, userId);
					if (outcome === "personal_pod") {
						return yield* new PersonalPodMembershipFixed({ attempted: "add" });
					}
					if (outcome === "not_workspace_member") {
						return yield* new NotInWorkspace();
					}
				}),
			),

		removeMember: ({ workspaceId, podId, userId }) =>
			operation(
				"removeMember",
				Effect.gen(function* () {
					const outcome = yield* pods.removeMember(workspaceId, podId, userId);
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
	Layer.provide([PodRepository.layer, AgentRepository.layer, ModelProviderRepository.layer]),
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
