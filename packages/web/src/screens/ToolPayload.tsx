import { Check, Copy } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Button } from "@/ui/button.tsx";
import { wordsFromKey } from "./tool-activity.ts";

/*
 * What a tool call was sent or gave back, laid out for reading rather than as
 * JSON: a record as its fields named in words, a list of records as numbered
 * entries or a table, and anything nested too deep as indented JSON.
 */

export type Fields = [string, unknown][];

/** A value's named fields in order, or nothing when it is not a record of them. */
export function fieldsOf(value: unknown): Fields | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const fields = Object.entries(value);
	return fields.length > 0 ? fields : undefined;
}

/** A list with nothing structured in it, which reads well enough as its items in a row. */
function isPlainList(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.every((item) => item === null || typeof item !== "object");
}

export function count(amount: number, one: string, many: string): string {
	return `${amount} ${amount === 1 ? one : many}`;
}

/**
 * A value in brief: text as itself, a list of plain values as those
 * values, and anything with structure inside as a count of what it holds,
 * which the full payload spells out.
 */
export function briefly(value: unknown): { text: string; counted: boolean } {
	if (typeof value === "string") return { text: value, counted: false };
	if (isPlainList(value)) return { text: value.map(String).join(", "), counted: false };
	if (Array.isArray(value)) return { text: count(value.length, "item", "items"), counted: true };
	if (value !== null && typeof value === "object") {
		return { text: count(Object.keys(value).length, "field", "fields"), counted: true };
	}
	return { text: String(value), counted: false };
}

/** A non-empty list with records or lists in it, as opposed to plain values. */
export function isRecordList(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0 && !isPlainList(value);
}

/** Past this depth a value is written as JSON rather than nested any further. */
const MAX_DEPTH = 3;

/** A long list shows this many entries until asked for the rest. */
const ENTRIES_SHOWN = 10;

/** A tool call's input or output, laid out in full. */
export function ToolPayload({ value }: { value: unknown }) {
	return <PayloadValue value={value} depth={0} />;
}

/**
 * A value laid out for reading: a record as its fields, a list of records as
 * numbered entries, anything too deep to lay out as indented JSON.
 */
function PayloadValue({ value, depth }: { value: unknown; depth: number }) {
	const fields = fieldsOf(value);
	if (fields && depth < MAX_DEPTH) return <FieldList fields={fields} depth={depth} />;
	if (isRecordList(value) && depth < MAX_DEPTH) return <EntryList entries={value} depth={depth} />;
	if (value !== null && typeof value === "object" && !isPlainList(value)) {
		return (
			<pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-sunken px-2.5 py-2 font-mono text-2xs text-foreground">
				{JSON.stringify(value, null, 2)}
			</pre>
		);
	}
	return <PlainValue value={value} />;
}

/**
 * A record's fields, named in words. A field holding more structure puts it
 * under its name, indented along a guide line, rather than beside it.
 */
function FieldList({ fields, depth }: { fields: Fields; depth: number }) {
	return (
		<dl className="m-0 grid grid-cols-[fit-content(9rem)_minmax(0,1fr)] gap-x-4 gap-y-2">
			{fields.map(([key, value]) => {
				const nested = hasStructure(value);
				return (
					<div key={key} className="col-span-2 grid grid-cols-subgrid">
						<dt className="truncate text-muted-foreground text-xs leading-5">
							{wordsFromKey(key)}
						</dt>
						{nested ? (
							<dd className="col-span-2 m-0 min-w-0">
								{Array.isArray(value) && (
									<span className="sr-only">{count(value.length, "entry", "entries")}</span>
								)}
								<div className="mt-1 ml-1 border-border-subtle border-l pl-3">
									<PayloadValue value={value} depth={depth + 1} />
								</div>
							</dd>
						) : (
							<dd className="m-0 min-w-0">
								<PlainValue value={value} />
							</dd>
						)}
					</div>
				);
			})}
		</dl>
	);
}

/** Whether a value has fields or records inside, and so is laid out under its name. */
function hasStructure(value: unknown): boolean {
	return isRecordList(value) || fieldsOf(value) !== undefined;
}

/** A list of records, the first few until asked for the rest. */
function EntryList({ entries, depth }: { entries: unknown[]; depth: number }) {
	const [showAll, setShowAll] = useState(false);
	return (
		<div className="flex flex-col items-start gap-2">
			<Entries entries={showAll ? entries : entries.slice(0, ENTRIES_SHOWN)} depth={depth} />
			{entries.length > ENTRIES_SHOWN && (
				<button
					type="button"
					onClick={() => setShowAll((was) => !was)}
					className="focus-ring ml-7 cursor-pointer rounded-md font-semibold text-primary text-xs"
				>
					{showAll ? "Show fewer" : `Show all ${entries.length}`}
				</button>
			)}
		</div>
	);
}

/**
 * Records as numbered entries. Records that all share the same few fields are
 * a table, so those fields are named once rather than on every entry.
 */
