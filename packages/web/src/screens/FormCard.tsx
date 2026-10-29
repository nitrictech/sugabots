import {
	type ClassifiedFormField,
	classifyFormField,
	type FormContent,
	type FormField,
	type FormFieldValue,
	type FormRequest,
	formContentProblems,
	formFieldOptions,
	formFields,
	formFieldsInOrder,
	isRequiredField,
	type ThreadParticipant,
	type ToolCallForm,
	type ToolCallPart,
} from "@sugabots/contracts";
import { cn } from "cn";
import { Check, X } from "lucide-react";
import { useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useAnswerForm } from "@/lib/threads.ts";
import { wordsFromKey } from "@/lib/tool-names.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Button } from "@/ui/button.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Outcome } from "./ToolApprovalCard.tsx";
import { awaitsApproval } from "./tool-activity.ts";

/*
 * A form a bot asked the people in its thread to fill in, an MCP form-mode
 * elicitation, on a raised card under the bot's words. Anyone in the thread
 * may answer it or decline it; the first to do so is the one the bot hears,
 * and the card then shows what they said. Fields come prefilled with what the
 * bot proposed, so reviewing a draft is editing it.
 */

type Asker = Pick<
	Extract<ThreadParticipant, { kind: "agent" }>,
	"name" | "color" | "face" | "shape"
>;

export function FormCard({
	call,
	form,
	agent,
	threadId,
	podId,
}: {
	call: ToolCallPart;
	form: ToolCallForm;
	/** The bot whose reply is waiting on this. */
	agent: Asker;
	threadId: string;
	podId: string;
}) {
	const answering = useAnswerForm(threadId, podId);
	// What was sent stays shown from when it is sent until the thread's events say the form is answered.
	const sent = answering.isPending || answering.isSuccess;
	const open = awaitsApproval(call) && !form.response;
	return (
		<section
			aria-label={`Form from ${agent.name}`}
			className="flex animate-rise motion-reduce:animate-none"
		>
			<div className="flex min-w-0 max-w-[460px] flex-1 flex-col gap-3 rounded-[6px_20px_20px_20px] bg-card pt-2.5 pr-3 pb-3 pl-2.5 text-foreground">
				<div className="flex min-w-0 items-start gap-2.5">
					<span className="mt-px shrink-0">
						<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={24} />
					</span>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-muted-foreground text-xs leading-[1.4]">
							{agent.name} is asking
						</span>
						<span className="whitespace-pre-wrap text-pretty font-medium text-[14px] leading-[1.4] [overflow-wrap:anywhere]">
							{form.request.message}
						</span>
					</span>
				</div>
				<div className="min-w-0 md:ml-[34px]">
					{open ? (
						<OpenForm
							form={form}
							pending={sent}
							error={answering.error}
							onAnswer={(answer) => answering.mutate({ toolCallId: call.id, answer })}
						/>
					) : (
						<SettledForm form={form} agentName={agent.name} announced={answering.isSuccess} />
					)}
				</div>
			</div>
		</section>
	);
}

/** The fields to fill in, prefilled with the bot's defaults, and Send or Decline. */
function OpenForm({
	form,
	pending,
	error,
	onAnswer,
}: {
	form: ToolCallForm;
	pending: boolean;
	error: Error | null;
	onAnswer: (answer: { action: "accept"; content: FormContent } | { action: "decline" }) => void;
}) {
	const { request } = form;
	const [drafts, setDrafts] = useState(() => initialDrafts(request));
	// Problems are shown once someone tries to send, then kept current as they fix them.
	const [checked, setChecked] = useState(false);
	const content = contentOf(request, drafts);
	const problems = checked ? formContentProblems(request, content) : {};
	const send = () => {
		setChecked(true);
		if (Object.keys(formContentProblems(request, content)).length > 0) return;
		onAnswer({ action: "accept", content });
	};
	return (
		<form
			noValidate
			className="flex flex-col gap-3.5"
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			<fieldset disabled={pending} className="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
				{formFieldsInOrder(request, form.fieldOrder).map(([name, field]) => (
					<FieldInput
						key={name}
						name={name}
						field={field}
						required={isRequiredField(request, name)}
						draft={drafts[name]}
						problem={problems[name]}
						onChange={(draft) => setDrafts((current) => ({ ...current, [name]: draft }))}
					/>
				))}
			</fieldset>
			<div className="flex flex-col gap-1.5">
				<div className="flex flex-wrap gap-2">
					<Button type="submit" disabled={pending} className="h-[31px] px-4 text-[13px]">
						Send
					</Button>
					<Button
						type="button"
						variant="muted"
						disabled={pending}
						onClick={() => onAnswer({ action: "decline" })}
						className="h-[31px] px-4 text-[13px]"
					>
						Decline
					</Button>
				</div>
				{error && (
					<p role="alert" className="m-0 text-destructive-text text-xs">
						{failureMessage(error)}
					</p>
				)}
			</div>
		</form>
	);
}

