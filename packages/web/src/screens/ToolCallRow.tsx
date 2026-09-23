import type { ToolCallPart } from "@sugabots/contracts";
import { Check, ChevronDown, ChevronUp, ShieldQuestion, Wrench, X } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useReviewToolCall } from "@/lib/threads.ts";
import { Button } from "@/ui/button.tsx";

/*
 * One tool call, where the reply made it. A single line by default: which
 * tool, what it stands at, how long it took. Opened, it shows what the tool
 * was given and what it returned, as the JSON that was stored, in monospace.
 * It sits on the agent's side of the conversation like the agent's bubbles.
 */

export function ToolCallRow({
	call,
	threadId = "",
	podId = "",
	canApprove = false,
	canAlwaysAllow = false,
}: {
	call: ToolCallPart;
	threadId?: string;
	podId?: string;
	canApprove?: boolean;
	canAlwaysAllow?: boolean;
}) {
	const awaitingApproval =
		call.status === "awaiting_approval" && call.approval?.status === "pending";
	const denied = call.approval?.status === "denied";
	const approvedWaiting =
		call.status === "awaiting_approval" && call.approval?.status === "allowed";
	const [expanded, setExpanded] = useState(awaitingApproval);
	const Chevron = expanded ? ChevronUp : ChevronDown;
	const label = denied
		? `Denied ${call.tool}`
		: awaitingApproval
			? `Approval needed for ${call.tool}`
			: approvedWaiting
				? `Approved ${call.tool}`
				: `Used ${call.tool}`;
	return (
		<section
			aria-label={`${label}, ${standing(call)}`}
			className="agent-tint flex animate-rise justify-end pl-8 pr-3.5 motion-reduce:animate-none"
		>
			<div
				className={`flex w-full max-w-[min(100%,480px)] flex-col overflow-hidden rounded-2xl border bg-sunken ${awaitingApproval ? "border-primary/35 shadow-[0_8px_28px_rgba(53,107,85,.1)]" : "border-agent-wash"}`}
			>
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded((open) => !open)}
					className="flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-agent-wash/40 focus-visible:outline-2 focus-visible:outline-ring"
				>
					{awaitingApproval ? (
						<ShieldQuestion className="size-4 shrink-0 text-primary" aria-hidden />
					) : (
						<Wrench
							className={`size-4 shrink-0 text-agent-name ${call.status === "running" ? "animate-pulse" : ""}`}
							aria-hidden
						/>
					)}
					<span className="min-w-0 flex-1 truncate font-semibold text-heading text-md">
						{denied
							? "Denied "
							: awaitingApproval
								? "Approval needed for "
								: approvedWaiting
									? "Approved "
									: "Used "}
						<code className="font-mono font-medium">{call.tool}</code>
						{call.mutating && !awaitingApproval && !approvedWaiting && !denied && (
							<span className="ml-2 rounded-md bg-agent-wash px-1.5 py-0.5 font-medium text-agent-name text-xs">
								acted
							</span>
						)}
					</span>
					<span
						className={`shrink-0 text-xs ${call.status === "failed" ? "font-semibold text-destructive" : "text-muted-foreground"}`}
					>
						{standing(call)}
					</span>
					<Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden />
				</button>
				{expanded && (
					<div className="border-agent-wash border-t px-3.5 py-3 text-xs">
						<dl className="m-0 flex flex-col gap-2">
							<Field label={awaitingApproval ? "Requested input" : "Input"} value={call.input} />
							{call.status === "completed" && <Field label="Output" value={call.output} />}
							{call.status === "failed" && (
								<div>
									<dt className="font-semibold text-muted-foreground">Error</dt>
									<dd className="m-0 whitespace-pre-wrap text-destructive">
										{call.error ?? "No reason was recorded"}
									</dd>
								</div>
							)}
						</dl>
						{awaitingApproval && canApprove && (
							<ApprovalActions
								callId={call.id}
								threadId={threadId}
								podId={podId}
								canAlwaysAllow={canAlwaysAllow}
							/>
						)}
						{awaitingApproval && !canApprove && (
							<p className="m-0 mt-3 border-agent-wash border-t pt-3 text-muted-foreground">
								Waiting for someone with permission to review this action.
							</p>
						)}
					</div>
				)}
			</div>
		</section>
	);
}

function ApprovalActions({
	callId,
	threadId,
	podId,
	canAlwaysAllow,
}: {
	callId: string;
	threadId: string;
	podId: string;
	canAlwaysAllow: boolean;
}) {
	const review = useReviewToolCall(threadId, podId);
	return (
		<>
			<div className="mt-3 flex flex-wrap gap-2 border-agent-wash border-t pt-3">
				<Button
					size="sm"
					disabled={review.isPending}
					onClick={() => review.mutate({ toolCallId: callId, decision: "allow_once" })}
				>
					<Check aria-hidden size={14} /> Allow once
				</Button>
				{canAlwaysAllow && (
					<Button
						variant="secondary"
						size="sm"
						disabled={review.isPending}
						onClick={() => review.mutate({ toolCallId: callId, decision: "always_allow" })}
					>
						Always allow
					</Button>
				)}
				<Button
					variant="ghost"
					size="sm"
					disabled={review.isPending}
					onClick={() => review.mutate({ toolCallId: callId, decision: "deny" })}
				>
					<X aria-hidden size={14} /> Deny
				</Button>
			</div>
			{review.error && (
				<p role="alert" className="m-0 mt-2 text-destructive">
					{failureMessage(review.error)}
				</p>
			)}
		</>
	);
}

function Field({ label, value }: { label: string; value: unknown }) {
	return (
		<div>
			<dt className="font-semibold text-muted-foreground">{label}</dt>
			<dd className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-foreground">
				{JSON.stringify(value, null, 2)}
			</dd>
		</div>
	);
}

function standing(call: ToolCallPart): string {
	if (call.approval?.status === "denied") return "denied";
	switch (call.status) {
		case "awaiting_approval":
			return call.approval?.status === "allowed" ? "waiting to run" : "waiting for approval";
		case "running":
			return "working…";
		case "failed":
			return "failed";
		case "completed":
			return call.finishedAt ? took(call.startedAt, call.finishedAt) : "done";
	}
}

function took(startedAt: string, finishedAt: string): string {
	const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
	if (ms < 1_000) return `${Math.max(ms, 0)} ms`;
	return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
