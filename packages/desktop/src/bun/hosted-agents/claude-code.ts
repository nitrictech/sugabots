import { spawn } from "node:child_process";
import {
	type CanUseTool,
	type McpSdkServerConfigWithInstance,
	query,
} from "@anthropic-ai/claude-agent-sdk";
import { confined } from "./sandbox.ts";
import { SUGABOTS_SERVER } from "./sugabots-tools.ts";

/** Whether the person at this computer lets the agent use `toolName` with `input`. */
export type ApproveToolUse = (request: {
	agentName: string;
	toolName: string;
	input: Record<string, unknown>;
}) => Promise<boolean>;

/** What a run says as it goes: its reply's text, and the Claude Code session it continues in. */
export type RunEvent = { type: "text"; text: string } | { type: "session"; id: string };

/**
 * Sends `prompt` to Claude Code, the CLI installed at `executable`, working
 * in `workingDirectory`, continuing `sessionId` when the conversation has one.
 * It runs as the person at this computer, with their own Claude Code login and
 * settings; whatever those settings would ask about is asked through
 * `approve`, except Sugabots' own tools, which the server runs under the
 * pod's rules. The whole program runs confined to its folder, and its shell
 * commands in Claude Code's own sandbox inside that. Throws when the run fails.
 */
export async function* runClaudeCode(options: {
	agentName: string;
	executable: string;
	workingDirectory: string;
	prompt: string;
	sessionId: string | undefined;
	approve: ApproveToolUse;
	/** The turn's Sugabots tools, when it offers any. */
	sugabots: McpSdkServerConfigWithInstance | undefined;
	signal: AbortSignal;
}): AsyncGenerator<RunEvent> {
	const abortController = new AbortController();
	options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
	const canUseTool: CanUseTool = async (toolName, input) =>
		toolName.startsWith(`mcp__${SUGABOTS_SERVER}__`) ||
		(await options.approve({ agentName: options.agentName, toolName, input }))
			? { behavior: "allow", updatedInput: input }
			: { behavior: "deny", message: "The person at this computer didn't allow it." };

	let sessionAnnounced = false;
	let wroteText = false;
	let separateNextText = false;
	for await (const message of query({
		prompt: options.prompt,
		options: {
			cwd: options.workingDirectory,
			resume: options.sessionId,
			pathToClaudeCodeExecutable: options.executable,
			includePartialMessages: true,
			canUseTool,
			abortController,
			// Sandboxed shell commands still ask: being confined is no reason to run unasked.
			sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
			spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
				const [program = command, ...rest] = confined([command, ...args], {
					kind: "claude-code",
					workingDirectory: options.workingDirectory,
				});
				return spawn(program, rest, { cwd, env, signal, stdio: ["pipe", "pipe", "inherit"] });
			},
			...(options.sugabots && { mcpServers: { [SUGABOTS_SERVER]: options.sugabots } }),
		},
	})) {
		if (!sessionAnnounced && message.session_id) {
			sessionAnnounced = true;
			yield { type: "session", id: message.session_id };
		}
		if (message.type === "result") {
			if (message.subtype !== "success") {
				throw new Error(`Claude Code stopped: ${message.subtype}`);
			}
			return;
		}
		// Only the top-level reply: subagents' text is their working, not the answer.
		if (message.type !== "stream_event" || message.parent_tool_use_id !== null) continue;
		const { event } = message;
		if (event.type === "content_block_start" && event.content_block.type === "text") {
			separateNextText = wroteText;
		}
		if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
			const text = separateNextText ? `\n\n${event.delta.text}` : event.delta.text;
			separateNextText = false;
			wroteText = true;
			yield { type: "text", text };
		}
	}
}
