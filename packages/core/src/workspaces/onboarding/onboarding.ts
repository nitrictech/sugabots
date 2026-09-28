export * as Onboarding from "./onboarding.ts";

import { and, eq, inArray, isNull } from "drizzle-orm";
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
import { rolesWith } from "../permissions.ts";
import { PersonalPods } from "../pods/personal-pods.ts";

/**
 * Finishing someone's first run through the product.
 *
 * Both writes are transactional and both lock the row they depend on, because
 * the check and the write have to agree: two tabs finishing onboarding at once
 * must not both decide they were the one that did it.
 */
export interface Interface {
	readonly isCompleted: (userId: string) => Effect.Effect<boolean>;
	/**
	 * Marks onboarding done, once `podId` and `agentId` are a pod and crew agent
	 * `userId` may finish with. Connecting a model can be skipped, so the agent
	 * need not run on one yet: its chat says it has no model and where to
	 * choose one.
	 *
	 * It does not choose a model for the Scribe. A model chosen here is for an
	 * agent somebody talks to, and reusing it for an unattended summariser would
	 * make a choice nobody was shown, which is why a system agent starts unset
	 * and is set up on its own screen.
	 */
	readonly complete: (input: {
		userId: string;
		workspaceId: string;
		podId: string;
		agentId: string;
	}) => Effect.Effect<void, NotReadyToFinish>;
	/**
	 * Marks onboarding done for somebody who joined through `invitationId`,
	 * pointing their Personal Assistant at a model the workspace offers, if it
	 * offers any. Returns the workspace they joined.
	 */
	readonly completeAcceptedInvite: (input: {
		userId: string;
		invitationId: string;
	}) => Effect.Effect<string, InvitationNotAccepted | ModelProviderRepository.ModelNotEnabled>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Onboarding") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Onboarding");
	const personalPods = yield* PersonalPods.Service;

	return Service.of({
		isCompleted: (userId) =>
			operation(
				"isCompleted",
				query((db) =>
					db
						.select({ completedAt: user.onboardingCompletedAt })
						.from(user)
						.where(eq(user.id, userId))
						.limit(1),
				).pipe(Effect.map(([row]) => row?.completedAt != null)),
			),

		complete: ({ userId, workspaceId, podId, agentId }) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						const [eligible] = yield* query((db) =>
							db
								.select({ agentId: agent.id })
								.from(workspaceMember)
								.innerJoin(
									pod,
									and(eq(pod.id, podId), eq(pod.workspaceId, workspaceMember.workspaceId)),
								)
								.innerJoin(
									podMember,
									and(eq(podMember.podId, pod.id), eq(podMember.userId, workspaceMember.userId)),
								)
								.innerJoin(
									agent,
									and(
										eq(agent.id, agentId),
										eq(agent.podId, pod.id),
										eq(agent.workspaceId, workspaceMember.workspaceId),
										isNull(agent.systemAgentKey),
									),
								)
								.where(
									and(
										eq(workspaceMember.workspaceId, workspaceId),
										eq(workspaceMember.userId, userId),
										inArray(workspaceMember.role, ROLES_THAT_MAY_FINISH_ONBOARDING),
									),
								)
								.limit(1)
								.for("update"),
						);
						if (!eligible) {
							return yield* new NotReadyToFinish();
						}
						yield* markCompleted(userId);
					}),
				),
			),

		completeAcceptedInvite: ({ userId, invitationId }) =>
			operation(
				"completeAcceptedInvite",
				transaction(
					Effect.gen(function* () {
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

export const layer = layerNoDeps.pipe(Layer.provide(PersonalPods.layer));

/** The pod and agent named are not ones this person may finish onboarding with. */
export class NotReadyToFinish extends Data.TaggedError("NotReadyToFinish") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Finish creating your pod and agent first`;
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

/**
 * Finishing onboarding settles the first agent and the model the workspace runs
 * it on, so it asks for the permission that governs the models a workspace runs
 * on rather than for a role. Today that is an administrator either way; naming
 * the action is what keeps it true when the grants move.
 */
const ROLES_THAT_MAY_FINISH_ONBOARDING = rolesWith("workspace.providers.manage");

const markCompleted = (userId: string) =>
	Effect.flatMap(DateTime.nowAsDate, (now) =>
		query((db) => db.update(user).set({ onboardingCompletedAt: now }).where(eq(user.id, userId))),
	);
