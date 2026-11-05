import { connectionToolKey, connectionToolMutating } from "@sugabots/contracts";
import { asSchema, type Tool } from "ai";
import {
	type AugmentationName,
	augmentationToolsFor,
	type connectionAugmentations,
} from "../../providers/connections/augmentations.ts";
import type { ConnectionTarget } from "../../providers/connections/connection-target.ts";
import { toolAccessOf } from "../../providers/connections/tool-access.ts";
import type { OfferedTool } from "./connections.ts";
import { linearAugmentationTools } from "./linear/tools.ts";
import type { UploadSide } from "./signed-upload/tool.ts";

type AugmentationToolBuilder = (target: ConnectionTarget, side: UploadSide) => Tool;

/** A builder for each augmentation tool, so one described without being built doesn't compile. */
type AugmentationToolBuilders = {
	[A in AugmentationName]: {
		[T in keyof (typeof connectionAugmentations)[A]["tools"]]: AugmentationToolBuilder;
	};
};

const augmentationToolBuilders: AugmentationToolBuilders = { linear: linearAugmentationTools };

/**
 * The augmentation tools of the MCP connection `target`, whose server listed
 * `listed` for the turn, offered under its handle like the server's own, so
 * the pod's choice for each, and its approvals, apply the same way.
 */
export function offerAugmentationTools(
	target: ConnectionTarget,
	listed: readonly { name: string }[],
	side: UploadSide,
): Record<string, OfferedTool> {
	return Object.fromEntries(
		augmentationToolsFor(target, listed).map(({ augmentation, tool: described }) => {
			const builders: Record<string, AugmentationToolBuilder> =
				augmentationToolBuilders[augmentation];
			const tool = builders[described.name]?.(target, side);
			if (!tool) throw new Error(`No builder for ${augmentation}'s ${described.name}`);
			const inputSchema = asSchema(tool.inputSchema).jsonSchema;
			if ("then" in inputSchema) throw new Error(`The ${described.name} tool's schema isn't ready`);
			const offered: OfferedTool = {
				tool,
				handle: target.handle,
				description: typeof tool.description === "string" ? tool.description : "",
				inputSchema,
				mutating: connectionToolMutating(described),
				access: toolAccessOf(target.toolAccess, described),
				connectionId: target.connectionId,
				connectionRevision: target.configurationRevision,
				remoteToolName: described.name,
			};
			return [connectionToolKey(target.handle, described.name), offered];
		}),
	);
}
