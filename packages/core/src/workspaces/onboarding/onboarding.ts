export * as Onboarding from "./onboarding.ts";

import { and, eq, isNull } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import {
	agent,
	pod,
	podMember,
	user,
	workspaceInvite,
	workspaceMember,
} from "../../database/schema.ts";
import { offeredModels } from "../../providers/model-providers/model-provider-reads.ts";
import type { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import type { AuthorizationDenied } from "../access.ts";
import { Authorization } from "../authorization.ts";
import { CurrentActor } from "../current-actor.ts";
import { PersonalPods } from "../pods/personal-pods.ts";

/**
 * The current actor finishing their first run through the product.
 *
 * Both writes are transactional and both lock the row they depend on, because
 * the check and the write have to agree: two tabs finishing onboarding at once
 * must not both decide they were the one that did it.
 */
export interface Interface {
	readonly isCompleted: Effect.Effect<boolean, never, CurrentActor.Service>;
	/**
	 * Marks onboarding done, once `podId` and `agentId` are a pod the actor is
	 * in and its crew agent, and that agent runs on a model the workspace
	 * offers. Finishing settles the first agent and the model the workspace
	 * runs it on, so it takes `workspace.providers.manage`.
	 *
	 * It does not choose a model for the Scribe. A model chosen here is for an
	 * agent somebody talks to, and reusing it for an unattended summariser would
	 * make a choice nobody was shown, which is why a system agent starts unset
	 * and is set up on its own screen.
	 */
	readonly complete: (input: {
		workspaceId: string;
		podId: string;
		agentId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | NotReadyToFinish | NoModelChosen,
		CurrentActor.Service
	>;
	/**
	 * Marks onboarding done for an actor who joined through `invitationId`,
	 * pointing their Personal Assistant at a model the workspace offers, if it
	 * offers any. Returns the workspace they joined.
	 */
	readonly completeAcceptedInvite: (input: {
		invitationId: string;
	}) => Effect.Effect<
		string,
		InvitationNotAccepted | ModelProviderRepository.ModelNotEnabled,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Onboarding") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Onboarding");
	const authorization = yield* Authorization.Service;
	const personalPods = yield* PersonalPods.Service;

	return Service.of({
		isCompleted: operation(
			"isCompleted",
			Effect.flatMap(CurrentActor.Service, ({ userId }) =>
				query((db) =>
					db
						.select({ completedAt: user.onboardingCompletedAt })
						.from(user)
						.where(eq(user.id, userId))
						.limit(1),
				),
			).pipe(Effect.map(([row]) => row?.completedAt != null)),
		),

		complete: ({ workspaceId, podId, agentId }) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						const { workspaceId: resolved, actor } = yield* authorization.workspace(
							workspaceId,
							"workspace.providers.manage",
						);
						const [eligible] = yield* query((db) =>
							db
								.select({ model: agent.model })
								.from(pod)
								.innerJoin(
									podMember,
									and(eq(podMember.podId, pod.id), eq(podMember.userId, actor.userId)),
								)
								.innerJoin(
									agent,
									and(
										eq(agent.id, agentId),
										eq(agent.podId, pod.id),
										eq(agent.workspaceId, pod.workspaceId),
										isNull(agent.systemAgentKey),
									),
								)
								.where(and(eq(pod.id, podId), eq(pod.workspaceId, resolved)))
								.limit(1)
								.for("update"),
						);
						if (!eligible) {
							return yield* new NotReadyToFinish();
						}
						const { models } = yield* offeredModels(resolved);
						if (!models.some((offered) => offered.modelId === eligible.model)) {
							return yield* new NoModelChosen();
						}
						yield* markCompleted(actor.userId);
					}),
				),
			),

		completeAcceptedInvite: ({ invitationId }) =>
			operation(
				"completeAcceptedInvite",
				transaction(
					Effect.gen(function* () {
						const { userId } = yield* CurrentActor.Service;
						const [accepted] = yield* query((db) =>
							db
								.select({ workspaceId: workspaceInvite.workspaceId })
								.from(workspaceInvite)
								.innerJoin(user, and(eq(user.id, userId), eq(user.email, workspaceInvite.email)))
								.innerJoin(
									workspaceMember,
									and(
										eq(workspaceMember.workspaceId, workspaceInvite.workspaceId),
										eq(workspaceMember.userId, userId),
									),
								)
								.where(
									and(eq(workspaceInvite.id, invitationId), eq(workspaceInvite.status, "accepted")),
								)
								.limit(1)
								.for("update"),
						);
						if (!accepted) {
							return yield* new InvitationNotAccepted();
						}
						const workspaceId = accepted.workspaceId;
						const [offered] = (yield* offeredModels(workspaceId)).models;
						if (offered) {
							yield* personalPods.provisionWithModel({
								workspaceId,
								userId,
								model: offered.modelId,
							});
						} else {
							yield* personalPods.provision({ workspaceId, userId });
						}
						yield* markCompleted(userId);
						return workspaceId;
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, PersonalPods.layer]));

/** The pod and agent named are not ones this person may finish onboarding with. */
export class NotReadyToFinish extends Data.TaggedError("NotReadyToFinish") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Finish creating your pod and agent first`;
	}
}

/** The first agent runs on no model, or on one the workspace does not offer. */
export class NoModelChosen extends Data.TaggedError("NoModelChosen") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Choose a model for your first bot first`;
	}
}

/** No invitation this account accepted has that id. */
export class InvitationNotAccepted
	extends Data.TaggedError("InvitationNotAccepted")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The invitation has not been accepted by this account`;
	}
}

const markCompleted = (userId: string) =>
	Effect.flatMap(DateTime.nowAsDate, (now) =>
		query((db) => db.update(user).set({ onboardingCompletedAt: now }).where(eq(user.id, userId))),
	);
