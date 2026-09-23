import {
	builtInToolCatalog,
	CONNECTION_TOOL_SEPARATOR,
	type MessagePart,
	type ToolCallPart,
} from "@sugabots/contracts";

/*
 * What one reply's tool calls add up to, as the thread's live line, its step
 * count and its activity log all read it. Tool calls belong to the turn, not
 * to the transcript, so they are folded here rather than drawn one by one: the
 * log reads as a timeline of what the agent said on the way and the steps it
 * took, with back-to-back calls to the same tool collapsed into a single row
 * carrying how many there were.
 *
 * What the agent says just before a call is narration ("Now let me get the
 * cycle:"). It belongs with the steps it introduces, so it lives in the log and
 * not in the thread, where it would read as a sentence pointing at nothing.
 */

/** Calls to the product's own tools sit under this handle, which no connection can take. */
export const BUILT_IN_HANDLE = "";

/** What a step amounted to, in the terms the log colours and words it by. */
export type StepOutcome = "ok" | "error" | "skipped";

export interface ActivityStep {
	/** The first call's id, so a row keeps its identity as later calls fold in. */
	key: string;
	/** The key the model called, e.g. `sentry__search_issues`. */
	tool: string;
	label: string;
	/** The connection's handle, or `BUILT_IN_HANDLE` for the product's own tools. */
	handle: string;
	/** What the connection is called, e.g. `Sentry`. */
	connection: string;
	/** How many calls this one row stands for. */
	count: number;
	durationMs: number;
	outcome: StepOutcome;
	calls: ToolCallPart[];
}

/** One row of the log: something the agent said on the way, or a step it took. */
export type ActivityEntry =
	| { type: "said"; key: string; text: string }
	| { type: "step"; key: string; step: ActivityStep };

export interface ToolActivity {
	/** In the order it happened. */
	entries: ActivityEntry[];
	/** Calls, not rows: four folded into `×4` still count as four steps. */
	stepCount: number;
	durationMs: number;
	/** The most recent call, finished or not: the step the live line names. */
	latest: ToolCallPart | undefined;
	/** When the first call started, which is what the live line counts from. */
	startedAt: string | undefined;
}

/**
 * Whether the part at `index` is narration: text that comes straight before a
 * tool call. The thread leaves it out and the log shows it among the steps.
 */
export function isNarration(parts: readonly MessagePart[], index: number): boolean {
	return parts[index]?.type === "text" && parts[index + 1]?.type === "tool_call";
}

/**
 * The tool calls in a reply, and what it said before each, as the log shows
 * them. `names` maps a connection's handle to its display name; a handle it
 * does not carry — a connection since deleted — falls back to the handle
 * itself, written out.
 */
export function toolActivityOf(
	message: { parts: readonly MessagePart[] },
	names: ReadonlyMap<string, string> = new Map(),
): ToolActivity {
	const entries: ActivityEntry[] = [];
	const calls: ToolCallPart[] = [];
	message.parts.forEach((part, index) => {
		if (part.type === "text") {
			const text = part.text.trim();
			if (text && isNarration(message.parts, index)) {
				entries.push({ type: "said", key: `said@${index}`, text });
			}
			return;
		}
		if (part.type !== "tool_call") return;
		calls.push(part);
		const previous = entries.at(-1);
		if (previous?.type === "step" && previous.step.tool === part.tool) {
			foldInto(previous.step, part);
			return;
		}
		entries.push({ type: "step", key: part.id, step: stepOf(part, names) });
	});
	return {
		entries,
		stepCount: calls.length,
		durationMs: calls.reduce((total, call) => total + durationOf(call), 0),
		latest: calls.at(-1),
		startedAt: calls[0]?.startedAt,
	};
}

function stepOf(call: ToolCallPart, names: ReadonlyMap<string, string>): ActivityStep {
	const { handle, name } = splitToolKey(call.tool);
	return {
		key: call.id,
		tool: call.tool,
		label: stepLabel(call.tool, name),
		handle,
		connection: connectionLabel(handle, names.get(handle)),
		count: 1,
		durationMs: durationOf(call),
		outcome: outcomeOf([call]),
		calls: [call],
	};
}

