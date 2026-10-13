import {
	MIN_WEBHOOK_SECRET_CHARACTERS,
	WEBHOOK_SECRET_PREFIXES,
	WEBHOOK_SOURCES,
	type WebhookAuth,
	type WebhookAuthKind,
	type WebhookHmacAlgorithm,
	type WebhookSignatureEncoding,
	type WebhookSource,
	webhookSecretLongEnough,
} from "@sugabots/contracts";
import { ChevronDown, Eye, EyeOff, Webhook } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useRoutineActions, useRoutineSecret } from "@/lib/routines.ts";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsControlRow, SettingsFieldLabel, SettingsGroup } from "@/ui/settings-page.tsx";
import type { PlacedRoutine } from "./RoutineEditor.tsx";

/*
 * How a webhook routine checks who calls it: the sender it comes from, which
 * for a known source needs only that sender's signing secret, or, for any
 * other sender, the auth it asks for and what that needs; then its secret.
 */

/** What a webhook starts with until somebody chooses: a signature, which most senders make. */
export const DEFAULT_WEBHOOK_AUTH: WebhookAuth = {
	kind: "hmac",
	header: "X-Signature",
	algorithm: "sha256",
	encoding: "hex",
};

type GenericKind = Exclude<WebhookAuthKind, WebhookSource>;

/** What each generic kind asks for when it is chosen. */
const AUTH_DEFAULTS: Record<GenericKind, WebhookAuth> = {
	hmac: DEFAULT_WEBHOOK_AUTH,
	api_key: { kind: "api_key", header: "X-API-Key" },
	bearer: { kind: "bearer" },
	basic: { kind: "basic", username: "sugabots" },
};

const AUTH_OPTIONS = [
	{ value: "basic", label: "Basic" },
	{ value: "bearer", label: "Bearer" },
	{ value: "api_key", label: "API key" },
	{ value: "hmac", label: "HMAC" },
] as const satisfies readonly { value: GenericKind; label: string }[];

/** "generic" for any sender, else the source whose own way of signing is known. */
type SourceChoice = "generic" | WebhookSource;

const SOURCE_LABELS: Record<SourceChoice, string> = {
	generic: "Generic",
	github: "GitHub",
	stripe: "Stripe",
	slack: "Slack",
	linear: "Linear",
};

/** How each source's signing secret looks, as the placeholder for it. */
const SOURCE_SECRET_PLACEHOLDERS: Record<WebhookSource, string> = {
	github: "The secret set on the webhook in GitHub",
	stripe: "whsec_…",
	slack: "The app's Signing Secret",
	linear: "lin_wh_…",
};

const ALGORITHM_OPTIONS = [
	{ value: "sha1", label: "SHA-1" },
	{ value: "sha256", label: "SHA-256" },
	{ value: "sha512", label: "SHA-512" },
] as const satisfies readonly { value: WebhookHmacAlgorithm; label: string }[];

const ENCODING_OPTIONS = [
	{ value: "hex", label: "Hex" },
	{ value: "base64", label: "Base64" },
] as const satisfies readonly { value: WebhookSignatureEncoding; label: string }[];

/** What each generic kind calls its secret; every source calls it a signing secret. */
const SECRET_LABELS: Record<GenericKind, string> = {
	hmac: "Signing secret",
	api_key: "Key",
	bearer: "Token",
	basic: "Password",
};

function isSource(kind: WebhookAuthKind): kind is WebhookSource {
	return (WEBHOOK_SOURCES as readonly string[]).includes(kind);
}

function sourceOf(auth: WebhookAuth): SourceChoice {
	return isSource(auth.kind) ? auth.kind : "generic";
}

/** How the secret looks: a source's format, or the prefix of a kind's own secrets. */
function secretPlaceholder(auth: WebhookAuth): string | undefined {
	if (isSource(auth.kind)) return SOURCE_SECRET_PLACEHOLDERS[auth.kind];
	const prefix = WEBHOOK_SECRET_PREFIXES[auth.kind];
	return prefix === "" ? undefined : `${prefix}…`;
}

