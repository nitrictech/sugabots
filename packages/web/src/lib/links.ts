import type { Agent, Pod } from "@sugabots/contracts";
import { linkOptions } from "@tanstack/react-router";

/*
 * Where a pod or an agent lives in the app.
 *
 * Built from the records rather than from loose ids, so no caller assembles an
 * address by hand and the address can change here alone. Each result spreads
 * into a `Link` or goes to `navigate`.
 */

interface AgentInPod {
	pod: Pod;
	agent: Agent;
}

export function podSettingsLink(pod: Pod) {
	return linkOptions({ to: "/settings/pods/$pod", params: { pod: pod.id } });
}

export function agentChatLink(
	{ pod, agent }: AgentInPod,
	search: { thread?: string; history?: "open" } = {},
) {
	return linkOptions({
		to: "/agents/$agent",
		params: { agent: agent.id },
		search: { pod: pod.id, ...search },
	});
}

export function agentSettingsLink({ pod, agent }: AgentInPod) {
	return linkOptions({
		to: "/settings/pods/$pod/agents/$agent",
		params: { pod: pod.id, agent: agent.id },
	});
}
