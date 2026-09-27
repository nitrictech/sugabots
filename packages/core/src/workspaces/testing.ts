import { DEFAULT_POD_ROUTING, type WorkspaceRole } from "@sugabots/contracts";
import { Effect } from "effect";
import type * as schema from "../database/schema.ts";
import {
	ActionForbidden,
	type AgentStanding,
	type Authorization,
	type AuthorizationDenied,
	decideInPod,
	type PodStanding,
	podStanding,
	ResourceHidden,
} from "./access.ts";
import { type Actor, mayInWorkspace, type PodPermission } from "./permissions.ts";

/**
 * `Authorization` over a workspace a test describes, decided by the real
 * policy.
 *
 * The route tests run without Postgres, so something has to stand in for the
 * queries that load roles, pods and memberships. Standing in for the
 * *decisions* as well would mean every route test asserting against a second,
 * hand-written copy of the rules — which is how a route ends up enforcing
 * something the policy does not say. So this fakes the facts and hands them to
 * `podStanding` and `decideInPod` — the same two functions `authorization`
 * reaches its answers through, refusal order included.
 */

export interface TestPod {
	id: string;
	kind?: "personal" | "shared";
	/** Whose Personal pod it is. Shared pods have no owner. */
	ownerId?: string | null;
	/** The people with a `pod_member` row in it. */
	members?: string[];
	name?: string;
	slug?: string;
	routing?: schema.PodRow["routing"];
}

export interface TestAgent {
	id: string;
	podId: string;
	name?: string;
	handle?: string;
	systemAgentKey?: schema.AgentRow["systemAgentKey"];
	model?: string | null;
}

export interface TestWorkspace {
	id: string;
	/** Each person's role. Anybody left out is not in this workspace at all. */
	roles: Record<string, WorkspaceRole>;
	pods?: TestPod[];
	agents?: TestAgent[];
}

export function testAuthorization(world: TestWorkspace): Authorization {
	const pods = new Map((world.pods ?? []).map((pod) => [pod.id, pod]));
	const agents = new Map((world.agents ?? []).map((agent) => [agent.id, agent]));

	const actorIn = (userId: string): Actor => ({
		userId,
		workspaceRole: world.roles[userId],
	});

	const standing = (
		pod: TestPod,
		userId: string,
		permission: PodPermission,
		resource: "pod" | "agent",
	): Effect.Effect<PodStanding, AuthorizationDenied> =>
		decideInPod(
			podStanding(podRow(world.id, pod), actorIn(userId), (pod.members ?? []).includes(userId)),
			permission,
			resource,
		);

	return {
		workspace: (userId, workspaceId, permission) => {
			const actor = actorIn(userId);
			if (workspaceId !== world.id || !actor.workspaceRole) {
				return Effect.fail(new ResourceHidden({ resource: "workspace" }));
			}
			if (!mayInWorkspace(actor, permission)) {
				return Effect.fail(new ActionForbidden({ permission }));
			}
			return Effect.succeed({ workspaceId, actor });
		},

		pod: (userId, podId, permission) => {
			const pod = pods.get(podId);
			if (!pod) return Effect.fail(new ResourceHidden({ resource: "pod" }));
			return standing(pod, userId, permission, "pod");
		},

		agent: (userId, agentId, permission) => {
			const agent = agents.get(agentId);
			const pod = agent && pods.get(agent.podId);
			if (!agent || !pod) return Effect.fail(new ResourceHidden({ resource: "agent" }));
			return Effect.map(
				standing(pod, userId, permission, "agent"),
				(found): AgentStanding => ({ ...found, agent: agentRow(world.id, agent) }),
			);
		},
	};
}

const CREATED_AT = new Date("2026-09-09T00:00:00.000Z");

function podRow(workspaceId: string, pod: TestPod): schema.PodRow {
	return {
		id: pod.id,
		workspaceId,
		ownerId: pod.ownerId ?? null,
		kind: pod.kind ?? "shared",
		name: pod.name ?? "Suga-Team",
		slug: pod.slug ?? "suga-team",
		color: (pod.kind ?? "shared") === "shared" ? "green" : null,
		routing: pod.routing ?? DEFAULT_POD_ROUTING,
		createdById: null,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
	};
}

function agentRow(workspaceId: string, agent: TestAgent): schema.AgentRow {
	return {
		id: agent.id,
		workspaceId,
		podId: agent.podId,
		name: agent.name ?? "Scout",
		handle: agent.handle ?? "scout",
		systemAgentKey: agent.systemAgentKey ?? null,
		provisionedKey: null,
		description: null,
		color: "teal",
		face: "pill",
		model: agent.model ?? "test-model",
		prompt: "",
		disabledTools: [],
		createdById: null,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
	};
}
