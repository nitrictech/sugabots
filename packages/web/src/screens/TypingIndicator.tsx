import type { ThreadParticipant, ToolCallPart } from "@sugabots/contracts";
import type { ConnectionLook } from "@/lib/connections.ts";
import { useElapsedSince } from "@/lib/elapsed.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import {
	BUILT_IN_HANDLE,
	connectionLabel,
	formatTotal,
	splitToolKey,
	stepLabel,
	type ToolActivity,
} from "./tool-activity.ts";

/*
 * What the thread says while an agent's turn is running: one quiet line, no
 * container, in place of the reply. The reply itself is only drawn once it is
 * finished — what an agent writes on the way can turn out to be the lead-in to
 * a tool call, which cannot be told until the call arrives — so this line is
 * the whole of the turn until then.
 *
 * It says the agent is typing, or, while one of its tools is running, which
 * step it is on and for how long. The service is shown as its mark rather than
 * its name: at this size the logo is read faster than the word. The product's
 * own tools are no one's service, so they carry no mark.
 */

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

export function TypingIndicator({
	agent,
	activity,
	waitingOn,
	looks,
	outgoing = false,
}: {
	agent: Pick<AgentParticipant, "name" | "hue" | "face">;
	/** The turn's tool calls so far; absent before the reply has started. */
	activity?: ToolActivity;
	/** The collaborator the agent has asked and is waiting to hear from. */
	waitingOn?: string;
	/** Connection handles to the mark their steps are shown under. */
	looks?: ReadonlyMap<string, ConnectionLook>;
	/** Sits under the agent, so it follows the side the agent's bubbles are on. */
	outgoing?: boolean;
}) {
	const step = activity?.latest?.status === "running" ? activity.latest : undefined;
	const elapsedMs = useElapsedSince(step?.startedAt);
	return (
		<div
			role="status"
			aria-label={`${agent.name}, ${step ? "working" : waitingOn ? "waiting" : "typing"}`}
			className={`agent-tint flex items-center gap-2 text-muted-foreground text-xs ${
				outgoing ? "flex-row-reverse pr-3.5 pl-8" : "pr-8 pl-3.5"
			}`}
			style={{ ["--agent-hue" as string]: agent.hue }}
		>
			<AgentAvatar hue={agent.hue} face={agent.face} size={20} />
			<span className="flex min-w-0 items-center gap-1.5">
				<span className="shrink-0 font-semibold text-agent-name">{agent.name}</span>
				{step ? (
					<StepLabel call={step} looks={looks} />
				) : (
					<span className="min-w-0 truncate">
						{waitingOn ? `is waiting on ${waitingOn}` : "is typing"}
					</span>
				)}
			</span>
			<span className="chat-working-dots" aria-hidden>
				<i />
				<i />
				<i />
			</span>
			{step && <span className="shrink-0 font-mono">{formatTotal(elapsedMs)}</span>}
		</div>
	);
}

function StepLabel({
	call,
	looks,
}: {
	call: ToolCallPart;
	looks?: ReadonlyMap<string, ConnectionLook>;
}) {
	const { handle } = splitToolKey(call.tool);
	const look = looks?.get(handle);
	const connection = connectionLabel(handle, look?.name);
	const onAConnection = handle !== BUILT_IN_HANDLE;
	return (
		<>
			<span className="shrink-0">is using</span>
			{onAConnection && (
				<ConnectionMark
					presetId={look?.presetId}
					name={connection}
					hue={look?.hue ?? 250}
					size="xs"
				/>
			)}
			<span className="min-w-0 truncate">
				{/* The mark is decorative, so the service is still said out loud here. */}
				{onAConnection && <span className="sr-only">{connection}: </span>}
				{stepLabel(call.tool)}
			</span>
		</>
	);
}
