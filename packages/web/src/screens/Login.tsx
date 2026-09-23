import { isEmailUnverified } from "@sugabots/sdk";
import { type FormEvent, useState } from "react";
import { client } from "@/api.ts";
import { failureMessage } from "@/lib/failure.ts";
import { AuthLayout } from "@/screens/AuthLayout.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Field } from "@/ui/field.tsx";
import { Input } from "@/ui/input.tsx";

/**
 * Sign in, or create an account.
 *
 * The design leads with a magic link and keeps a password as the fallback. It
 * is the other way round here, and will be until there is somewhere to send
 * mail: `packages/server/src/email/mailer.ts` logs invitations rather than sending
 * them, and a sign-in link nobody receives is worse than no link at all. When
 * the mailer is real this becomes the secondary action, which is a change to
 * this file and not to the flow.
 */
export function Login({
	inviteId,
	onSignedIn,
}: {
	inviteId?: string;
	onSignedIn: () => Promise<void>;
}) {
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

	return (
		<AuthLayout
			title={isNew ? "Create an account" : "Log in"}
			subtitle={
				inviteId !== undefined
					? "You have been invited to a workspace. Log in to accept it."
					: undefined
			}
		>
			<form onSubmit={submit} className="flex flex-col gap-2.5">
				{isNew && (
					<Field id="name" label="Name">
						<Input
							id="name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							required
						/>
					</Field>
				)}
				<Field id="email" label="Work email">
					<Input
						id="email"
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						autoComplete="email"
						required
					/>
				</Field>
				<Field id="password" label="Password">
					<Input
						id="password"
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete={isNew ? "new-password" : "current-password"}
						minLength={8}
						required
					/>
				</Field>

				{error !== undefined && <Alert>{error}</Alert>}

				<Button type="submit" size="lg" disabled={busy} className="mt-1 w-full">
					{isNew ? "Create account" : "Log in"}
				</Button>
			</form>

			<div className="flex items-center gap-2.5">
				<span className="h-px flex-1 bg-border" />
				<span className="font-mono text-2xs text-subtle-foreground">or</span>
				<span className="h-px flex-1 bg-border" />
			</div>

			<Button variant="outline" size="lg" onClick={() => setIsNew(!isNew)} className="w-full">
				{isNew ? "I already have an account" : "Create an account"}
			</Button>
		</AuthLayout>
	);
}

function inviteLink(inviteId: string): URL {
	return new URL(`/invite/${encodeURIComponent(inviteId)}`, window.location.origin);
}
