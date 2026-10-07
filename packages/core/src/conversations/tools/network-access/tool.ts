import { sandboxHostSchema } from "@sugabots/contracts";
import { tool } from "ai";
import { Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import { blockOn } from "../../../sandboxes/allowed-hosts.ts";
import { HostBlocked, type SandboxNetwork } from "../../../sandboxes/sandbox-network.ts";
import type { Request } from "../sandbox.ts";

export const REQUEST_NETWORK_ACCESS_TOOL = "request_network_access";

/**
 * The `request_network_access` tool: an agent asking for its pod's sandbox to
 * reach another host. Every call waits for someone who decides what the pod's
 * sandbox may reach to allow it (see `tools/approval-deciders.ts`), so the
 * tool only runs once they have, and then adds the host to the pod. A host
 * the workspace blocked, `blocked`, is refused without asking.
 */
export function requestNetworkAccess({
	turnId,
	network,
	blocked,
	run,
}: {
	turnId: string;
	network: Pick<SandboxNetwork.Interface, "grantRequest">;
	blocked: readonly string[];
	run: RunEffect<never>;
}): Request {
	return {
		tool: tool({
			description:
				"Ask for the sandbox to be allowed to connect to a host it can't reach. An admin of this pod decides, and your reply waits until they have; once allowed, the pod's sandbox reaches the host. Ask only for a host the task needs, by its name, and use a wildcard such as *.example.com only when the task needs many of a domain's subdomains. A host the workspace has blocked is refused at once.",
			inputSchema: Schema.Struct({
				host: sandboxHostSchema.annotate({
					description:
						"The host's name in lowercase, such as api.example.com; *.example.com covers its subdomains but not example.com itself",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ host }, { toolCallId }) => {
				const grant = await run(network.grantRequest({ turnId, sdkToolCallId: toolCallId, host }));
				switch (grant.kind) {
					case "added":
						return { status: "allowed", host, note: "The pod's sandbox can connect to it now." };
					case "blocked":
						return { status: "failed", error: blockedMessage(host, grant.by) };
					case "not-allowed":
						return { status: "failed", error: "The request wasn't allowed." };
				}
			},
		}),
		refusal: (input) => {
			const host = hostOf(input);
			const by = host === undefined ? undefined : blockOn(host, blocked);
			return host === undefined || by === undefined ? undefined : blockedMessage(host, by);
		},
	};
}

function blockedMessage(host: string, by: string) {
	return new HostBlocked({ host, by }).userMessage;
}

/** The host a call asks for; the SDK has checked its input against the schema by now. */
function hostOf(input: unknown): string | undefined {
	return typeof input === "object" && input !== null && "host" in input
		? String(input.host)
		: undefined;
}