function secretLabel(auth: WebhookAuth): string {
	return isSource(auth.kind) ? "Signing secret" : SECRET_LABELS[auth.kind];
}

/** A webhook routine being made: how it will check callers, and its secret. */
export interface WebhookDraft {
	auth: WebhookAuth;
	/** Blank for none, so the address alone runs it. */
	secret: string;
}

export const NEW_WEBHOOK: WebhookDraft = { auth: DEFAULT_WEBHOOK_AUTH, secret: "" };

/**
 * Whether a secret can be saved for `auth`: a source's, however long its
 * sender made it; one made up for a generic webhook, long enough to be hard
 * to guess; or none, left empty.
 */
export function secretReady(auth: WebhookAuth, secret: string): boolean {
	const trimmed = secret.trim();
	return trimmed === "" || webhookSecretLongEnough(auth.kind, trimmed);
}

/** Why a secret made up for a generic webhook cannot be saved yet. */
export const SECRET_TOO_SHORT_NOTE = `A secret needs at least ${MIN_WEBHOOK_SECRET_CHARACTERS} characters.`;

/** What the note under a webhook says for a routine without a secret. */
export const NO_SECRET_NOTE =
	"With no secret, anyone who has the address can run it. Add one so only the sender can.";

/** What a caller must do to be let in, for the note under the webhook's rows. */
export function authNote(auth: WebhookAuth): string {
	switch (auth.kind) {
		case "github":
			return "Add the address as a webhook in GitHub, with the content type application/json, and give it the same secret.";
		case "stripe":
			return "Add the address as an endpoint in Stripe, and paste its signing secret.";
		case "slack":
			return "Set the address as your Slack app's Request URL, and paste its Signing Secret.";
		case "linear":
			return "Add the address as a webhook in Linear, and paste its signing secret.";
		case "hmac":
			return `Sign the raw request body with the secret using HMAC ${labelOf(ALGORITHM_OPTIONS, auth.algorithm)}, and send the digest in ${auth.header}, written in ${labelOf(ENCODING_OPTIONS, auth.encoding).toLowerCase()}.`;
		case "api_key":
			return `Send the key in the ${auth.header} header.`;
		case "bearer":
			return "Send the token in the Authorization header as Bearer.";
		case "basic":
			return "Send the username and password with HTTP Basic auth.";
	}
}

/**
 * The webhook groups of a routine being made: where it comes from, then its
 * auth and secret, under `note`.
 */
export function NewWebhookGroups({
	draft,
	note,
	onChange,
}: {
	draft: WebhookDraft;
	note: ReactNode;
	onChange: (draft: WebhookDraft) => void;
}) {
	const changeAuth = (auth: WebhookAuth) => onChange({ ...draft, auth });
	return (
		<>
			<SettingsGroup>
				<SettingsControlRow label="Address">
					<span className="text-[14.5px] text-muted-foreground">Made when you create it</span>
				</SettingsControlRow>
				<SourceRow auth={draft.auth} onChange={changeAuth} />
			</SettingsGroup>
			<SettingsGroup note={note}>
				<AuthRows auth={draft.auth} onChange={changeAuth} />
				<SecretField
					auth={draft.auth}
					value={draft.secret}
					onChange={(secret) => onChange({ ...draft, secret })}
				/>
			</SettingsGroup>
		</>
	);
}

/**
 * An existing webhook routine's groups: its address and where it comes from,
 * then its auth, which saves as it changes, and its secret, under a note of
 * what a caller must send, or, while it has no secret, that nothing is asked
 * of them.
 */
