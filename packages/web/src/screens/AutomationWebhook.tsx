import {
	DEFAULT_DELIVERY_ID_HEADER,
	MIN_WEBHOOK_SECRET_CHARACTERS,
	WEBHOOK_SECRET_PREFIXES,
	WEBHOOK_SOURCES,
	type WebhookAuth,
	type WebhookAuthKind,
	type WebhookFilterTest,
	type WebhookSource,
	webhookSecretLongEnough,
} from "@sugabots/contracts";
import { Eye, EyeOff, Webhook } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { client } from "@/api.ts";
import {
	WEBHOOK_ALGORITHM_OPTIONS,
	WEBHOOK_AUTH_OPTIONS,
	WEBHOOK_ENCODING_OPTIONS,
	WEBHOOK_SECRET_LABELS,
	WEBHOOK_SOURCE_LABELS,
	WEBHOOK_SOURCE_NOTES,
	WEBHOOK_SOURCE_SECRET_PLACEHOLDERS,
	type WebhookGenericKind,
	type WebhookSourceChoice,
} from "@/lib/automation-trigger-words.ts";
import {
	type TriggerAddress,
	useAutomationActions,
	useAutomationSecret,
} from "@/lib/automations.ts";
import { failureMessage } from "@/lib/failure.ts";
import { resourcePermissions } from "@/lib/resource-owner.tsx";
import { ConnectorMark } from "@/ui/connector-mark.tsx";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import {
	SettingsControlRow,
	SettingsFieldLabel,
	SettingsGroup,
	SettingsMenuRow,
} from "@/ui/settings-page.tsx";
import { useCommittedDraft } from "@/ui/use-committed-draft.ts";
import type { PlacedAutomation } from "./AutomationEditor.tsx";
import { FilterGroup } from "./AutomationWebhookFilter.tsx";

/*
 * How a webhook automation checks who calls it: the webhook source it comes from, which
 * needs only that source's signing secret, or, for any
 * other caller, the auth it asks for and what that needs; then its secret.
 */

/** What a webhook starts with until somebody chooses: a signature, which most callers make. */
const DEFAULT_WEBHOOK_AUTH: WebhookAuth = {
	kind: "hmac",
	header: "X-Signature",
	algorithm: "sha256",
	encoding: "hex",
};

/** What each generic kind asks for when it is chosen. */
const AUTH_DEFAULTS: Record<WebhookGenericKind, WebhookAuth> = {
	hmac: DEFAULT_WEBHOOK_AUTH,
	api_key: { kind: "api_key", header: "X-API-Key" },
	bearer: { kind: "bearer" },
	basic: { kind: "basic", username: "sugabots" },
};

function isSource(kind: WebhookAuthKind): kind is WebhookSource {
	return (WEBHOOK_SOURCES as readonly string[]).includes(kind);
}

function sourceOf(auth: WebhookAuth): WebhookSourceChoice {
	return isSource(auth.kind) ? auth.kind : "generic";
}

/** How the secret looks: a source's format, or the prefix of a kind's own secrets. */
function secretPlaceholder(auth: WebhookAuth): string | undefined {
	if (isSource(auth.kind)) return WEBHOOK_SOURCE_SECRET_PLACEHOLDERS[auth.kind];
	const prefix = WEBHOOK_SECRET_PREFIXES[auth.kind];
	return prefix === "" ? undefined : `${prefix}…`;
}

function secretLabel(auth: WebhookAuth): string {
	return isSource(auth.kind) ? "Signing secret" : WEBHOOK_SECRET_LABELS[auth.kind];
}

/** A webhook automation being made: how it will check callers, and its secret. */
export interface WebhookDraft {
	auth: WebhookAuth;
	/** Where a generic webhook's delivery id is, or null for none. */
	deliveryIdHeader: string | null;
	/** Blank for none, so the address alone runs it. */
	secret: string;
	/** What a call must meet to run it; none runs every call. */
	filter: readonly WebhookFilterTest[];
}

export const NEW_WEBHOOK: WebhookDraft = {
	auth: DEFAULT_WEBHOOK_AUTH,
	deliveryIdHeader: DEFAULT_DELIVERY_ID_HEADER,
	secret: "",
	filter: [],
};

/**
 * Whether a secret can be saved for `auth`: a source's, however long the
 * source made it; one made up for a generic webhook, long enough to be hard
 * to guess; or none, left empty.
 */
export function secretReady(auth: WebhookAuth, secret: string): boolean {
	const trimmed = secret.trim();
	return trimmed === "" || webhookSecretLongEnough(auth.kind, trimmed);
}

