import {
	MAX_WEBHOOK_FILTER_CONDITIONS,
	MAX_WEBHOOK_FILTER_TEXT_CHARACTERS,
	MAX_WEBHOOK_FILTER_VALUES,
	type WebhookCondition,
	webhookConditionSchema,
} from "@sugabots/contracts";
import { Option, Schema } from "effect";
import { Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsAddRow, SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { Textarea } from "@/ui/textarea.tsx";

const decodeCondition = Schema.decodeOption(webhookConditionSchema);

export function FilterGroup({
	filter,
	onChange,
	onEditingChange,
}: {
	filter: readonly WebhookCondition[];
	onChange: (filter: WebhookCondition[]) => Promise<unknown>;
	onEditingChange?: (editing: boolean) => void;
}) {
	const [editing, setEditing] = useState<number | "new">();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>();
	async function save(next: WebhookCondition[]) {
		setPending(true);
		setError(undefined);
		try {
			await onChange(next);
			setEditing(undefined);
			onEditingChange?.(false);
		} catch (cause) {
			setError(cause);
		} finally {
			setPending(false);
		}
	}
	function beginEditing(target: number | "new") {
		setEditing(target);
		onEditingChange?.(true);
	}
	function cancel() {
		setEditing(undefined);
		onEditingChange?.(false);
		setError(undefined);
	}
	return (
		<SettingsGroup
			label="Filter"
			note="Every condition must match. Paths join JSON keys with dots, such as data.labels.name. Each value is a separate alternative; commas and whitespace are matched literally."
		>
			{filter.map((condition, index) =>
				editing === index ? (
					<ConditionEditor
						// biome-ignore lint/suspicious/noArrayIndexKey: conditions cannot be removed or reordered while an editor holds a draft.
						key={index}
						condition={condition}
						pending={pending}
						onSave={(next) => void save(filter.map((saved, at) => (at === index ? next : saved)))}
						onCancel={cancel}
					/>
				) : (
					<SettingsRow
						// biome-ignore lint/suspicious/noArrayIndexKey: conditions cannot be removed or reordered while an editor holds a draft.
						key={index}
						label={<span className="font-mono">{condition.path}</span>}
						sub={condition.oneOf.map((value) => JSON.stringify(value)).join(", ")}
						trailing={
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="secondary"
									size="sm"
									aria-label={`Edit condition ${index + 1}`}
									disabled={pending || editing !== undefined}
									onClick={() => beginEditing(index)}
								>
									Edit
								</Button>
								<IconButton
									label={`Remove condition ${index + 1}`}
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
				<ConditionEditor
					pending={pending}
					onSave={(next) => void save([...filter, next])}
					onCancel={cancel}
				/>
			) : editing === undefined && !pending && filter.length < MAX_WEBHOOK_FILTER_CONDITIONS ? (
				<SettingsAddRow label="Add condition" onClick={() => beginEditing("new")} />
			) : null}
			{filter.length >= MAX_WEBHOOK_FILTER_CONDITIONS && (
				<p className="m-0 px-4 py-3 text-muted-foreground text-sm">
					At most {MAX_WEBHOOK_FILTER_CONDITIONS} conditions.
				</p>
			)}
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
		</SettingsGroup>
	);
}

function ConditionEditor({
	condition,
	pending,
	onSave,
	onCancel,
}: {
	condition?: WebhookCondition;
	pending: boolean;
	onSave: (condition: WebhookCondition) => void;
	onCancel: () => void;
}) {
	const pathId = useId();
	const [path, setPath] = useState(condition?.path ?? "");
	const [values, setValues] = useState(() =>
		(condition?.oneOf ?? [""]).map((text) => ({ id: crypto.randomUUID(), text })),
	);
	const decoded = decodeCondition({ path, oneOf: values.map((value) => value.text) });
	return (
		<fieldset
			disabled={pending}
			className="m-0 flex min-w-0 flex-col gap-3 border-border border-b p-4 last:border-b-0"
			onKeyDown={(event) => {
				if (event.key === "Enter" && event.target instanceof HTMLInputElement)
					event.preventDefault();
			}}
		>
			<legend className="sr-only">{condition ? "Edit condition" : "New condition"}</legend>
			<label htmlFor={pathId} className="text-foreground text-sm">
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
				className="focus-ring min-w-0 rounded-md border border-border bg-list px-3 py-2 font-mono text-foreground text-sm"
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
						className="min-h-10 rounded-md border-border px-3 py-2 font-mono text-sm"
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
			<p className="m-0 text-muted-foreground text-sm">
				Any accepted value may match. An empty value matches an empty string.
			</p>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="secondary" onClick={onCancel}>
					Cancel condition
				</Button>
				<Button
					type="button"
					disabled={pending || Option.isNone(decoded)}
					onClick={() => {
						if (Option.isSome(decoded)) onSave(decoded.value);
					}}
				>
					Save condition
				</Button>
			</div>
		</fieldset>
	);
}
