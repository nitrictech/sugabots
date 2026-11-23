import {
	MAX_WEBHOOK_FILTER_TESTS,
	MAX_WEBHOOK_FILTER_TEXT_CHARACTERS,
	MAX_WEBHOOK_FILTER_VALUES,
	type WebhookFilterTest,
	webhookFilterTestSchema,
} from "@sugabots/contracts";
import { Option, Schema } from "effect";
import { Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSaving } from "@/lib/saving.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsAddRow, SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { Textarea } from "@/ui/textarea.tsx";

const decodeFilterTest = Schema.decodeOption(webhookFilterTestSchema);

export function FilterGroup({
	filter,
	onChange,
	onEditingChange,
}: {
	filter: readonly WebhookFilterTest[];
	onChange: (filter: WebhookFilterTest[]) => Promise<unknown>;
	onEditingChange?: (editing: boolean) => void;
}) {
	const [editing, setEditing] = useState<number | "new">();
	const saving = useSaving();
	const { pending } = saving;
	async function save(next: WebhookFilterTest[]) {
		if (!(await saving.save(() => onChange(next)))) return;
		setEditing(undefined);
		onEditingChange?.(false);
	}
	function beginEditing(target: number | "new") {
		setEditing(target);
		onEditingChange?.(true);
	}
	function cancel() {
		setEditing(undefined);
		onEditingChange?.(false);
		saving.clearFailure();
	}
	return (
		<SettingsGroup
			label="Filter"
			note="Every test must pass. Paths join JSON keys with dots, such as data.labels.name. Each value is a separate alternative; commas and whitespace are matched literally."
		>
			{filter.map((filterTest, index) =>
				editing === index ? (
					<FilterTestEditor
						key={JSON.stringify(filterTest)}
						filterTest={filterTest}
						pending={pending}
						onSave={(next) => void save(filter.map((saved, at) => (at === index ? next : saved)))}
						onCancel={cancel}
					/>
				) : (
					<SettingsRow
						// biome-ignore lint/suspicious/noArrayIndexKey: saved rows hold no drafts; the active editor is keyed by its test.
						key={index}
						label={<span className="font-mono">{filterTest.path}</span>}
						sub={filterTest.oneOf.map((value) => JSON.stringify(value)).join(", ")}
						trailing={
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="secondary"
									size="sm"
									aria-label={`Edit test ${index + 1}`}
									disabled={pending || editing !== undefined}
									onClick={() => beginEditing(index)}
								>
									Edit
								</Button>
								<IconButton
									label={`Remove test ${index + 1}`}
									disabled={pending || editing !== undefined}
									onClick={() => void save(filter.filter((_, at) => at !== index))}
								>
									<Trash2 />
								</IconButton>
							</div>
						}
					/>
				),
			)}
			{editing === "new" ? (
				<FilterTestEditor
					pending={pending}
					onSave={(next) => void save([...filter, next])}
					onCancel={cancel}
				/>
			) : editing === undefined && !pending && filter.length < MAX_WEBHOOK_FILTER_TESTS ? (
				<SettingsAddRow label="Add test" onClick={() => beginEditing("new")} />
			) : null}
			{filter.length >= MAX_WEBHOOK_FILTER_TESTS && (
				<p className="m-0 px-4 py-3 text-muted-foreground text-xs">
					At most {MAX_WEBHOOK_FILTER_TESTS} tests.
				</p>
			)}
			{saving.failure !== undefined && <Alert>{failureMessage(saving.failure)}</Alert>}
		</SettingsGroup>
	);
}

function FilterTestEditor({
	filterTest,
	pending,
	onSave,
	onCancel,
}: {
	filterTest?: WebhookFilterTest;
	pending: boolean;
	onSave: (filterTest: WebhookFilterTest) => void;
	onCancel: () => void;
}) {
	const pathId = useId();
	const [path, setPath] = useState(filterTest?.path ?? "");
	const [values, setValues] = useState(() =>
		(filterTest?.oneOf ?? [""]).map((text) => ({ id: crypto.randomUUID(), text })),
	);
	const decoded = decodeFilterTest({ path, oneOf: values.map((value) => value.text) });
	return (
		<fieldset
			disabled={pending}
			className="m-0 flex min-w-0 flex-col gap-3 border-border border-b p-4 last:border-b-0"
			onKeyDown={(event) => {
				if (event.key === "Enter" && event.target instanceof HTMLInputElement)
					event.preventDefault();
			}}
		>
			<legend className="sr-only">{filterTest ? "Edit test" : "New test"}</legend>
			<label htmlFor={pathId} className="text-foreground text-xs">
				JSON path
			</label>
			<input
				id={pathId}
				value={path}
				onChange={(event) => setPath(event.target.value)}
				maxLength={MAX_WEBHOOK_FILTER_TEXT_CHARACTERS}
				autoComplete="off"
				spellCheck={false}
				placeholder="data.labels.name"
				className="focus-ring min-w-0 rounded-md border border-border bg-list px-3 py-2 font-mono text-foreground text-xs"
			/>
			{values.map((value, index) => (
				<div key={value.id} className="flex items-start gap-2">
					<Textarea
						aria-label={`Accepted value ${index + 1}`}
						value={value.text}
						rows={1}
						maxLength={MAX_WEBHOOK_FILTER_TEXT_CHARACTERS}
						spellCheck={false}
						onChange={(event) =>
							setValues(
								values.map((saved, at) =>
									at === index ? { ...saved, text: event.target.value } : saved,
								),
							)
						}
						className="min-h-10 rounded-md border-border px-3 py-2 font-mono text-xs"
					/>
					<IconButton
						label={`Remove value ${index + 1}`}
						disabled={pending || values.length === 1}
						onClick={() => setValues(values.filter((_, at) => at !== index))}
					>
						<Trash2 />
					</IconButton>
				</div>
			))}
			{values.length < MAX_WEBHOOK_FILTER_VALUES && (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="self-start"
					onClick={() => setValues([...values, { id: crypto.randomUUID(), text: "" }])}
				>
					Add value
				</Button>
			)}
			<p className="m-0 text-muted-foreground text-xs">
				Any accepted value may match. An empty value matches an empty string.
			</p>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="secondary" onClick={onCancel}>
					Cancel test
				</Button>
				<Button
					type="button"
					disabled={pending || Option.isNone(decoded)}
					onClick={() => {
						if (Option.isSome(decoded)) onSave(decoded.value);
					}}
				>
					Save test
				</Button>
			</div>
		</fieldset>
	);
}