export function WebhookGroups({
	placed,
	auth,
	onChangeAuth,
}: {
	placed: PlacedRoutine;
	auth: WebhookAuth;
	onChangeAuth: (auth: WebhookAuth) => void;
}) {
	const { routine, agent, pod } = placed;
	const canManage = pod.permissions.manageRoutines;
	const saved = useRoutineSecret({ agentId: agent.id, routineId: routine.id, canManage }).data;
	const address = webhookAddress(placed.routine.id);
	return (
		<>
			<SettingsGroup>
				<SettingsControlRow label="Address">
					<code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
						{address}
					</code>
					<CopyIconButton label="Copy address" text={address} size="lg" />
				</SettingsControlRow>
				<SourceRow auth={auth} onChange={onChangeAuth} />
			</SettingsGroup>
			{canManage && saved ? (
				// Keyed by whether it has a secret, so what was typed clears once that changes.
				<SecretGroup
					key={saved.kind}
					placed={placed}
					auth={auth}
					onChangeAuth={onChangeAuth}
					hasSecret={saved.kind !== "none"}
				/>
			) : (
				<SettingsGroup note={authNote(auth)}>
					<AuthRows auth={auth} onChange={onChangeAuth} />
					<SettingsControlRow label={secretLabel(auth)}>
						{!canManage && (
							<span className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground">
								Set by people who manage routines
							</span>
						)}
					</SettingsControlRow>
				</SettingsGroup>
			)}
		</>
	);
}

function webhookAddress(routineId: string): string {
	return `${apiBaseUrl}/hooks/routines/${routineId}`;
}

