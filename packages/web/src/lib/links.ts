import type { Agent, Connection, Pod } from "@sugabots/contracts";
import { linkOptions } from "@tanstack/react-router";

/*
 * Where a pod or an agent lives in the workspace being looked at.
 *
 * Built from the records rather than from loose params, so no caller assembles
 * an address by hand and the address can change here alone. Each result spreads
 * into a `Link` or goes to `navigate` from a page under `/$workspace`.
 *
 * Only pod, agent and connection addresses, whose slugs, handles and ids are
 * easy to swap for one another. Pages outside a workspace (onboarding, the OAuth return) name one
 * themselves, and links by fixed key or thread id are written in place.
 */

interface AgentInPod {
	pod: Pick<Pod, "slug">;
	agent: Pick<Agent, "handle">;
}

/** What is new across the workspace. */
export function activityLink() {
	return linkOptions({ from: "/$workspace", to: "./activity" });
}

/** A pod's conversation list. */
export function podLink(pod: Pod) {
	return linkOptions({ from: "/$workspace", to: "./pods/$pod", params: { pod: pod.slug } });
}

/** A pod's artifacts. */
export function artifactsLink(pod: Pod) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/artifacts",
		params: { pod: pod.slug },
	});
}

export function artifactLink(pod: Pod, artifactId: string, search: { version?: number } = {}) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/artifacts/$artifact",
		params: { pod: pod.slug, artifact: artifactId },
		search,
	});
}

export function podSettingsLink(pod: Pod) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/pods/$pod",
		params: { pod: pod.slug },
	});
}

/** A connection's own page, under its pod's settings. */
export function connectionSettingsLink(pod: Pod, connection: Pick<Connection, "id">) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/pods/$pod/connections/$connection",
		params: { pod: pod.slug, connection: connection.id },
	});
}

export function agentChatLink({ pod, agent }: AgentInPod, search: { thread?: string } = {}) {
	return linkOptions({
		from: "/$workspace",
		to: "./pods/$pod/agents/$agent",
		params: { pod: pod.slug, agent: agent.handle },
		search,
	});
}

export function agentSettingsLink({ pod, agent }: AgentInPod) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/pods/$pod/agents/$agent",
		params: { pod: pod.slug, agent: agent.handle },
	});
}

/** A person's page among the workspace's members, by their membership's id. */
export function memberSettingsLink(membership: { id: string }) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/members/$member",
		params: { member: membership.id },
	});
}
