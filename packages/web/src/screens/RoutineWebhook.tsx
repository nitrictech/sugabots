import {
	MIN_WEBHOOK_SECRET_CHARACTERS,
	type WebhookAuth,
	type WebhookAuthKind,
	type WebhookHmacAlgorithm,
} from "@sugabots/contracts";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useRoutineActions, useShownSecret } from "@/lib/routines.ts";
import { Button } from "@/ui/button.tsx";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsChoiceRow, SettingsControlRow, SettingsFieldLabel } from "@/ui/settings-page.tsx";
import type { PlacedRoutine } from "./RoutineEditor.tsx";

/*
 * How a webhook routine checks who calls it: the auth it asks for, with what
 * each needs, its secret, and a request that would run it. The API returns a
 * secret only when it makes one, so a secret shows only in the tab that made
 * it or brought it.
 */

/** What a webhook starts with until somebody chooses: a signature, which most senders make. */
export const DEFAULT_WEBHOOK_AUTH: WebhookAuth = {
	kind: "hmac",
	format: "body",
	header: "X-Signature",
	algorithm: "sha256",
};

/** What each kind asks for when it is chosen. */
const AUTH_DEFAULTS: Record<WebhookAuthKind, WebhookAuth> = {
	hmac: DEFAULT_WEBHOOK_AUTH,
	api_key: { kind: "api_key", header: "X-API-Key" },
	bearer: { kind: "bearer" },
	basic: { kind: "basic", username: "sugabots" },
};

const AUTH_OPTIONS = [
	{ value: "hmac", label: "HMAC" },
	{ value: "api_key", label: "API key" },
	{ value: "bearer", label: "Bearer" },
	{ value: "basic", label: "Basic" },
] as const;

const FORMAT_OPTIONS = [
	{ value: "body", label: "Plain body" },
	{ value: "slack", label: "Slack" },
	{ value: "stripe", label: "Stripe" },
] as const;

type HmacFormat = (typeof FORMAT_OPTIONS)[number]["value"];

const ALGORITHM_OPTIONS = [
	{ value: "sha256", label: "SHA-256" },
	{ value: "sha512", label: "SHA-512" },
] as const satisfies readonly { value: WebhookHmacAlgorithm; label: string }[];

/** What each kind calls its secret. */
const SECRET_LABELS: Record<WebhookAuthKind, string> = {
	hmac: "Secret",
	api_key: "Key",
	bearer: "Token",
	basic: "Password",
};

/** How much of a secret stays readable while it is hidden: enough to tell two apart. */
const SECRET_SHOWN_PREFIX = 6;

/** A webhook routine being made: how it will check callers, and a secret its sender made, if one is pasted. */
export interface WebhookDraft {
	auth: WebhookAuth;
	/** Blank to have one made. */
	secret: string;
}

export const NEW_WEBHOOK: WebhookDraft = { auth: DEFAULT_WEBHOOK_AUTH, secret: "" };

/** Whether a pasted secret is long enough to be accepted; a blank one is made instead. */
export function pastedSecretReady(secret: string): boolean {
	const trimmed = secret.trim();
	return trimmed === "" || trimmed.length >= MIN_WEBHOOK_SECRET_CHARACTERS;
}

/** What a caller must do to be let in, for the note under the webhook's rows. */
export function authNote(auth: WebhookAuth): string {
	switch (auth.kind) {
		case "hmac":
			if (auth.format === "slack") {
				return "Set the address as your Slack app's Request URL, and paste its Signing Secret here.";
			}
			if (auth.format === "stripe") {
				return "Add the address as an endpoint in Stripe, and paste its signing secret here.";
			}
			return `Sign the raw request body with the secret using HMAC ${algorithmLabel(auth.algorithm)} and send the hex digest in ${auth.header}.`;
		case "api_key":
			return `Send the key in the ${auth.header} header.`;
		case "bearer":
			return "Send the token in the Authorization header as Bearer.";
		case "basic":
			return "Send the username and password with HTTP Basic auth.";
	}
}

/** The webhook rows of a routine being made: its auth, and a place to paste a sender's secret. */
export function NewWebhookRows({
	draft,
	onChange,
}: {
	draft: WebhookDraft;
	onChange: (draft: WebhookDraft) => void;
}) {
	const id = useId();
	return (
		<>
			<SettingsControlRow label="Address">
				<span className="text-[14.5px] text-muted-foreground">Made when you create it</span>
			</SettingsControlRow>
			<AuthRows auth={draft.auth} onChange={(auth) => onChange({ ...draft, auth })} />
			<SettingsControlRow label={SECRET_LABELS[draft.auth.kind]} htmlFor={id}>
				{draft.auth.kind === "hmac" ? (
					<input
						id={id}
						value={draft.secret}
						onChange={(event) => onChange({ ...draft, secret: event.target.value })}
						autoComplete="off"
						spellCheck={false}
						placeholder="Made for you, or paste the sender's"
						className="min-w-0 flex-1 rounded-md bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:font-sans placeholder:text-[14.5px] placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
					/>
				) : (
					<span className="text-[14.5px] text-muted-foreground">Made when you create it</span>
				)}
			</SettingsControlRow>
		</>
	);
}

