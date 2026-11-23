import type { BotColor, BotFace } from "@sugabots/contracts";
import { isEmailUnverified } from "@sugabots/sdk";
import { cn } from "cn";
import { type FormEvent, useState } from "react";
import { client } from "@/api.ts";
import { failureMessage } from "@/lib/failure.ts";
import { PASSWORD_MIN_LENGTH, PASSWORD_PLACEHOLDER } from "@/lib/passwords.ts";
import { AuthLayout, FormRow, fieldClass, QuietLink } from "@/screens/AuthLayout.tsx";
import { ForgotPassword } from "@/screens/ResetPassword.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";

/**
 * Sign in, or create an account, with a password. A sign-in link by email is
 * not offered until the server really sends email: by default `Email.layer`
 * (`packages/core/src/email/email.ts`) logs mail rather than sending it, and a
 * link nobody receives is worse than none.
 */
export function Login({
	inviteId,
	referralCode,
	passwordChanged = false,
	onSignedIn,
}: {
	inviteId?: string;
	/** The code from a referral link, which lets somebody new make an account. */
	referralCode?: string;
	/** Arriving from a password reset, which says so above the form. */
	passwordChanged?: boolean;
	onSignedIn: () => Promise<void>;
}) {
	// An invitation, referral or reset link says why you are here, so it goes straight to the form.
	const [welcomed, setWelcomed] = useState(
		inviteId !== undefined || referralCode !== undefined || passwordChanged,
	);
	// A referral link is for somebody without an account.
	const [isNew, setIsNew] = useState(referralCode !== undefined);
	const [forgotPassword, setForgotPassword] = useState(false);
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
		const { token } = await client.auth.signUp({
			name,
			email,
			password,
			callbackURL,
			referralCode,
		});
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
					variant="secondary"
					size="lg"
					onClick={() => setUnverified(undefined)}
					className="w-full"
				>
					Back
				</Button>
			</AuthLayout>
		);
	}

	if (forgotPassword) {
		return <ForgotPassword initialEmail={email} onBack={() => setForgotPassword(false)} />;
	}

	if (!welcomed) {
		return <Welcome onContinue={() => setWelcomed(true)} />;
	}

	return (
		<AuthLayout
			onBack={
				inviteId === undefined && referralCode === undefined ? () => setWelcomed(false) : undefined
			}
			title={isNew ? "Create an account" : "Log in"}
			subtitle={
				inviteId !== undefined
					? "You have been invited to a workspace. Log in to accept it."
					: referralCode !== undefined && isNew
						? "You have been invited to Sugabots. Make an account to set up your own workspace."
						: passwordChanged
							? "Your password has been changed. Log in with the new one."
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
					<FormRow id="email" label="Email">
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
							placeholder={isNew ? PASSWORD_PLACEHOLDER : undefined}
							minLength={PASSWORD_MIN_LENGTH}
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

			<div className="flex justify-center gap-6">
				{!isNew && <QuietLink onClick={() => setForgotPassword(true)}>Forgot password?</QuietLink>}
				<QuietLink onClick={() => setIsNew(!isNew)}>
					{isNew ? "I already have an account" : "Create an account"}
				</QuietLink>
			</div>
		</AuthLayout>
	);
}

/** A bot of each colour, each with its own eyes and a little up or down, as the design lines them up. */
const crowd: readonly { color: BotColor; face: BotFace; drop: string }[] = [
	{ color: "rose", face: "dot", drop: "translate-y-3" },
	{ color: "yellow", face: "pill", drop: "-translate-y-0.5" },
	{ color: "purple", face: "arc", drop: "translate-y-2" },
	{ color: "sky", face: "pill", drop: "-translate-y-1.5" },
	{ color: "green", face: "square", drop: "translate-y-2.5" },
	{ color: "orange", face: "wink", drop: "translate-y-0.5" },
	{ color: "ice", face: "arc", drop: "-translate-y-1" },
	{ color: "teal", face: "dot", drop: "translate-y-2" },
];

/** The first thing somebody new sees. Email is the only way in. */
function Welcome({ onContinue }: { onContinue: () => void }) {
	return (
		<main className="grid h-full place-items-center overflow-x-hidden bg-background px-4 text-foreground">
			<div className="flex w-full min-w-0 max-w-110 flex-col items-center gap-5.5 text-center">
				<div aria-hidden className="flex justify-center gap-3 pb-2">
					{crowd.map(({ color, face, drop }) => (
						<span key={color} className={cn("shrink-0", drop)}>
							<BotAvatar color={color} face={face} shape="circle" size={52} />
						</span>
					))}
				</div>
				<h1 className="m-0 font-bold text-3xl leading-tight tracking-tight">Welcome to Sugabots</h1>
				<p className="m-0 text-pretty text-sm text-muted-foreground leading-normal">
					Bots that work alongside your team, in conversations you already know how to use.
				</p>
				<Button size="lg" className="mt-2 w-full" onClick={onContinue}>
					Continue with email
				</Button>
			</div>
		</main>
	);
}

function inviteLink(inviteId: string): URL {
	return new URL(`/invite/${encodeURIComponent(inviteId)}`, window.location.origin);
}