/** For a generic webhook, the auth to ask callers for and what it needs. */
function AuthRows({
	auth,
	onChange,
}: {
	auth: WebhookAuth;
	onChange: (auth: WebhookAuth) => void;
}) {
	return (
		<>
			{!isSource(auth.kind) && (
				<MenuRow
					label="Auth"
					options={AUTH_OPTIONS}
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
					<MenuRow
						label="Algorithm"
						options={ALGORITHM_OPTIONS}
						value={auth.algorithm}
						onChange={(algorithm) => onChange({ ...auth, algorithm })}
					/>
					<MenuRow
						label="Encoding"
						options={ENCODING_OPTIONS}
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
		</>
	);
}

const SOURCE_OPTIONS = (Object.keys(SOURCE_LABELS) as SourceChoice[]).map((source) => ({
	value: source,
	label: SOURCE_LABELS[source],
}));

/** Where the webhook comes from: a known source, each with its logo, or Generic for any other sender. */
function SourceRow({
	auth,
	onChange,
}: {
	auth: WebhookAuth;
	onChange: (auth: WebhookAuth) => void;
}) {
	return (
		<MenuRow
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

/**
 * A row whose value is picked from a menu that opens under its arrow, which
 * turns while the menu is open. `mark` draws an icon beside each option.
 */
function MenuRow<Value extends string>({
	label,
	options,
	value,
	mark,
	onChange,
}: {
	label: string;
	options: readonly { value: Value; label: string }[];
	value: Value;
	mark?: (value: Value) => ReactNode;
	onChange: (value: Value) => void;
}) {
	const current = options.find((option) => option.value === value);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`${label}: ${current?.label ?? value}`}
				className="group focus-ring flex min-h-[46px] w-full cursor-pointer items-center gap-3 border-border border-b px-4 py-2.5 text-left text-[14.5px] text-foreground transition-colors last:border-b-0 hover:bg-panel"
			>
				<SettingsFieldLabel>{label}</SettingsFieldLabel>
				<span className="flex min-w-0 flex-1 items-center gap-2.5">
					{mark?.(value)}
					<span className="min-w-0 flex-1 truncate">{current?.label ?? value}</span>
				</span>
				<ChevronDown
					aria-hidden
					size={15}
					strokeWidth={2.4}
					className="shrink-0 text-subtle-foreground transition-transform group-data-popup-open:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-56">
				{options.map((option) => (
					<DropdownMenuItem key={option.value} onClick={() => onChange(option.value)}>
						{mark?.(option.value)}
						{option.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A source's logo, or a webhook's for Generic. */
function SourceMark({ source }: { source: SourceChoice }) {
	if (source !== "generic") {
		return <ConnectionMark presetId={source} name={SOURCE_LABELS[source]} size="md" />;
	}
	return (
		<span
			aria-hidden
			className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-chip text-soft-foreground"
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
 * it or press Enter. Escape, or leaving it blank or unchanged, puts it back.
 * Keyed by its value where it is used, so a value changed elsewhere replaces
 * what was typed.
 */
function CommittedFieldRow({
	label,
	value,
	placeholder,
	onCommit,
}: {
	label: string;
	value: string;
	placeholder: string;
	onCommit: (value: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	const id = useId();

	function commit() {
		const next = draft.trim();
		if (next === "" || next === value) {
			setDraft(value);
			return;
		}
		setDraft(next);
		onCommit(next);
	}

	return (
		<SettingsControlRow label={label} htmlFor={id}>
			<input
				id={id}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") setDraft(value);
				}}
				autoComplete="off"
				spellCheck={false}
				placeholder={placeholder}
				className="-mx-1 -my-1 min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
			/>
		</SettingsControlRow>
	);
}

/**
 * An existing routine's auth and secret, for someone who manages routines,
 * with Remove and Save under them. The secret's field starts blank whether or
 * not one is saved, so a saved one is never shown; Save replaces it with what
 * is typed, and Remove clears it, so the address alone runs the routine.
 */
function SecretGroup({
	placed,
	auth,
	onChangeAuth,
	hasSecret,
}: {
	placed: PlacedRoutine;
	auth: WebhookAuth;
	onChangeAuth: (auth: WebhookAuth) => void;
	hasSecret: boolean;
}) {
	const actions = useRoutineActions();
	const [draft, setDraft] = useState("");
	const next = draft.trim();
	const savable = next !== "" && secretReady(auth, next) && !actions.rotateSecret.isPending;
	const replace = (secret: string | null) =>
		actions.rotateSecret.mutate(
			{ agentId: placed.agent.id, routineId: placed.routine.id, secret },
			{ onSuccess: () => setDraft("") },
		);
	const save = () => {
		if (savable) replace(next);
	};
	return (
		<>
			<SettingsGroup note={hasSecret ? authNote(auth) : NO_SECRET_NOTE}>
				<AuthRows auth={auth} onChange={onChangeAuth} />
				<SecretField
					auth={auth}
					value={draft}
					onChange={setDraft}
					onEnter={save}
					error={
						actions.rotateSecret.error
							? failureMessage(actions.rotateSecret.error)
							: secretReady(auth, next)
								? undefined
								: SECRET_TOO_SHORT_NOTE
					}
				/>
			</SettingsGroup>
			<div className="flex justify-end gap-2">
				{hasSecret && (
					<Button
						variant="secondary"
						disabled={actions.rotateSecret.isPending}
						onClick={() => replace(null)}
					>
						Remove
					</Button>
				)}
				<Button disabled={!savable} onClick={save}>
					{actions.rotateSecret.isPending ? "Saving…" : "Save"}
				</Button>
			</div>
		</>
	);
}

/**
 * A secret as a field, typed or pasted in, such as the signing secret a
 * sender made. It shows hidden until Show.
 */
function SecretField({
	auth,
	value,
	onChange,
	onEnter,
	error,
}: {
	auth: WebhookAuth;
	value: string;
	onChange: (value: string) => void;
	onEnter?: () => void;
	error?: string;
}) {
	const id = useId();
	const [shown, setShown] = useState(false);
	const label = secretLabel(auth);
	return (
		<div className="flex flex-col gap-2 border-border border-b px-4 py-2.5 last:border-b-0">
			<div className="flex min-h-[26px] items-center gap-3">
				<SettingsFieldLabel htmlFor={id}>{label}</SettingsFieldLabel>
				<input
					id={id}
					type={shown ? "text" : "password"}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") onEnter?.();
					}}
					autoComplete="off"
					spellCheck={false}
					placeholder={secretPlaceholder(auth)}
					className="-mx-1 -my-1 min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 font-mono text-[13px] text-foreground outline-none placeholder:font-sans placeholder:text-[14.5px] placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
				/>
				{value !== "" && (
					<IconButton label={shown ? "Hide" : "Show"} size="lg" onClick={() => setShown(!shown)}>
						{shown ? <EyeOff /> : <Eye />}
					</IconButton>
				)}
			</div>
			{error && (
				<span role="alert" className="text-destructive-text text-sm">
					{error}
				</span>
			)}
		</div>
	);
}
