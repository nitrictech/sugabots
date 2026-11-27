import type { Tool } from "ai";
import {
	type AugmentationName,
	augmentationToolsFor,
	type connectorAugmentations,
} from "../../providers/connectors/augmentations.ts";
import type { ConnectorTarget } from "../../providers/connectors/connector-target.ts";
import { type OfferedTool, offeredTool } from "./connector-catalog.ts";
import { linearAugmentationTools } from "./linear/tools.ts";
import type { UploadSide } from "./signed-upload/tool.ts";

type AugmentationToolBuilder = (target: ConnectorTarget, side: UploadSide) => Tool;

/** A builder for each augmentation tool, so one described without being built doesn't compile. */
type AugmentationToolBuilders = {
	[A in AugmentationName]: {
		[T in keyof (typeof connectorAugmentations)[A]["tools"]]: AugmentationToolBuilder;
	};
};

const augmentationToolBuilders: AugmentationToolBuilders = { linear: linearAugmentationTools };

/**
 * The augmentation tools of the MCP connector `target`, whose server listed
 * `listed` for the turn, offered under its handle like the server's own, so
 * the bot's choice for each, and its approvals, apply the same way.
 */
export function offerAugmentationTools(
	target: ConnectorTarget,
	listed: readonly { name: string }[],
	side: UploadSide,
): Record<string, OfferedTool> {
	return Object.fromEntries(
		augmentationToolsFor(target, listed).map(({ augmentation, tool: described }) => {
			const builders: Record<string, AugmentationToolBuilder> =
				augmentationToolBuilders[augmentation];
			const tool = builders[described.name]?.(target, side);
			if (!tool) throw new Error(`No builder for ${augmentation}'s ${described.name}`);
			const offered = offeredTool(target, described, tool);
			if (side.computer && augmentation === "linear" && described.name === "upload_file") {
				offered[1].usesComputer = (input) =>
					typeof input.path === "string" && input.file === undefined;
			}
			return offered;
		}),
	);
}
