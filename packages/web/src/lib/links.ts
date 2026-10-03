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
	pod: Pod;
	agent: Agent;
}

/** A pod's conversation list. */
export function podLink(pod: Pod) {
	return linkOptions({ from: "/$workspace", to: "./pods/$pod", params: { pod: pod.slug } });
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