function foldInto(step: ActivityStep, call: ToolCallPart) {
	step.count += 1;
	step.durationMs += durationOf(call);
	step.calls.push(call);
	step.outcome = outcomeOf(step.calls);
}

/**
 * What a connection is called wherever one of its tools is shown. A handle with
 * no connection behind it any more is written out rather than shown raw, so a
 * deleted connection reads as `Linear` and not as `linear`.
 */
export function connectionLabel(handle: string, name?: string): string {
	if (handle === BUILT_IN_HANDLE) return "Built-in tools";
	return name ?? wordsFromKey(handle);
}

/**
 * A tool key as the connection and the tool it names. A key with no separator
 * is one of the product's own tools, which belong to no connection.
 */
export function splitToolKey(tool: string): { handle: string; name: string } {
	const at = tool.indexOf(CONNECTION_TOOL_SEPARATOR);
	if (at < 0) return { handle: BUILT_IN_HANDLE, name: tool };
	return { handle: tool.slice(0, at), name: tool.slice(at + CONNECTION_TOOL_SEPARATOR.length) };
}

/**
 * What a step is called in the log.
 *
 * The product's own tools have written names in the catalog. A connection's tool
 * has only the key its server published, so the key is what gets written out:
 * `search_issues` reads as `Search issues`. That relies on the `verb_noun`
 * naming MCP servers conventionally use, and a server that names a tool
 * `API-post-search` or `doIt` gets that back tidied rather than fixed — a known
 * and accepted limit, to be dealt with if such a server turns up.
 *
 * Note this says which tool ran, never what it found. Saying what a call
 * returned means summarising its output, which nothing here produces.
 */
export function stepLabel(tool: string, name = splitToolKey(tool).name): string {
	const builtIn = builtInToolCatalog.find((entry) => entry.key === tool);
	return builtIn ? builtIn.name : wordsFromKey(name);
}

/**
 * A machine key written out as words: `search_issues` as `Search issues`,
 * `sentry` as `Sentry`, a tool argument's `due_date` or `dueDate` as `Due date`.
 */
export function wordsFromKey(key: string): string {
	const words = key
		.replace(
			/([a-z0-9])([A-Z])/g,
			(_, before: string, capital: string) => `${before} ${capital.toLowerCase()}`,
		)
		.replace(/[_-]+/g, " ")
		.trim();
	if (!words) return key;
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The worst thing that happened across the calls a row stands for, since that
 * is what someone scanning the log needs to see: a failure outranks a refusal.
 * What a step returned is not judged here — a call that came back with nothing
 * still ran, and the log has nothing to say about it that its own row does not.
 */
function outcomeOf(calls: readonly ToolCallPart[]): StepOutcome {
	if (calls.some((call) => call.status === "failed")) return "error";
	if (calls.some((call) => call.approval?.status === "denied")) return "skipped";
	return "ok";
}

export function durationOf(call: ToolCallPart): number {
	if (!call.finishedAt) return 0;
	return Math.max(new Date(call.finishedAt).getTime() - new Date(call.startedAt).getTime(), 0);
}

/** What one step or one connection took: `473ms`, `1.4s`, `30.6s`. */
export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	return `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * What the whole turn took: `32s`. Rounded where a step is not, because the
 * total is there to be read at a glance rather than added up.
 */
export function formatTotal(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	return `${Math.round(ms / 1_000)}s`;
}

/**
 * Why a failed step failed, once per distinct reason — a row folded from
 * several calls that all timed out has one thing to say, not four.
 */
export function stepErrors(step: ActivityStep): string[] {
	const reasons = step.calls
		.filter((call) => call.status === "failed")
		.map((call) => call.error)
		.filter((reason): reason is string => reason !== null && reason.trim() !== "");
	return [...new Set(reasons)];
}
