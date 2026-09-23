import { workspaceRoleOf } from "@sugabots/contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { type Database, query, transaction } from "../../database/database.ts";
import {
	agent,
	modelProvider,
	pod,
	podMember,
	providerModel,
	user,
	workspaceInvite,
	workspaceMember,
} from "../../database/schema.ts";
import { rolesWith } from "../permissions.ts";
import { podStore } from "../pods/store.ts";

/**
 * Finishing someone's first run through the product.
 *
 * Both writes are transactional and both lock the row they depend on, because
 * the check and the write have to agree: two tabs finishing onboarding at once
 * must not both decide they were the one that did it.
 *
 * Nothing here declares a failure. A rejection is a database fault, which is a
 * defect, and the routes turn "not eligible" into a bad request from the
 * `false`/`undefined` rather than from an error.
 */
export interface OnboardingStore {
	isCompleted(userId: string): Effect.Effect<boolean, never, Database>;
	/** `false` when this person may not finish onboarding with these ids. */
	complete(
		userId: string,
		workspaceId: string,
		podId: string,
		agentId: string,
	): Effect.Effect<boolean, never, Database>;
	/** The workspace joined, or `undefined` if no accepted invite matches. */
	completeAcceptedInvite(
		userId: string,
		invitationId: string,
	): Effect.Effect<string | undefined, never, Database>;
}

/**
 * Finishing onboarding settles the first agent and the model the workspace runs
 * it on, so it asks for the permission that governs the models a workspace runs
 * on rather than for a role. Today that is an administrator either way; naming
 * the action is what keeps it true when the grants move.
 */
const ROLES_THAT_MAY_FINISH_ONBOARDING = rolesWith("workspace.providers.manage");

/**
 * Marks onboarding done, once the named pod and agent are ones this person may
 * finish with and the agent runs on a model the workspace has enabled.
 *
 * It does not choose a model for the Scribe. A model chosen here is for an
 * agent somebody talks to, and reusing it for an unattended summariser would
 * make a choice nobody was shown — which is the whole reason a system agent
 * starts unset and is set up on its own screen.
 */
const complete: OnboardingStore["complete"] = (userId, workspaceId, podId, agentId) =>
	transaction(
		Effect.gen(function* () {
			const eligible = yield* query(async (db) => {
				const [row] = await db
					.select({ agentId: agent.id })
					.from(workspaceMember)
					.innerJoin(pod, and(eq(pod.id, podId), eq(pod.workspaceId, workspaceMember.workspaceId)))
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
					.innerJoin(
						providerModel,
						and(
							eq(providerModel.workspaceId, workspaceMember.workspaceId),
							eq(providerModel.modelId, agent.model),
							eq(providerModel.enabled, true),
						),
					)
					.innerJoin(
						modelProvider,
						and(
							eq(modelProvider.id, providerModel.providerId),
							eq(modelProvider.workspaceId, workspaceMember.workspaceId),
							eq(modelProvider.active, true),
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
					.for("update");
				return row;
			});

			if (!eligible) {
				return false;
			}

			yield* markCompleted(userId);
			return true;
		}),
	);

const completeAcceptedInvite: OnboardingStore["completeAcceptedInvite"] = (userId, invitationId) =>
	transaction(
		Effect.gen(function* () {
			const accepted = yield* query(async (db) => {
				const [row] = await db
					.select({ workspaceId: workspaceInvite.workspaceId, role: workspaceMember.role })
					.from(workspaceInvite)
					.innerJoin(user, and(eq(user.id, userId), eq(user.email, workspaceInvite.email)))
					.innerJoin(
						workspaceMember,
						and(
							eq(workspaceMember.workspaceId, workspaceInvite.workspaceId),
							eq(workspaceMember.userId, userId),
						),
					)
					.where(and(eq(workspaceInvite.id, invitationId), eq(workspaceInvite.status, "accepted")))
					.limit(1)
					.for("update");
				return row;
			});

			if (!accepted) {
				return undefined;
			}
			const [configured] = yield* query((db) =>
				db
					.select({ model: providerModel.modelId })
					.from(providerModel)
					.where(
						and(
							eq(providerModel.workspaceId, accepted.workspaceId),
							eq(providerModel.enabled, true),
						),
					)
					.limit(1),
			);
			if (!configured) {
				throw new Error("The invited workspace has no enabled model");
			}
			yield* podStore.ensurePersonal(
				accepted.workspaceId,
				{ userId, workspaceRole: workspaceRoleOf(accepted.role) },
				configured.model,
			);
			yield* markCompleted(userId);
			return accepted.workspaceId;
		}),
	);

const markCompleted = (userId: string) =>
	query((db) =>
		db.update(user).set({ onboardingCompletedAt: new Date() }).where(eq(user.id, userId)),
	);

export const onboardingStore: OnboardingStore = {
	isCompleted: (userId) =>
		query(async (db) => {
			const [row] = await db
				.select({ completedAt: user.onboardingCompletedAt })
				.from(user)
				.where(eq(user.id, userId))
				.limit(1);
			return row?.completedAt != null;
		}),
	complete,
	completeAcceptedInvite,
};
