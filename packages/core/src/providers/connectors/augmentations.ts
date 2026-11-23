import type { ConnectorAccess, ConnectorTool } from "@sugabots/contracts";
import { linearAugmentation } from "./linear/linear-augmentation.ts";

/**
 * An augmentation: tools Sugabots adds to an MCP server's own, for a server
 * whose tools leave something undone, such as Linear's, which reserve a place
 * for a file but can't send it. Its augmentation tools are listed, chosen for
 * and approved like the server's, under the connector's handle. They are
 * built in `chats/tools/augmentations.ts`, under the same names.
 */
export interface ConnectorAugmentation {
	readonly appliesTo: (connector: { url: string }) => boolean;
	/** Its augmentation tools, by name. */
	readonly tools: Readonly<Record<string, Omit<AugmentationTool, "name">>>;
}

/**
 * An augmentation tool, described as a server describes its own, with the
 * access it has until somebody chooses, in place of the default its
 * description would give it.
 */
export interface AugmentationTool extends ConnectorTool {
	readonly defaultAccess: ConnectorAccess;
}

export const connectorAugmentations = { linear: linearAugmentation } satisfies Record<
	string,
	ConnectorAugmentation
>;

export type AugmentationName = keyof typeof connectorAugmentations;

/**
 * The augmentation tools `connector` gets, whose server listed `listed`. A
 * tool the server lists itself is the server's, so an augmentation tool of the
 * same name is left out.
 */
export function augmentationToolsFor(
	connector: { url: string },
	listed: readonly { name: string }[],
): readonly { augmentation: AugmentationName; tool: AugmentationTool }[] {
	const names = new Set(listed.map((tool) => tool.name));
	return (Object.keys(connectorAugmentations) as AugmentationName[]).flatMap((augmentation) => {
		const { appliesTo, tools } = connectorAugmentations[augmentation];
		if (!appliesTo(connector)) return [];
		return Object.entries(tools)
			.filter(([name]) => !names.has(name))
			.map(([name, described]) => ({ augmentation, tool: { name, ...described } }));
	});
}

/** `connector`'s tools: those its server listed, then its augmentation tools. */
export function augmentConnectorTools<Tool extends { name: string }>(
	connector: { url: string },
	listed: readonly Tool[],
): readonly (Tool | AugmentationTool)[] {
	return [...listed, ...augmentationToolsFor(connector, listed).map(({ tool }) => tool)];
}