export function Entries({ entries, depth }: { entries: unknown[]; depth: number }) {
	const columns = sharedColumnsOf(entries);
	if (columns) return <EntryTable columns={columns} rows={entries as Record<string, unknown>[]} />;
	return (
		<ol className="m-0 flex w-full list-none flex-col gap-2 p-0">
			{entries.map((entry, index) => (
				// Entries have no identity of their own beyond where they sit.
				// biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
				<li key={index} className="flex gap-2.5">
					<EntryNumber>{index + 1}</EntryNumber>
					<div className="min-w-0 flex-1">
						{isSmallRecord(entry) ? (
							<SmallRecord fields={entry} />
						) : (
							<PayloadValue value={entry} depth={depth + 1} />
						)}
					</div>
				</li>
			))}
		</ol>
	);
}

/** The fields every entry has, in the same order, when they are few and flat enough for a table. */
function sharedColumnsOf(entries: unknown[]): string[] | undefined {
	const [first] = entries;
	if (!isSmallRecord(first)) return undefined;
	const columns = Object.keys(first);
	const shared = entries.every(
		(entry) =>
			isSmallRecord(entry) &&
			Object.keys(entry).length === columns.length &&
			columns.every((column) => column in entry),
	);
	return shared ? columns : undefined;
}

function EntryTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
	return (
		<table className="border-collapse">
			<thead>
				<tr>
					<th scope="col" className="w-7 p-0">
						<span className="sr-only">Number</span>
					</th>
					{columns.map((column) => (
						<th
							key={column}
							scope="col"
							className="pr-4 pb-1 text-left font-normal text-muted-foreground text-xs"
						>
							{wordsFromKey(column)}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are where they sit, and never reorder
					<tr key={index}>
						<td className="py-1 pr-2.5 align-baseline">
							<EntryNumber>{index + 1}</EntryNumber>
						</td>
						{columns.map((column) => (
							<td key={column} className="py-1 pr-4 align-baseline">
								<PlainValue value={row[column]} />
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

function EntryNumber({ children }: { children: ReactNode }) {
	return (
		<span className="block w-5 shrink-0 text-right font-mono text-2xs text-muted-foreground leading-5">
			{children}
		</span>
	);
}

/** A record this small and flat reads best on one line, which is most list entries. */
const SMALL_RECORD_FIELDS = 4;

function isSmallRecord(value: unknown): value is Record<string, unknown> {
	const fields = fieldsOf(value);
	return (
		fields !== undefined &&
		fields.length <= SMALL_RECORD_FIELDS &&
		fields.every(([, field]) => !hasStructure(field))
	);
}

/** A small flat record on one line: each field's name, then its value. */
function SmallRecord({ fields }: { fields: Record<string, unknown> }) {
	return (
		<p className="m-0 leading-5">
			{Object.entries(fields).map(([key, value], index) => (
				<Fragment key={key}>
					{index > 0 && <span className="text-muted-foreground text-sm"> · </span>}
					<span className="text-muted-foreground text-xs">{wordsFromKey(key)}</span>{" "}
					<PlainValue value={value} />
				</Fragment>
			))}
		</p>
	);
}

/**
 * A single value as text: words as written, numbers in even figures, and
 * true, false and emptiness in a quieter voice, since they are flags rather
 * than content.
 */
function PlainValue({ value }: { value: unknown }) {
	if (isPlainList(value)) {
		if (value.length === 0) return <Quiet>None</Quiet>;
		return <span className="text-foreground text-sm">{value.map(String).join(", ")}</span>;
	}
	if (value === null || value === undefined || value === "") return <Quiet>Empty</Quiet>;
	if (typeof value === "boolean") return <Quiet>{value ? "Yes" : "No"}</Quiet>;
	if (typeof value === "number") {
		return <span className="text-foreground text-sm tabular-nums">{value}</span>;
	}
	if (fieldsOf(value) === undefined && typeof value === "object") return <Quiet>None</Quiet>;
	return <Text text={String(value)} />;
}

/**
 * Text longer than this is cut until asked for the rest. A tool's output can be
 * a whole fetched page, or the tens of thousands of characters the server kept
 * of one too large to store, and either would bury everything around it.
 */
const TEXT_SHOWN_CHARACTERS = 1_000;

function Text({ text }: { text: string }) {
	const [showAll, setShowAll] = useState(false);
	const long = text.length > TEXT_SHOWN_CHARACTERS;
	return (
		<span className="whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground text-sm">
			{long && !showAll ? `${text.slice(0, TEXT_SHOWN_CHARACTERS)}…` : text}
			{long && (
				<button
					type="button"
					onClick={() => setShowAll((was) => !was)}
					className="focus-ring ml-1.5 cursor-pointer rounded-md font-semibold text-primary text-xs"
				>
					{showAll ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
				</button>
			)}
		</span>
	);
}

function Quiet({ children }: { children: ReactNode }) {
	return <span className="text-muted-foreground text-sm">{children}</span>;
}

/** The payload exactly as it was stored, for anyone who needs the JSON itself. */
export function CopyJson({ value }: { value: unknown }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={() => {
				void navigator.clipboard?.writeText(JSON.stringify(value, null, 2));
				setCopied(true);
			}}
		>
			{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
			{copied ? "Copied" : "Copy JSON"}
		</Button>
	);
}