/**
 * An existing webhook routine's rows: its address, its auth, which saves as it
 * changes, its secret, and an example request.
 */
export function WebhookRows({
	placed,
	auth,
	onChangeAuth,
}: {
	placed: PlacedRoutine;
	auth: WebhookAuth;
	onChangeAuth: (auth: WebhookAuth) => void;
}) {
	const address = webhookAddress(placed.routine.id);
	return (
		<>
			<SettingsControlRow label="Address">
				<code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
					{address}
				</code>
				<CopyIconButton label="Copy address" text={address} size="lg" />
			</SettingsControlRow>
			<AuthRows auth={auth} onChange={onChangeAuth} />
			<SecretRow placed={placed} auth={auth} />
			<ExampleRequest address={address} auth={auth} />
		</>
	);
}

function webhookAddress(routineId: string): string {
	return `${apiBaseUrl}/hooks/routines/${routineId}`;
}

function algorithmLabel(algorithm: WebhookHmacAlgorithm): string {
	return algorithm === "sha256" ? "SHA-256" : "SHA-512";
}

/** The auth to ask callers for, and what the chosen one needs. */
function AuthRows({
	auth,
	onChange,
}: {
	auth: WebhookAuth;
	onChange: (auth: WebhookAuth) => void;
}) {
	return (
		<>
			<SettingsChoiceRow
				label="Auth"
				options={AUTH_OPTIONS}
				value={auth.kind}
				onChange={(kind) => onChange(AUTH_DEFAULTS[kind])}
			/>
			{auth.kind === "hmac" && (
				<SettingsChoiceRow
					label="Format"
					options={FORMAT_OPTIONS}
					value={auth.format}
					onChange={(format: HmacFormat) =>
						onChange(format === "body" ? DEFAULT_WEBHOOK_AUTH : { kind: "hmac", format })
					}
				/>
			)}
			{auth.kind === "hmac" && auth.format === "body" && (
				<>
					<CommittedFieldRow
						key={auth.header}
						label="Header"
						value={auth.header}
						placeholder="X-Signature"
						onCommit={(header) => onChange({ ...auth, header })}
					/>
					<SettingsChoiceRow
						label="Algorithm"
						options={ALGORITHM_OPTIONS}
						value={auth.algorithm}
						onChange={(algorithm) => onChange({ ...auth, algorithm })}
					/>
				</>
			)}
			{auth.kind === "api_key" && (
				<CommittedFieldRow
					key={auth.header}
					label="Header"
					value={auth.header}
					placeholder="X-API-Key"
					onCommit={(header) => onChange({ ...auth, header })}
				/>
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
				className="min-w-0 flex-1 rounded-md bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
			/>
		</SettingsControlRow>
	);
}

/**
 * The routine's secret, while this tab holds it, with a way to make a new one.
 * A signature can also use the secret its sender made, pasted in.
 */
function SecretRow({ placed, auth }: { placed: PlacedRoutine; auth: WebhookAuth }) {
	const { routine, agent } = placed;
	const actions = useRoutineActions();
	const secret = useShownSecret(routine.id);
	const [shown, setShown] = useState(false);
	const [confirmingReset, setConfirmingReset] = useState(false);
	const [pasting, setPasting] = useState(false);
	const label = SECRET_LABELS[auth.kind];
	const addressed = { agentId: agent.id, routineId: routine.id };

	return (
		<>
			<SettingsControlRow label={label}>
				{secret ? (
					<code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
						{shown ? secret : `${secret.slice(0, SECRET_SHOWN_PREFIX)}${"•".repeat(12)}`}
					</code>
				) : (
					<span className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground">
						Shown only when it's made
					</span>
				)}
				{secret && (
					<>
						<IconButton label={shown ? "Hide" : "Show"} size="lg" onClick={() => setShown(!shown)}>
							{shown ? <EyeOff /> : <Eye />}
						</IconButton>
						<CopyIconButton label={`Copy ${label.toLowerCase()}`} text={secret} size="lg" />
					</>
				)}
				{auth.kind === "hmac" && !pasting && (
					<Button
						variant="link"
						size="bare"
						className="text-[13.5px]"
						onClick={() => setPasting(true)}
					>
						Paste
					</Button>
				)}
				<IconButton label="Make a new one" size="lg" onClick={() => setConfirmingReset(true)}>
					<RefreshCw />
				</IconButton>
			</SettingsControlRow>
			{pasting && (
				<PasteSecretRow
					pending={actions.rotateSecret.isPending}
					error={
						actions.rotateSecret.error ? failureMessage(actions.rotateSecret.error) : undefined
					}
					onCancel={() => setPasting(false)}
					onSave={async (pasted) => {
						try {
							await actions.rotateSecret.mutateAsync({ ...addressed, secret: pasted });
							setPasting(false);
						} catch {
							// The row says why.
						}
					}}
				/>
			)}
			<DeleteDialog
				open={confirmingReset}
				onOpenChange={setConfirmingReset}
				title={`Make a new ${label.toLowerCase()}?`}
				description="The current one stops working straight away, so anything calling this address needs the new one."
				confirmLabel="Make a new one"
				pending={actions.rotateSecret.isPending}
				error={actions.rotateSecret.error ? failureMessage(actions.rotateSecret.error) : undefined}
				onDelete={async () => {
					try {
						await actions.rotateSecret.mutateAsync(addressed);
						setShown(true);
						setConfirmingReset(false);
					} catch {
						return;
					}
				}}
			/>
		</>
	);
}

/** Where a secret the sender made, such as Slack's signing secret, is pasted to replace the routine's. */
function PasteSecretRow({
	pending,
	error,
	onCancel,
	onSave,
}: {
	pending: boolean;
	error: string | undefined;
	onCancel: () => void;
	onSave: (secret: string) => void;
}) {
	const [value, setValue] = useState("");
	const id = useId();
	const ready = value.trim().length >= MIN_WEBHOOK_SECRET_CHARACTERS;
	// Paste was just pressed, so the secret goes straight in.
	const focusOnOpen = useCallback((input: HTMLInputElement | null) => input?.focus(), []);
	return (
		<div className="flex flex-col gap-2 border-border border-b px-4 py-2.5 last:border-b-0">
			<div className="flex min-h-[26px] items-center gap-3">
				<SettingsFieldLabel htmlFor={id}>Sender's</SettingsFieldLabel>
				<input
					id={id}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					autoComplete="off"
					spellCheck={false}
					ref={focusOnOpen}
					placeholder="Paste the secret the sender made"
					className="min-w-0 flex-1 rounded-md bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:font-sans placeholder:text-[14.5px] placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
				/>
				<Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
					Cancel
				</Button>
				<Button size="sm" disabled={!ready || pending} onClick={() => onSave(value.trim())}>
					Save
				</Button>
			</div>
			{error && (
				<span role="alert" className="text-destructive-text text-sm">
					{error}
				</span>
			)}
		</div>
	);
}

/** The line of an example request that carries the auth, for the kinds a person sends by hand. */
function exampleAuthLine(auth: WebhookAuth): string | undefined {
	switch (auth.kind) {
		case "hmac":
			return auth.format === "body"
				? `  -H "${auth.header}: ${auth.algorithm}=$SIGNATURE" \\`
				: undefined;
		case "api_key":
			return `  -H "${auth.header}: $API_KEY" \\`;
		case "bearer":
			return `  -H "Authorization: Bearer $TOKEN" \\`;
		case "basic":
			return `  -u "${auth.username}:$PASSWORD" \\`;
	}
}

/**
 * A curl call that would run the routine with the auth chosen, to copy and
 * fill in. Slack and Stripe send their own, so there is none for them.
 */
function ExampleRequest({ address, auth }: { address: string; auth: WebhookAuth }) {
	const authLine = exampleAuthLine(auth);
	if (!authLine) return null;
	const example = [
		`curl -X POST ${address} \\`,
		`  -H "Content-Type: application/json" \\`,
		authLine,
		`  -d '{"text": "New signup: acme.io"}'`,
	].join("\n");
	return (
		<div className="flex flex-col gap-2 border-border border-b px-4 py-3 last:border-b-0">
			<div className="flex items-center gap-3">
				<span className="flex-1 text-[14px] text-foreground">Example request</span>
				<CopyIconButton label="Copy example request" text={example} size="lg" />
			</div>
			<pre className="m-0 whitespace-pre-wrap break-all rounded-[10px] bg-background px-3.5 py-3 font-mono text-[12px] text-foreground leading-[1.65]">
				{example}
			</pre>
		</div>
	);
}