/** Why a secret made up for a generic webhook cannot be saved yet. */
export const SECRET_TOO_SHORT_NOTE = `A secret needs at least ${MIN_WEBHOOK_SECRET_CHARACTERS} characters.`;

/** What the note under a webhook says for an automation without a secret. */
export const NO_SECRET_NOTE =
	"With no secret, anyone who has the address can run it. Add one so only the caller you expect can.";

/** What a caller must do to be let in, for the note under the webhook's rows. */
export function authNote(auth: WebhookAuth): string {
	switch (auth.kind) {
		case "github":
		case "stripe":
		case "slack":
		case "linear":
			return WEBHOOK_SOURCE_NOTES[auth.kind];
		case "hmac":
			return `Sign the raw request body with the secret using HMAC ${labelOf(WEBHOOK_ALGORITHM_OPTIONS, auth.algorithm)}, and send the digest in ${auth.header}, written in ${labelOf(WEBHOOK_ENCODING_OPTIONS, auth.encoding).toLowerCase()}. Keep signed requests private. A captured request can be sent again.`;
		case "api_key":
			return `Send the key in the ${auth.header} header.`;
		case "bearer":
			return "Send the token in the Authorization header as Bearer.";
		case "basic":
			return "Send the username and password with HTTP Basic auth.";
	}
}

/**
 * The webhook groups of an automation being made: where it comes from, then its
 * auth and secret, under `note`.
 */
export function NewWebhookGroups({
	draft,
	note,
	onChange,
	onFilterEditingChange,
}: {
	draft: WebhookDraft;
	note: ReactNode;
	onChange: (draft: WebhookDraft) => void;
	onFilterEditingChange: (editing: boolean) => void;
}) {
	const changeAuth = (auth: WebhookAuth) => onChange({ ...draft, auth });
	return (
		<>
			<SettingsGroup>
				<SettingsControlRow label="Address">
					<span className="text-sm text-muted-foreground">Made when you create it</span>
				</SettingsControlRow>
				<SourceRow auth={draft.auth} onChange={changeAuth} />
			</SettingsGroup>
			<SettingsGroup note={note}>
				<AuthRows
					auth={draft.auth}
					onChange={changeAuth}
					deliveryIdHeader={draft.deliveryIdHeader}
					onChangeDeliveryIdHeader={(deliveryIdHeader) => onChange({ ...draft, deliveryIdHeader })}
				/>
				<SecretField
					auth={draft.auth}
					field={{
						value: draft.secret,
						onChange: (event) => onChange({ ...draft, secret: event.currentTarget.value }),
					}}
				/>
			</SettingsGroup>
			<FilterGroup
				filter={draft.filter}
				onEditingChange={onFilterEditingChange}
				onChange={async (filter) => onChange({ ...draft, filter })}
			/>
		</>
	);
}

/**
 * An existing webhook trigger's groups: its address and where it comes from,
 * then its auth and delivery id header, which save as they change, and its secret, under a note of
 * what a caller must send, or, while it has no secret, that nothing is asked
 * of them, and its filter, whose tests are saved explicitly.
 */
export function WebhookGroups({
	placed,
	triggerId,
	auth,
	filter,
	onChangeAuth,
	deliveryIdHeader,
	onChangeDeliveryIdHeader,
	onChangeFilter,
}: {
	placed: PlacedAutomation;
	triggerId: string;
	auth: WebhookAuth;
	filter: readonly WebhookFilterTest[];
	onChangeAuth: (auth: WebhookAuth) => void;
	deliveryIdHeader: string | null;
	onChangeDeliveryIdHeader: (deliveryIdHeader: string | null) => void;
	onChangeFilter: (filter: WebhookFilterTest[]) => Promise<unknown>;
}) {
	const { automation, owner } = placed;
	const canManage = resourcePermissions(owner).manageAutomations;
	const address = { projectId: automation.projectId, automationId: automation.id, triggerId };
	const saved = useAutomationSecret({ ...address, canManage }).data;
	const url = webhookAddress(triggerId);
	return (
		<>
			<SettingsGroup>
				<SettingsControlRow label="Address">
					<code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{url}</code>
					<CopyIconButton label="Copy address" text={url} size="lg" />
				</SettingsControlRow>
				<SourceRow auth={auth} onChange={onChangeAuth} />
			</SettingsGroup>
			{canManage && saved ? (
				// Keyed by the saved secret, so the field starts again from a newly saved one.
				<SecretGroup
					key={saved.kind === "set" ? saved.secret : saved.kind}
					address={address}
					auth={auth}
					onChangeAuth={onChangeAuth}
					deliveryIdHeader={deliveryIdHeader}
					onChangeDeliveryIdHeader={onChangeDeliveryIdHeader}
					savedSecret={saved.kind === "set" ? saved.secret : ""}
				/>
			) : (
				<SettingsGroup note={authNote(auth)}>
					<AuthRows
						auth={auth}
						onChange={onChangeAuth}
						deliveryIdHeader={deliveryIdHeader}
						onChangeDeliveryIdHeader={onChangeDeliveryIdHeader}
					/>
					<SettingsControlRow label={secretLabel(auth)}>
						{!canManage && (
							<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
								Set by members who manage automations
							</span>
						)}
					</SettingsControlRow>
				</SettingsGroup>
			)}
			<FilterGroup filter={filter} onChange={onChangeFilter} />
		</>
	);
}

