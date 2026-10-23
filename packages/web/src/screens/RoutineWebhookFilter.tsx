import { type WebhookCondition, webhookConditionSchema } from "@sugabots/contracts";
import { Option, Schema } from "effect";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsAddRow, SettingsGroup } from "@/ui/settings-page.tsx";

/*
 * What a webhook requires of a call before it starts a run: a list of
 * conditions, each a path into the call's JSON body and the values it may
 * have. With none, every call runs.
 */

const FILTER_NOTE =
	"A call runs the routine only if it meets every condition. A path joins keys with dots, such as data.labels.name. Separate values with commas to accept any of them.";

const decodeCondition = Schema.decodeUnknownOption(webhookConditionSchema);

/** The condition typed as `path` and comma-separated `values`, if it is complete and allowed. */
function conditionOf(path: string, values: string): WebhookCondition | undefined {
	const oneOf = values
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value !== "");
	return Option.getOrUndefined(decodeCondition({ path, oneOf }));
}

const keyOf = (condition: WebhookCondition) => `${condition.path}=${condition.oneOf.join(",")}`;

/** `filter` without a condition that repeats an earlier one, which would also share its row's key. */
const withoutRepeats = (filter: WebhookCondition[]) =>
	filter.filter(
		(condition, at) => filter.findIndex((one) => keyOf(one) === keyOf(condition)) === at,
	);

/** A webhook's filter, which saves through `onChange` as each condition is completed, changed or removed. */
export function FilterGroup({
	filter,
	onChange,
}: {
	filter: readonly WebhookCondition[];
	onChange: (filter: WebhookCondition[]) => void;
}) {
	const [adding, setAdding] = useState(false);
	return (
		<SettingsGroup label="Filter" note={FILTER_NOTE}>
			{filter.map((condition, index) => (
				<ConditionRow
					// The condition is its own key, so a row changed elsewhere starts again from what was saved.
					key={keyOf(condition)}
					label={String(index + 1)}
					condition={condition}
					onCommit={(next) =>
						onChange(withoutRepeats(filter.map((one, at) => (at === index ? next : one))))
					}
					onRemove={() => onChange(filter.filter((_, at) => at !== index))}
				/>
			))}
			{adding ? (
				<ConditionRow
					label={String(filter.length + 1)}
					onCommit={(next) => {
						setAdding(false);
						onChange(withoutRepeats([...filter, next]));
					}}
					onRemove={() => setAdding(false)}
				/>
			) : (
				<SettingsAddRow label="Add condition" onClick={() => setAdding(true)} />
			)}
		</SettingsGroup>
	);
}

/**
 * One condition's path and values. It saves once both are filled in and
 * focus leaves the row, and a saved one that is emptied or made invalid goes
 * back to what was saved.
 */
function ConditionRow({
	label,
	condition,
	onCommit,
	onRemove,
}: {
	label: string;
	condition?: WebhookCondition;
	onCommit: (condition: WebhookCondition) => void;
	onRemove: () => void;
}) {
	const savedValues = condition?.oneOf.join(", ") ?? "";
	const [path, setPath] = useState(condition?.path ?? "");
	const [values, setValues] = useState(savedValues);

	function commit() {
		const next = conditionOf(path, values);
		if (next) {
			if (next.path !== condition?.path || next.oneOf.join(", ") !== savedValues) onCommit(next);
		} else if (condition) {
			setPath(condition.path);
			setValues(savedValues);
		}
	}

	const input =
		"min-w-0 rounded-md bg-transparent px-2 py-1 font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)";
	return (
		<fieldset
			aria-label={`Condition ${label}`}
			onBlur={(event) => {
				// Moving between this row's fields isn't leaving it.
				if (!event.currentTarget.contains(event.relatedTarget)) commit();
			}}
			className="m-0 flex min-h-[46px] min-w-0 items-center gap-2 border-border border-b px-4 py-2.5 last:border-b-0"
		>
			<input
				aria-label={`Path ${label}`}
				value={path}
				onChange={(event) => setPath(event.target.value)}
				placeholder="data.labels.name"
				autoComplete="off"
				spellCheck={false}
				className={`${input} flex-1`}
			/>
			<input
				aria-label={`Values ${label}`}
				value={values}
				onChange={(event) => setValues(event.target.value)}
				placeholder="10x"
				autoComplete="off"
				spellCheck={false}
				className={`${input} flex-1`}
			/>
			<IconButton label={`Remove condition ${label}`} size="lg" onClick={onRemove}>
				<Trash2 />
			</IconButton>
		</fieldset>
	);
}