/**
 * A field as it is being filled in. Text and numbers are kept as typed, so a
 * half-typed number is not lost; a choice of several is the values ticked.
 */
type Draft = string | boolean | readonly string[];

function initialDrafts(request: FormRequest): Record<string, Draft> {
	return Object.fromEntries(
		formFields(request).map(([name, field]) => [name, initialDraft(classifyFormField(field))]),
	);
}

function initialDraft(classified: ClassifiedFormField): Draft {
	switch (classified.kind) {
		case "boolean":
			return classified.field.default ?? false;
		case "multi-select":
			return classified.field.default ?? [];
		case "number":
			return classified.field.default === undefined ? "" : String(classified.field.default);
		case "single-select":
			return classified.field.default ?? "";
		case "text":
			return classified.field.format === "date-time" && classified.field.default
				? localDateTime(classified.field.default)
				: (classified.field.default ?? "");
	}
}

/** The answers the drafts give, leaving out fields left empty, which count as unanswered. */
function contentOf(request: FormRequest, drafts: Record<string, Draft>): FormContent {
	const content: Record<string, FormFieldValue> = {};
	for (const [name, field] of formFields(request)) {
		const value = answerOf(classifyFormField(field), drafts[name]);
		if (value !== undefined) content[name] = value;
	}
	return content;
}

function answerOf(
	classified: ClassifiedFormField,
	draft: Draft | undefined,
): FormFieldValue | undefined {
	if (typeof draft === "boolean") return draft;
	if (Array.isArray(draft)) return draft.length > 0 ? draft : undefined;
	if (typeof draft !== "string" || draft.trim() === "") return undefined;
	// What is not a number stays text, for the form's check to say so.
	if (classified.kind === "number") return Number.isFinite(Number(draft)) ? Number(draft) : draft;
	if (classified.kind === "text" && classified.field.format === "date-time") {
		const at = new Date(draft);
		return Number.isNaN(at.getTime()) ? draft : at.toISOString();
	}
	return draft;
}

/** A date and time as a `datetime-local` input takes it: the reader's own clock, to the minute. */
function localDateTime(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 16);
}

function FieldInput({
	name,
	field,
	required,
	draft,
	problem,
	onChange,
}: {
	name: string;
	field: FormField;
	required: boolean;
	draft: Draft | undefined;
	problem: string | undefined;
	onChange: (draft: Draft) => void;
}) {
	const id = useId();
	const label = field.title ?? wordsFromKey(name);
	const classified = classifyFormField(field);
	const describedBy = cn(field.description && `${id}-description`, problem && `${id}-problem`);
	const control = {
		id,
		"aria-describedby": describedBy || undefined,
		"aria-invalid": problem ? true : undefined,
		"aria-required": required || undefined,
	};
	const description = field.description && (
		<p id={`${id}-description`} className="m-0 text-pretty text-muted-foreground text-xs">
			{field.description}
		</p>
	);
	const problemText = problem && (
		<p id={`${id}-problem`} className="m-0 text-destructive-text text-xs">
			{problem}
		</p>
	);

	if (classified.kind === "boolean") {
		return (
			<div className="flex flex-col gap-1">
				<label className="flex cursor-pointer items-start gap-2 text-[14px]">
					<input
						{...control}
						type="checkbox"
						checked={draft === true}
						onChange={(event) => onChange(event.target.checked)}
						className="mt-0.5 size-4 shrink-0 accent-primary"
					/>
					<span>{label}</span>
				</label>
				{description}
				{problemText}
			</div>
		);
	}

	if (classified.kind === "single-select" || classified.kind === "multi-select") {
		const many = classified.kind === "multi-select";
		const chosen = new Set(typeof draft === "string" ? [draft] : Array.isArray(draft) ? draft : []);
		return (
			<fieldset
				aria-describedby={control["aria-describedby"]}
				aria-invalid={control["aria-invalid"]}
				className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
			>
				<legend className="mb-1 p-0 font-medium text-[13px] text-soft-foreground">
					<FieldLabel label={label} required={required} />
				</legend>
				{description}
				{formFieldOptions(field).map((option) => (
					<label key={option.value} className="flex cursor-pointer items-start gap-2 text-[14px]">
						<input
							type={many ? "checkbox" : "radio"}
							name={id}
							value={option.value}
							checked={chosen.has(option.value)}
							onChange={(event) => {
								if (!many) return onChange(option.value);
								const next = new Set(chosen);
								if (event.target.checked) next.add(option.value);
								else next.delete(option.value);
								onChange(
									formFieldOptions(field)
										.map(({ value }) => value)
										.filter((value) => next.has(value)),
								);
							}}
							className="mt-0.5 size-4 shrink-0 accent-primary"
						/>
						<span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
					</label>
				))}
				{problemText}
			</fieldset>
		);
	}

	const text = typeof draft === "string" ? draft : "";
	const input =
		classified.kind === "number" ? (
			<input
				{...control}
				type="number"
				inputMode={classified.field.type === "integer" ? "numeric" : "decimal"}
				step={classified.field.type === "integer" ? 1 : "any"}
				min={classified.field.minimum}
				max={classified.field.maximum}
				value={text}
				onChange={(event) => onChange(event.target.value)}
				className={INPUT}
			/>
		) : classified.field.format ? (
			<input
				{...control}
				type={INPUT_TYPES[classified.field.format]}
				value={text}
				onChange={(event) => onChange(event.target.value)}
				className={INPUT}
			/>
		) : (
			<Textarea
				{...control}
				rows={1}
				value={text}
				onChange={(event) => onChange(event.target.value)}
				className="min-h-0 rounded-xl px-3 py-[7px] text-[14px]"
			/>
		);
	// Counted as the form's check counts, in characters, not the UTF-16 units a native maxLength stops at.
	const maxLength = classified.kind === "text" ? classified.field.maxLength : undefined;
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<label htmlFor={id} className="font-medium text-[13px] text-soft-foreground">
				<FieldLabel label={label} required={required} />
			</label>
			{description}
			{input}
			<div className="flex items-start gap-2">
				<span className="min-w-0 flex-1">{problemText}</span>
				{maxLength !== undefined && (
					<span className="shrink-0 font-mono text-[11.5px] text-subtle-foreground">
						{[...text].length}/{maxLength}
					</span>
				)}
			</div>
		</div>
	);
}