function webhookAddress(triggerId: string): string {
	return client.urls.webhooks.trigger({ params: { triggerId } });
}

/**
 * For a generic webhook, the auth to ask callers for and what it needs, then
 * the header that names each delivery, which a known source needs no say in.
 */
function AuthRows({
	auth,
	onChange,
	deliveryIdHeader,
	onChangeDeliveryIdHeader,
}: {
	auth: WebhookAuth;
	onChange: (auth: WebhookAuth) => void;
	deliveryIdHeader: string | null;
	onChangeDeliveryIdHeader: (deliveryIdHeader: string | null) => void;
}) {
	return (
		<>
			{!isSource(auth.kind) && (
				<SettingsMenuRow
					label="Auth"
					options={WEBHOOK_AUTH_OPTIONS}
					value={auth.kind}
					onChange={(kind) => onChange(AUTH_DEFAULTS[kind])}
				/>
			)}
			{(auth.kind === "hmac" || auth.kind === "api_key") && (
				<CommittedFieldRow
					key={auth.header}
					label="Header"
					value={auth.header}
					placeholder={auth.kind === "hmac" ? "X-Signature" : "X-API-Key"}
					onCommit={(header) => onChange({ ...auth, header })}
				/>
			)}
			{auth.kind === "hmac" && (
				<>
					<SettingsMenuRow
						label="Algorithm"
						options={WEBHOOK_ALGORITHM_OPTIONS}
						value={auth.algorithm}
						onChange={(algorithm) => onChange({ ...auth, algorithm })}
					/>
					<SettingsMenuRow
						label="Encoding"
						options={WEBHOOK_ENCODING_OPTIONS}
						value={auth.encoding}
						onChange={(encoding) => onChange({ ...auth, encoding })}
					/>
				</>
			)}
			{auth.kind === "basic" && (
				<CommittedFieldRow
					key={auth.username}
					label="Username"
					value={auth.username}
					placeholder="sugabots"
					onCommit={(username) => onChange({ ...auth, username })}
				/>
			)}
			{!isSource(auth.kind) && (
				<CommittedFieldRow
					key={deliveryIdHeader}
					label="Delivery ID header"
					value={deliveryIdHeader ?? ""}
					placeholder="None: every call runs"
					allowEmpty
					onCommit={(header) => onChangeDeliveryIdHeader(header === "" ? null : header)}
				/>
			)}
		</>
	);
}

const SOURCE_OPTIONS = (Object.keys(WEBHOOK_SOURCE_LABELS) as WebhookSourceChoice[]).map(
	(source) => ({
		value: source,
		label: WEBHOOK_SOURCE_LABELS[source],
	}),
);

/** Where the webhook comes from: a known source, each with its logo, or Generic for any other caller. */
function SourceRow({
	auth,
	onChange,
}: {
	auth: WebhookAuth;
	onChange: (auth: WebhookAuth) => void;
}) {
	return (
		<SettingsMenuRow
			label="Source"
			options={SOURCE_OPTIONS}
			value={sourceOf(auth)}
			mark={(source) => <SourceMark source={source} />}
			onChange={(source) =>
				onChange(source === "generic" ? DEFAULT_WEBHOOK_AUTH : { kind: source })
			}
		/>
	);
}

/** A source's logo, or a webhook's for Generic. */
function SourceMark({ source }: { source: WebhookSourceChoice }) {
	if (source !== "generic") {
		return <ConnectorMark markId={source} name={WEBHOOK_SOURCE_LABELS[source]} size="md" />;
	}
	return (
		<span
			aria-hidden
			className="grid size-6 shrink-0 place-items-center rounded-sm bg-chip text-soft-foreground"
		>
			<Webhook size={14} strokeWidth={2.2} />
		</span>
	);
}

