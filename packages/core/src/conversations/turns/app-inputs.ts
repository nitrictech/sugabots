import { CONNECTION_TOOL_SEPARATOR, streamEvent, threadChannel } from "@sugabots/contracts";
import type { EventBus } from "../../database/events/bus.ts";
import type { ToolInputPiece } from "../../providers/models/models.ts";
import type { OfferedTool } from "../tools/connections.ts";
import { CALL_TOOL } from "../tools/tool-search/tool.ts";

/** A `call_tool` call being written, and what of it has been published. */
interface StreamingCall {
	text: string;
	publishedLength: number;
	lastPublishedAt: number;
	/** Set once the input names a tool that has an MCP App. */
	app?: {
		rowId: string;
		tool: string;
		connectionId: string;
		resourceUri: string;
	};
}

/**
 * Publishes the input the model writes for calls to MCP Apps' tools as it
 * arrives, so a viewer's app can draw it before the call runs. Each such call
 * is given its row's id as soon as its input names the tool, and `rowIdFor`
 * hands that id to the call's recording, so the app opened for the input is
 * the one its result goes to.
 */
export function appInputStreams(options: {
	from: { threadId: string; messageId: string };
	connections: Readonly<Record<string, OfferedTool>>;
	events: Pick<EventBus.Interface, "publish">;
	newRowId: () => string;
	publishIntervalMs: number;
	onPublishFailed: (cause: unknown) => void;
}) {
	const { from, connections, events } = options;
	const calls = new Map<string, StreamingCall>();
	const rowIds = new Map<string, string>();

	const appFor = (text: string): StreamingCall["app"] => {
		// The name is complete once its closing quote has arrived.
		const named = /"tool"\s*:\s*"([^"\\]+)"/.exec(text)?.[1];
		if (!named) return undefined;
		const keys = Object.keys(connections);
		const key = keys.includes(named)
			? named
			: keys
					.filter((candidate) => candidate.endsWith(`${CONNECTION_TOOL_SEPARATOR}${named}`))
					.at(0);
		const offered = key ? connections[key] : undefined;
		if (!key || !offered?.appResourceUri) return undefined;
		return {
			rowId: options.newRowId(),
			tool: key,
			connectionId: offered.connectionId,
			resourceUri: offered.appResourceUri,
		};
	};

	const publish = (call: StreamingCall) => {
		const { app } = call;
		const text = call.text.slice(call.publishedLength);
		if (!app || !text) return;
		const offset = call.publishedLength;
		call.publishedLength = call.text.length;
		call.lastPublishedAt = Date.now();
		events
			.publish(
				threadChannel(from.threadId),
				streamEvent("tool_call.input_delta", {
					...from,
					toolCallId: app.rowId,
					tool: app.tool,
					app: { connectionId: app.connectionId, resourceUri: app.resourceUri },
					offset,
					text,
				}),
			)
			.catch(options.onPublishFailed);
	};

	const onToolInput = (piece: ToolInputPiece) => {
		if (piece.kind === "end") {
			const call = calls.get(piece.sdkToolCallId);
			if (call) publish(call);
			calls.delete(piece.sdkToolCallId);
			return;
		}
		if (piece.toolName !== CALL_TOOL) return;
		let call = calls.get(piece.sdkToolCallId);
		if (!call) {
			call = { text: "", publishedLength: 0, lastPublishedAt: 0 };
			calls.set(piece.sdkToolCallId, call);
		}
		call.text += piece.text;
		if (!call.app) {
			call.app = appFor(call.text);
			if (!call.app) return;
			rowIds.set(piece.sdkToolCallId, call.app.rowId);
		}
		if (Date.now() - call.lastPublishedAt >= options.publishIntervalMs) publish(call);
	};

	return { onToolInput, rowIdFor: (sdkToolCallId: string) => rowIds.get(sdkToolCallId) };
}
