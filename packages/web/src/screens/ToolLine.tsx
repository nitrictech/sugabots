import type { ToolCallPart } from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronRight, Wrench } from "lucide-react";
import { useId, useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import {
	BUILT_IN_HANDLE,
	connectionLabel,
	durationOf,
	formatDuration,
	formatTotal,
	splitToolKey,
	stepLabel,
	wordsFromKey,
} from "./tool-activity.ts";

/**
 * What a bot used on the way to a reply, as one line above it: "Used HubSpot
 * for 4s", or "Used Sentry, waiting on Linear approval". Opening it lists each
 * call with its app, its tool in words, what came back and how long it took.
 */
export function ToolLine({
	calls,
	looks,
	className,
}: {
	calls: readonly ToolCallPart[];
	looks: ReadonlyMap<string, ConnectionLook>;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	if (calls.length === 0) return null;

	return (
		<div className={cn("flex flex-col items-start", className)}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen(!open)}
				className="focus-ring flex items-center gap-1.5 rounded-md pb-1.5 font-medium text-muted-foreground text-sm transition-colors hover:text-soft-foreground"
			>
				{toolLineText(calls, looks)}
				<ChevronRight
					aria-hidden
					size={10}
					strokeWidth={3}
					className={cn(
						"shrink-0 text-subtle-foreground transition-transform duration-150 motion-reduce:transition-none",
						open && "rotate-90",
					)}
				/>
			</button>
			{open && (
				<ul
					id={listId}
					className="m-0 mb-2 flex w-full max-w-[470px] list-none flex-col border-hover border-l-[1.5px] py-0.5 pl-3.5"
				>
					{calls.map((call) => (
						<ToolCallRow
							key={call.id}
							call={call}
							look={looks.get(splitToolKey(call.tool).handle)}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function ToolCallRow({ call, look }: { call: ToolCallPart; look?: ConnectionLook }) {
	const { handle, name } = splitToolKey(call.tool);
	const app = appOf(call, look);
	const failed = call.status === "failed";
	return (
		<li className="flex min-w-0 items-center gap-2 py-[3px]">
			{handle === BUILT_IN_HANDLE ? (
				// Built into every bot, so it has no app's mark: a tool's.
				<span
					aria-hidden
					className="grid size-4 shrink-0 place-items-center rounded-xs bg-border-strong text-soft-foreground"
				>
					<Wrench size={10} strokeWidth={2.4} />
				</span>
			) : (
				<ConnectionMark presetId={look?.presetId} name={app} size="xs" />
			)}
			<span className="shrink-0 font-medium text-[13px] text-soft-foreground">
				{stepLabel(call.tool, name)}
			</span>
			<span
				className={cn(
					"min-w-0 flex-1 truncate font-mono text-sm",
					failed ? "text-destructive-text" : "text-subtle-foreground",
				)}
			>
				{resultOf(call)}
			</span>
			{call.finishedAt && (
				<span className="shrink-0 font-mono text-[11.5px] text-subtle-foreground">
					{formatDuration(durationOf(call))}
				</span>
			)}
		</li>
	);
}

/** The app a call reached, by name: the connection, or the built-in tool itself ("Web search"). */
function appOf(call: ToolCallPart, look?: ConnectionLook): string {
	const { handle } = splitToolKey(call.tool);
	return handle === BUILT_IN_HANDLE ? wordsFromKey(call.tool) : connectionLabel(handle, look?.name);
}

/**
 * The line's words. Finished calls are "used"; then, at most one of what the
 * reply is stopped on: a call waiting for approval, one still running, or one
 * that was refused.
 */
export function toolLineText(
	calls: readonly ToolCallPart[],
	looks: ReadonlyMap<string, ConnectionLook>,
): string {
	const apps = (matching: (call: ToolCallPart) => boolean) =>
		listed([
			...new Set(
				calls
					.filter(matching)
					.map((call) => appOf(call, looks.get(splitToolKey(call.tool).handle))),
			),
		]);
	const denied = (call: ToolCallPart) => call.approval?.status === "denied";
	const waiting = (call: ToolCallPart) =>
		call.status === "awaiting_approval" && call.approval?.status === "pending";
	const running = (call: ToolCallPart) => call.status === "running";
	const finished = (call: ToolCallPart) =>
		(call.status === "completed" || call.status === "failed") && !denied(call);

	const used = apps(finished);
	const tail = calls.some(waiting)
		? `waiting on ${apps(waiting)} approval`
		: calls.some(running)
			? `using ${apps(running)}`
			: calls.some(denied)
				? `${apps(denied)} denied`
				: undefined;

	if (!tail) {
		const totalMs = calls.filter(finished).reduce((sum, call) => sum + durationOf(call), 0);
		return `Used ${used} for ${formatTotal(totalMs)}`;
	}
	return used ? `Used ${used}, ${tail}` : capitalised(tail);
}

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function capitalised(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What came back from a call, in a few words: its error, its state, or its output in brief. */
function resultOf(call: ToolCallPart): string {
	if (call.approval?.status === "denied") {
		return call.approval.decidedByName ? `Denied by ${call.approval.decidedByName}` : "Denied";
	}
	if (call.status === "failed") return call.error ?? "Failed";
	if (call.status === "awaiting_approval") return "Waiting for approval";
	if (call.status === "running") return "Running";
	return briefly(call.output);
}

function briefly(output: unknown): string {
	if (output === null || output === undefined) return "Done";
	if (typeof output === "string") return output.split("\n")[0] ?? "";
	if (Array.isArray(output)) return resultCount(output.length);
	if (typeof output !== "object") return String(output);
	return brieflyFromObject(output as Record<string, unknown>) ?? JSON.stringify(output);
}

/**
 * An object's gist, for the shapes tools answer in: `{ ok: false, reason }`
 * gives the reason, a list inside (`{ ok: true, results: [...] }`) its count,
 * and a page (`{ page: { title } }`) its title.
 */
function brieflyFromObject(output: Record<string, unknown>): string | undefined {
	if (output.ok === false) {
		const why = output.reason ?? output.error ?? output.message;
		return typeof why === "string" ? why : "Failed";
	}
	const list = Object.values(output).find(Array.isArray);
	if (list) return resultCount(list.length);
	const page = output.page;
	const title =
		page && typeof page === "object" ? (page as Record<string, unknown>).title : output.title;
	return typeof title === "string" && title.trim() !== "" ? title : undefined;
}

function resultCount(count: number): string {
	return `${count} ${count === 1 ? "result" : "results"}`;
}