function FieldLabel({ label, required }: { label: string; required: boolean }) {
	return (
		<>
			{label}
			{!required && (
				<>
					{" "}
					<span className="font-normal text-subtle-foreground">(optional)</span>
				</>
			)}
		</>
	);
}

const INPUT =
	"focus-ring h-9 w-full min-w-0 rounded-xl border border-transparent bg-list px-3 text-[14px] text-foreground transition-shadow focus-visible:border-primary-tint-border aria-invalid:border-destructive";

const INPUT_TYPES = {
	email: "email",
	uri: "url",
	date: "date",
	"date-time": "datetime-local",
} as const;

/** What became of the form: the answers and who gave them, a decline, or that the reply moved on unanswered. */
function SettledForm({
	form,
	agentName,
	announced,
}: {
	form: ToolCallForm;
	agentName: string;
	/** Whether this reader just answered it, which is announced. */
	announced: boolean;
}) {
	const { response } = form;
	if (!response) {
		return (
			<Outcome announced={false} icon={<X aria-hidden size={12} strokeWidth={2.8} />}>
				Nobody answered before the reply ended.
			</Outcome>
		);
	}
	const by = response.answeredByName && ` by ${response.answeredByName}`;
	if (response.answer.action === "decline") {
		return (
			<Outcome announced={announced} icon={<X aria-hidden size={12} strokeWidth={2.8} />}>
				Declined{by}. {agentName} will carry on without it.
			</Outcome>
		);
	}
	const { content } = response.answer;
	return (
		<div className="flex flex-col gap-2.5">
			<dl className="m-0 flex flex-col gap-2">
				{formFieldsInOrder(form.request, form.fieldOrder).map(([name, field]) => (
					<div key={name} className="flex min-w-0 flex-col gap-0.5">
						<dt className="font-medium text-[12px] text-muted-foreground">
							{field.title ?? wordsFromKey(name)}
						</dt>
						<dd className="m-0 whitespace-pre-wrap text-[14px] [overflow-wrap:anywhere]">
							{shownAnswer(field, content[name])}
						</dd>
					</div>
				))}
			</dl>
			<Outcome announced={announced} icon={<Check aria-hidden size={12} strokeWidth={2.8} />}>
				Answered{by}
			</Outcome>
		</div>
	);
}

/** An answer as people read it: options by their titles, yes or no, and a dash for none. */
function shownAnswer(field: FormField, value: FormFieldValue | undefined): string {
	if (value === undefined) return "—";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	const options = formFieldOptions(field);
	const labelOf = (chosen: string) =>
		options.find((option) => option.value === chosen)?.label ?? chosen;
	if (Array.isArray(value)) return value.map(labelOf).join(", ");
	if (typeof value !== "string") return String(value);
	const classified = classifyFormField(field);
	if (classified.kind === "text" && classified.field.format === "date-time") {
		const at = new Date(value);
		if (!Number.isNaN(at.getTime())) return at.toLocaleString();
	}
	return labelOf(value);
}
