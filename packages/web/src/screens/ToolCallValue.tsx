import { cn } from "cn";
import { wordsFromKey } from "@/lib/tool-names.ts";

/** Text longer than this, or on more than one line, is a block of its own rather than inline. */
const INLINE_TEXT_CHARACTERS = 120;

/** How many of a list's items are shown before the rest are counted. */
const SHOWN_ITEMS = 25;

/** How deep fields nest before what is inside is written as compact JSON. */
const NESTED_FIELDS_DEPTH = 4;

/**
 * A tool call's input or output laid out to read, on one panel: text as it
 * was, in mono; an object as its fields, named in words with the key on hover;
 * a list as its items. An object that only wraps a piece of text, such as
 * `{ text }`, is that text. Images a tool was shown are counted, not printed.
 * `otherArguments`, when the value is an input's main text, go under it.
 */
export function ToolCallValue({
	value,
	failed,
	otherArguments,
}: {
	value: unknown;
	failed?: boolean;
	otherArguments?: unknown;
}) {
	const text = soleText(value);
	return (
		<div
			className={cn(
				"min-w-0 overflow-hidden rounded-md bg-chip text-[12.5px]",
				failed ? "text-destructive-text" : "text-soft-foreground",
			)}
		>
			{text === undefined ? (
				<div className="px-3 py-2">
					<Value value={value} depth={0} />
				</div>
			) : (
				<TextBlock text={text} className="max-h-60 px-3 py-2" />
			)}
			{otherArguments !== undefined && (
				<div className="border-border-strong border-t px-3 py-2">
					<Value value={otherArguments} depth={0} />
				</div>
			)}
		</div>
	);
}

/** The text a value is: itself, or the one field of an object that only wraps text. */
function soleText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const fields = Object.values(value);
	return fields.length === 1 && typeof fields[0] === "string" ? fields[0] : undefined;
}

function Value({ value, depth }: { value: unknown; depth: number }) {
	if (value === null || value === undefined) return <Empty />;
	if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
	if (typeof value === "string") return <Text text={value} />;
	if (typeof value !== "object") return <span className="font-mono">{String(value)}</span>;
	if (depth >= NESTED_FIELDS_DEPTH) {
		return <span className="break-all font-mono text-[12px]">{JSON.stringify(value)}</span>;
	}
	if (Array.isArray(value)) return <Items items={value} depth={depth} />;
	return <Fields fields={value as Record<string, unknown>} depth={depth} />;
}

function Fields({ fields, depth }: { fields: Record<string, unknown>; depth: number }) {
	const entries = Object.entries(fields);
	if (entries.length === 0) return <Empty />;
	return (
		<dl className="m-0 grid min-w-0 grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
			{entries.map(([key, value]) => (
				<div key={key} className="contents">
					<dt title={key} className="max-w-40 break-words text-muted-foreground">
						{wordsFromKey(key)}
					</dt>
					<dd className="m-0 min-w-0">
						{key === "images" && Array.isArray(value) ? (
							<span>{counted(value.length, "image")}</span>
						) : (
							<Value value={value} depth={depth + 1} />
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function Items({ items, depth }: { items: readonly unknown[]; depth: number }) {
	if (items.length === 0) return <Empty />;
	if (items.every(isShortScalar)) return <span>{items.map(String).join(", ")}</span>;
	const hidden = items.length - SHOWN_ITEMS;
	return (
		<div className="flex min-w-0 flex-col">
			<ol className="m-0 flex list-none flex-col divide-y divide-border-strong p-0">
				{items.slice(0, SHOWN_ITEMS).map((item, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a call's output never changes once it is shown.
					<li key={index} className="min-w-0 py-1.5 first:pt-0 last:pb-0">
						<Value value={item} depth={depth + 1} />
					</li>
				))}
			</ol>
			{hidden > 0 && <span className="pt-1.5 text-muted-foreground">And {hidden} more</span>}
		</div>
	);
}

function Text({ text }: { text: string }) {
	if (text.includes("\n") || text.length > INLINE_TEXT_CHARACTERS) {
		return <TextBlock text={text} className="max-h-40" />;
	}
	if (/^https?:\/\/\S+$/.test(text)) {
		return (
			<a href={text} target="_blank" rel="noreferrer" className="break-all text-link underline">
				{text}
			</a>
		);
	}
	return <span className="break-words">{text}</span>;
}

/** Text as it was, in mono, scrolling within itself past the height `className` gives it. */
function TextBlock({ text, className }: { text: string; className: string }) {
	return (
		<pre
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard.
			tabIndex={0}
			className={cn(
				"focus-ring m-0 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed",
				className,
			)}
		>
			{text}
		</pre>
	);
}

function Empty() {
	return <span className="text-muted-foreground">None</span>;
}

function isShortScalar(value: unknown): boolean {
	if (typeof value === "string") return value.length <= 40 && !value.includes("\n");
	return typeof value === "number" || typeof value === "boolean";
}

function counted(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
