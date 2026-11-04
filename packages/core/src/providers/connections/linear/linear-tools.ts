import { type ConnectionTool, connectionPresetFor } from "@sugabots/contracts";

/**
 * The tools Sugabots adds to a Linear connection, beside its server's own:
 * every Linear connection has this version's, so people choose what bots may
 * do with each, as with the server's.
 */
export const LINEAR_ADDED_TOOLS: readonly ConnectionTool[] = [
	{
		name: "upload_file",
		description:
			"Upload a file from the thread or the sandbox to a URL Linear signed, to attach it to an issue or embed it.",
		// Runs without asking, like a read: Linear's prepare step, which asks,
		// is where a file is decided on, and the upload only fills the place it
		// reserved, which shows nowhere until the finishing step. A person asked
		// again would rarely answer within the minute the URL lasts. Sending the
		// same file again changes nothing, so a turn that fails after it can run
		// again.
		readOnly: true,
		destructive: false,
	},
];

/**
 * The tools Sugabots adds to the server at `url`, a Linear connection's, that
 * the server doesn't list itself: a tool of the same name is the server's.
 */
export function addedToolsFor(
	url: string,
	listed: readonly { name: string }[],
): readonly ConnectionTool[] {
	if (connectionPresetFor(url)?.id !== "linear") return [];
	const names = new Set(listed.map((tool) => tool.name));
	return LINEAR_ADDED_TOOLS.filter((tool) => !names.has(tool.name));
}
