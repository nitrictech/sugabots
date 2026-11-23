import {
	type ConnectorAccess,
	type ConnectorTool,
	connectorToolWritesOrDeletes,
} from "@sugabots/contracts";
import type { ToolAccess } from "../../database/schema.ts";

/**
 * What the bot may do with `tool`: what somebody chose for it, or
 * otherwise its own default access, if it has one, or the default as the
 * server describes it now. A tool the server marks destructive is off, one
 * that may change something asks first, and one that only reads runs.
 */
export function toolAccessOf(
	chosen: ToolAccess,
	tool: Pick<ConnectorTool, "name" | "readOnly" | "destructive"> & {
		defaultAccess?: ConnectorAccess;
	},
): ConnectorAccess {
	const choice = chosen[tool.name];
	if (choice) return choice;
	if (tool.defaultAccess) return tool.defaultAccess;
	if (tool.destructive === true) return "off";
	return connectorToolWritesOrDeletes(tool) ? "ask" : "allow";
}