function labelOf<Value extends string>(
	options: readonly { value: Value; label: string }[],
	value: Value,
): string {
	return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * A short field, such as a header's name, that commits trimmed when you leave
 * it or press Enter. Escape, or leaving it unchanged, puts it back, as does
 * leaving it blank unless `allowEmpty`.
 * Keyed by its value where it is used, so a value changed elsewhere replaces
 * what was typed.
 */
function CommittedFieldRow({
	label,
	value,
	placeholder,
	allowEmpty = false,
	onCommit,
}: {
	label: string;
	value: string;
	placeholder: string;
	allowEmpty?: boolean;
	onCommit: (value: string) => void;
}) {
	const { fieldProps } = useCommittedDraft(value, onCommit, { allowEmpty });
	const id = useId();
	return (
		<SettingsControlRow label={label} htmlFor={id}>
			<input
				id={id}
				{...fieldProps}
				autoComplete="off"
				spellCheck={false}
				placeholder={placeholder}
				className="focus-ring -mx-1 -my-1 min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground"
			/>
		</SettingsControlRow>
	);
}

/**
 * An existing automation's auth and secret, for someone who manages automations.
 * The secret's field starts with the saved secret, hidden until Show, or blank
 * when there is none. What is typed saves when the field is left or Enter is pressed, and
 * Escape puts the saved one back. Leaving it blank removes a shown secret, so
 * the address alone runs the automation.
 */
function SecretGroup({
	address,
	auth,
	onChangeAuth,
	deliveryIdHeader,
	onChangeDeliveryIdHeader,
	savedSecret,
}: {
	address: TriggerAddress;
	auth: WebhookAuth;
	onChangeAuth: (auth: WebhookAuth) => void;
	deliveryIdHeader: string | null;
	onChangeDeliveryIdHeader: (deliveryIdHeader: string | null) => void;
	/** Blank when the automation has none. */
	savedSecret: string;
}) {
	const actions = useAutomationActions();
	const { draft, fieldProps } = useCommittedDraft(
		savedSecret,
		(secret) => {
			// One too short stays in the field, with the note saying why, until it is long enough.
			if (!secretReady(auth, secret)) return;
			actions.rotateSecret.mutate({ ...address, secret: secret === "" ? null : secret });
		},
		{ allowEmpty: true },
	);

	return (
		<SettingsGroup note={savedSecret !== "" ? authNote(auth) : NO_SECRET_NOTE}>
			<AuthRows
				auth={auth}
				onChange={onChangeAuth}
				deliveryIdHeader={deliveryIdHeader}
				onChangeDeliveryIdHeader={onChangeDeliveryIdHeader}
			/>
			<SecretField
				auth={auth}
				field={fieldProps}
				error={
					actions.rotateSecret.error
						? failureMessage(actions.rotateSecret.error)
						: secretReady(auth, draft)
							? undefined
							: SECRET_TOO_SHORT_NOTE
				}
			/>
		</SettingsGroup>
	);
}

/**
 * A secret as a field, typed or pasted in, such as the signing secret a
 * webhook source made. It shows hidden until Show, and can be copied. `field` is
 * spread onto the input: its value and how it changes, and for a saved
 * secret, `useCommittedDraft`'s saving when it is left.
 */
function SecretField({
	auth,
	field,
	error,
}: {
	auth: WebhookAuth;
	field: {
		value: string;
		onChange: (event: ChangeEvent<HTMLInputElement>) => void;
		onBlur?: () => void;
		onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
	};
	error?: string;
}) {
	const id = useId();
	const [shown, setShown] = useState(false);
	const label = secretLabel(auth);
	return (
		<div className="flex flex-col gap-2 border-border border-b px-4 py-2.5 last:border-b-0">
			<div className="flex min-h-7 items-center gap-3">
				<SettingsFieldLabel htmlFor={id}>{label}</SettingsFieldLabel>
				<input
					id={id}
					type={shown ? "text" : "password"}
					{...field}
					autoComplete="off"
					spellCheck={false}
					placeholder={secretPlaceholder(auth)}
					className="focus-ring -mx-1 -my-1 min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 font-mono text-xs text-foreground placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground"
				/>
				{field.value !== "" && (
					<>
						<IconButton label={shown ? "Hide" : "Show"} size="lg" onClick={() => setShown(!shown)}>
							{shown ? <EyeOff /> : <Eye />}
						</IconButton>
						<CopyIconButton
							label={`Copy ${label.toLowerCase()}`}
							text={field.value.trim()}
							size="lg"
						/>
					</>
				)}
			</div>
			{error && (
				<span role="alert" className="text-destructive-text text-xs">
					{error}
				</span>
			)}
		</div>
	);
}
