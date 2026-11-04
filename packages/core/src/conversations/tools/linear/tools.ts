import { connectionToolKey } from "@sugabots/contracts";
import { asSchema, type Tool } from "ai";
import type { ConnectionTarget } from "../../../providers/connections/connection-target.ts";
import { addedToolsFor } from "../../../providers/connections/linear/linear-tools.ts";
import { toolAccessOf } from "../../../providers/connections/tool-access.ts";
import type { OfferedTool } from "../connections.ts";
import { type SignedUpload, signedUploadTool, type UploadSide } from "../signed-upload/tool.ts";

/** Where Linear's `prepare_attachment_upload` and `prepare_file_upload` sign uploads to. */
const LINEAR_UPLOAD_DESTINATION = "https://storage.googleapis.com/uploads.linear.app/";

/**
 * The tools Sugabots adds to a Linear connection, offered beside its server's
 * own under its handle, so the pod's choice for each, and its approvals,
 * apply the same way; none for any other server, or that the server lists
 * itself. `listed` is the server's tools as it listed them for the turn.
 */
export function linearTools(
	target: ConnectionTarget,
	listed: readonly { name: string }[],
	side: UploadSide,
): Record<string, OfferedTool> {
	const tools: Record<string, Tool> = {
		upload_file: signedUploadTool(linearUploads(target.handle), side),
	};
	const offered: Record<string, OfferedTool> = {};
	for (const described of addedToolsFor(target.url, listed)) {
		const found = tools[described.name];
		if (!found) continue;
		const inputSchema = asSchema(found.inputSchema).jsonSchema;
		if ("then" in inputSchema) throw new Error(`The ${described.name} tool's schema isn't ready`);
		offered[connectionToolKey(target.handle, described.name)] = {
			tool: found,
			handle: target.handle,
			description: typeof found.description === "string" ? found.description : "",
			inputSchema,
			mutating: described.readOnly !== true,
			access: toolAccessOf(target.toolAccess, described),
			connectionId: target.connectionId,
			connectionRevision: target.configurationRevision,
			remoteToolName: described.name,
		};
	}
	return offered;
}

/** Linear's signed uploads, told by the keys of the connection `handle`'s own tools. */
function linearUploads(handle: string): SignedUpload {
	const key = (name: string) => connectionToolKey(handle, name);
	return {
		destination: LINEAR_UPLOAD_DESTINATION,
		howTo: `Get the URL and headers from ${key("prepare_attachment_upload")}, to attach the file to an issue, or ${key("prepare_file_upload")}, to embed it in a comment or description, and upload straight after: the URL lasts a minute. Then finish with ${key("create_attachment_from_upload")}, or by putting the markdown it gave you where it goes.`,
	};
}
