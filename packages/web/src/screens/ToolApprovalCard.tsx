import type { ToolCallPart } from "@sugabots/contracts";
import { useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { useElapsedSince } from "@/lib/elapsed.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useReviewToolCall } from "@/lib/threads.ts";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { ToolActivityDialog } from "./ToolActivityDialog.tsx";
import {
	connectionLabel,
	formatTotal,
	splitToolKey,
	stepLabel,
	type ToolActivity,
} from "./tool-activity.ts";

/*
 * A write an agent wants to make, and the run stopped until someone answers.
 *
 * Reads are summarised after the fact in the activity log and leave the thread
 * alone; a write cannot be, because by the time it could be summarised it has
 * already happened. So this is the one piece of tool machinery that still
 * interrupts: it shows the exact thing about to be done and what it would be
 * sent, as fields rather than JSON, because what is being judged is the record
 * that is about to exist.
 */

export function ToolApprovalCard({
	call,
	threadId,
	podId,
	canApprove,
	canAlwaysAllow,
	look,
}: {
	call: ToolCallPart;
	threadId: string;
	podId: string;
	canApprove: boolean;
	canAlwaysAllow: boolean;
	look?: ConnectionLook;
}) {
	const review = useReviewToolCall(threadId, podId);
	const [always, setAlways] = useState(false);
	const waitingMs = useElapsedSince(call.startedAt);
	const { handle, name } = splitToolKey(call.tool);
	const where = handle ? connectionLabel(handle, look?.name) : "";
	const label = stepLabel(call.tool, name);
	const title = where ? `${label} in ${where}` : label;
	return (
		<section
			aria-label={`Approval needed: ${title}`}
			className="flex animate-rise justify-start pr-8 pl-3.5 motion-reduce:animate-none"
		>
			<div className="flex w-full max-w-[min(100%,480px)] flex-col overflow-hidden rounded-2xl border border-warning/40 bg-card shadow-card">
				<div className="flex items-center gap-2 border-warning/25 border-b bg-warning/10 px-3.5 py-2">
					<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning" aria-hidden />
					<span className="min-w-0 flex-1 font-semibold text-heading text-xs">
						Paused — needs your approval
					</span>
					<span className="shrink-0 font-mono text-2xs text-muted-foreground">
						waiting {formatTotal(waitingMs)}
					</span>
				</div>

				<div className="flex items-start gap-2.5 px-3.5 pt-3">
					<ConnectionMark
						presetId={look?.presetId}
						name={where || label}
						hue={look?.hue ?? 250}
						size="sm"
					/>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="font-semibold text-base text-heading">{title}</span>
						<span className="text-muted-foreground text-xs">
							{call.mutating ? "May change things" : "Reads"}
							{where ? ` in ${where}` : ""} · <code className="font-mono">{name}</code>
						</span>
					</span>
				</div>

				<Payload input={call.input} />

				{canApprove ? (
					<div className="flex flex-col gap-2 border-border-subtle border-t bg-sunken px-3.5 py-2.5">
						{canAlwaysAllow && (
							<label className="flex cursor-pointer items-center gap-2 text-muted-foreground text-xs">
								<input
									type="checkbox"
									checked={always}
									onChange={(event) => setAlways(event.target.checked)}
									className="focus-ring size-3.5 shrink-0 cursor-pointer accent-primary"
								/>
								Always allow {label} {where ? `in ${where}` : ""}
							</label>
						)}
						<div className="flex flex-wrap justify-end gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={review.isPending}
								onClick={() => review.mutate({ toolCallId: call.id, decision: "deny" })}
							>
								Deny
							</Button>
							<Button
								size="sm"
								disabled={review.isPending}
								onClick={() =>
									review.mutate({
										toolCallId: call.id,
										decision: always ? "always_allow" : "allow_once",
									})
								}
							>
								Approve
							</Button>
						</div>
						{review.error && (
							<p role="alert" className="m-0 text-destructive text-xs">
								{failureMessage(review.error)}
							</p>
						)}
					</div>
				) : (
					<p className="m-0 border-border-subtle border-t bg-sunken px-3.5 py-2.5 text-muted-foreground text-xs">
						Waiting for someone with permission to answer this.
					</p>
				)}
			</div>
		</section>
	);
}

/**
 * What the tool would be sent, a field at a time. A value long enough to hide
 * the shape of the record is cut short with a way to see the rest, so the card
 * stays the size of a question rather than the size of the payload.
 */
function Payload({ input }: { input: ToolCallPart["input"] }) {
	const [showAll, setShowAll] = useState(false);
	const entries =
		input !== null && typeof input === "object" && !Array.isArray(input)
			? Object.entries(input)
			: undefined;
	if (!entries || entries.length === 0) {
		return (
			<pre className="mx-3.5 mt-3 mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border-subtle bg-sunken px-3 py-2 font-mono text-2xs text-foreground">
				{JSON.stringify(input, null, 2)}
			</pre>
		);
	}
	return (
		<dl className="m-0 mx-3.5 mt-3 mb-3 flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-sunken">
			{entries.map(([key, value]) => {
				const written = typeof value === "string" ? value : JSON.stringify(value);
				const long = written.length > 110;
				return (
					<div key={key} className="flex gap-3 px-3 py-1.5">
						<dt className="w-20 shrink-0 text-muted-foreground text-2xs">{key}</dt>
						<dd className="m-0 flex min-w-0 flex-1 gap-3 text-foreground text-xs">
							<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
								{long && !showAll ? `${written.slice(0, 110)}…` : written}
							</span>
							{long && (
								<button
									type="button"
									onClick={() => setShowAll((was) => !was)}
									className="focus-ring h-fit shrink-0 cursor-pointer rounded-md font-semibold text-2xs text-primary"
								>
									{showAll ? "Show less" : "Show all"}
								</button>
							)}
						</dd>
					</div>
				);
			})}
		</dl>
	);
}

/**
 * What a refusal leaves behind. An approved write folds away into the log with
 * everything else the turn did; a denied one stays, because it changed what
 * the reply was able to do and the thread would otherwise not say so.
 */
export function DeniedToolLine({
	call,
	activity,
	looks,
	at,
}: {
	call: ToolCallPart;
	activity: ToolActivity;
	looks?: ReadonlyMap<string, ConnectionLook>;
	at?: string;
}) {
	const [logOpen, setLogOpen] = useState(false);
	const { handle, name } = splitToolKey(call.tool);
	const where = handle ? connectionLabel(handle, looks?.get(handle)?.name) : "";
	const label = stepLabel(call.tool, name);
	const by = call.approval?.decidedByName;
	return (
		<div className="flex items-center gap-2 pr-8 pl-3.5 text-muted-foreground text-xs">
			<span className="min-w-0 flex-1">
				{by ? `${by} denied` : "Denied"}{" "}
				<span className="font-semibold text-foreground">
					{label}
					{where ? ` in ${where}` : ""}
				</span>
			</span>
			<button
				type="button"
				onClick={() => setLogOpen(true)}
				className="focus-ring shrink-0 cursor-pointer rounded-md px-1 font-semibold text-primary"
			>
				Review
			</button>
			<ToolActivityDialog
				activity={activity}
				looks={looks}
				at={at}
				open={logOpen}
				onOpenChange={setLogOpen}
			/>
		</div>
	);
}
