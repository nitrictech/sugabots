import type { AgentColor, AgentFace } from "@sugabots/contracts";
import { isEmailUnverified } from "@sugabots/sdk";
import { type FormEvent, type ReactNode, useState } from "react";
import { client } from "@/api.ts";
import { failureMessage } from "@/lib/failure.ts";
import { AuthLayout } from "@/screens/AuthLayout.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";

/**
 * Sign in, or create an account.
 *
 * The design leads with a magic link and keeps a password as the fallback. It
 * is the other way round here, and will be until there is somewhere to send
 * mail: by default `Email.layer` (`packages/core/src/email/email.ts`) logs
 * invitations rather than sending them, and a sign-in link nobody receives
 * is worse than no link at all. When email is really sent this becomes the
 * secondary action, which is a change to this file and not to the flow.
 */
export function Login({
	inviteId,
	onSignedIn,
}: {
	inviteId?: string;
	onSignedIn: () => Promise<void>;
}) {
	// An invitation link says why you are here, so it goes straight to the form.
	const [welcomed, setWelcomed] = useState(inviteId !== undefined);
	const [isNew, setIsNew] = useState(false);
	// The address of an account that exists but has not been proven. Only an
	// installation that requires verification reaches this: it withholds the
	// session at sign-up and refuses the sign-in until the link is used. Where
	// verification is off, sign-up hands back a session straight away.
	const [unverified, setUnverified] = useState<string>();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(undefined);

		try {
			if (isNew) {
				await createAccount();
			} else {
				await logIn();
			}
		} catch (failure) {
			setError(failureMessage(failure));
		} finally {
			setBusy(false);
		}
	}

	// A refused sign-up (signups are invite only) is an error like any
	// other, and the server's message says what to do about it.
	async function createAccount() {
		const callbackURL = inviteId === undefined ? undefined : inviteLink(inviteId).toString();
		const { token } = await client.auth.signUp({ name, email, password, callbackURL });
		if (token === null) {
			setUnverified(email);
			return;
		}
		await onSignedIn();
	}

	async function logIn() {
		try {
			await client.auth.signIn({ email, password });
		} catch (failure) {
			// Refusing this attempt has already resent the link, so the screen
			// below is the whole of what is left to say.
			if (isEmailUnverified(failure)) {
				setUnverified(email);
				return;
			}
			throw failure;
		}
		await onSignedIn();
	}

	if (unverified !== undefined) {
		return (
			<AuthLayout
				title="Check your email"
				subtitle={`Open the link sent to ${unverified} to finish signing in.`}
			>
				<Button
					variant="outline"
					size="lg"
					onClick={() => setUnverified(undefined)}
					className="w-full"
				>
					Back
				</Button>
			</AuthLayout>
		);
	}

	if (!welcomed) {
		return <Welcome onContinue={() => setWelcomed(true)} />;
	}

	return (
		<AuthLayout
			onBack={inviteId === undefined ? () => setWelcomed(false) : undefined}
			title={isNew ? "Create an account" : "Log in"}
			subtitle={
				inviteId !== undefined
					? "You have been invited to a workspace. Log in to accept it."
					: undefined
			}
		>
			<form onSubmit={submit} className="flex flex-col gap-3.5">
				<div className="overflow-hidden rounded-panel bg-list">
					{isNew && (
						<FormRow id="name" label="Name">
							<input
								id="name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								autoComplete="name"
								required
								className={fieldClass}
							/>
						</FormRow>
					)}
					<FormRow id="email" label="Work email">
						<input
							id="email"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							autoComplete="email"
							placeholder="you@company.com"
							required
							className={fieldClass}
						/>
					</FormRow>
					<FormRow id="password" label="Password">
						<input
							id="password"
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete={isNew ? "new-password" : "current-password"}
							placeholder={isNew ? "8 characters or more" : undefined}
							minLength={8}
							required
							className={fieldClass}
						/>
					</FormRow>
				</div>

				{error !== undefined && <Alert>{error}</Alert>}

				<Button type="submit" size="lg" disabled={busy} className="w-full">
					{isNew ? "Create account" : "Log in"}
				</Button>
			</form>

			<button
				type="button"
				onClick={() => setIsNew(!isNew)}
				className="focus-ring self-center rounded-md px-1.5 py-1.5 font-medium text-[14px] text-muted-foreground"
			>
				{isNew ? "I already have an account" : "Create an account"}
			</button>
		</AuthLayout>
	);
}

/** A bot of each colour, each with its own eyes and a little up or down, as the design lines them up. */
const crowd: readonly { color: AgentColor; face: AgentFace; drop: number }[] = [
	{ color: "rose", face: "dot", drop: 12 },
	{ color: "yellow", face: "pill", drop: -2 },
	{ color: "purple", face: "arc", drop: 8 },
	{ color: "sky", face: "pill", drop: -6 },
	{ color: "green", face: "square", drop: 10 },
	{ color: "orange", face: "wink", drop: 2 },
	{ color: "ice", face: "arc", drop: -4 },
	{ color: "teal", face: "dot", drop: 8 },
];

/**
 * The first thing somebody new sees. Email is the one way in today; the
 * design's Google button waits for Google sign-in to exist.
 */
function Welcome({ onContinue }: { onContinue: () => void }) {
	return (
		<main className="grid h-full place-items-center overflow-x-hidden bg-background px-4 text-foreground">
			<div className="flex w-full max-w-[440px] flex-col items-center gap-[22px] text-center">
				<div aria-hidden className="flex justify-center gap-3 pb-2">
					{crowd.map(({ color, face, drop }) => (
						<span key={color} className="shrink-0" style={{ transform: `translateY(${drop}px)` }}>
							<AgentAvatar color={color} face={face} size={52} />
						</span>
					))}
				</div>
				<h1 className="m-0 font-bold text-[30px] leading-[1.15] tracking-[-0.02em]">
					Welcome to Sugabots
				</h1>
				<p className="m-0 text-pretty text-[15px] text-muted-foreground leading-[1.55]">
					Bots that work alongside your team, in chats you already know how to use.
				</p>
				<Button
					size="lg"
					className="mt-2 w-full bg-foreground text-background hover:bg-foreground/90"
					onClick={onContinue}
				>
					Continue with email
				</Button>
			</div>
		</main>
	);
}

const fieldClass =
	"min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground";

/** One labelled field in the form's card, as every form in the app lays them out. */
function FormRow({ id, label, children }: { id: string; label: string; children: ReactNode }) {
	return (
		<div className="flex items-center gap-3 border-border border-b px-4 py-3.5 last:border-b-0 focus-within:bg-panel">
			<label htmlFor={id} className="w-[88px] shrink-0 text-[14px] text-muted-foreground">
				{label}
			</label>
			{children}
		</div>
	);
}

function inviteLink(inviteId: string): URL {
	return new URL(`/invite/${encodeURIComponent(inviteId)}`, window.location.origin);
}
