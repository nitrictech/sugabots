import { isResetLinkInvalid } from "@sugabots/sdk";
import { type FormEvent, useState } from "react";
import { client } from "@/api.ts";
import { failureMessage } from "@/lib/failure.ts";
import { requestPasswordReset } from "@/lib/password-reset.ts";
import { AuthLayout, FormRow, fieldClass } from "@/screens/AuthLayout.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";

/**
 * Ask for a reset link. The answer is the same whether or not the address has
 * an account, so this page cannot be used to find out who does.
 */
export function ForgotPassword({
	initialEmail = "",
	subtitle = "Enter the email you log in with and we'll send you a link to choose a new password.",
	onBack,
}: {
	initialEmail?: string;
	subtitle?: string;
	onBack: () => void;
}) {
	const [email, setEmail] = useState(initialEmail);
	const [sentTo, setSentTo] = useState<string>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			await requestPasswordReset(email);
			setSentTo(email);
		} catch (failure) {
			setError(failureMessage(failure));
		} finally {
			setBusy(false);
		}
	}

	if (sentTo !== undefined) {
		return (
			<AuthLayout
				title="Check your email"
				subtitle={`If ${sentTo} has an account, a link to reset its password is on its way. It works for an hour.`}
			>
				<Button variant="outline" size="lg" onClick={onBack} className="w-full">
					Back to log in
				</Button>
			</AuthLayout>
		);
	}

	return (
		<AuthLayout onBack={onBack} title="Reset your password" subtitle={subtitle}>
			<form onSubmit={submit} className="flex flex-col gap-3.5">
				<div className="overflow-hidden rounded-panel bg-list">
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
				</div>

				{error !== undefined && <Alert>{error}</Alert>}

				<Button type="submit" size="lg" disabled={busy} className="w-full">
					Send reset link
				</Button>
			</form>
		</AuthLayout>
	);
}

const EXPIRED_LINK_SUBTITLE =
	"That link has expired or has already been used. Ask for another one.";

/**
 * Choose a new password with the token from a reset link, or, when there is no
 * good token, ask for another link.
 */
export function ResetPassword({
	token,
	onReset,
	onBack,
}: {
	/** `undefined` when the link was refused before it got here. */
	token: string | undefined;
	onReset: () => Promise<void>;
	onBack: () => void;
}) {
	const [expired, setExpired] = useState(token === undefined);
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (token === undefined) return;
		setBusy(true);
		setError(undefined);
		try {
			await client.auth.resetPassword({ token, newPassword: password });
		} catch (failure) {
			// The link was good when it opened this page, but has run out since.
			if (isResetLinkInvalid(failure)) {
				setExpired(true);
				return;
			}
			setError(failureMessage(failure));
			return;
		} finally {
			setBusy(false);
		}
		await onReset();
	}

	if (expired) {
		return <ForgotPassword subtitle={EXPIRED_LINK_SUBTITLE} onBack={onBack} />;
	}

	return (
		<AuthLayout
			onBack={onBack}
			title="Choose a new password"
			subtitle="This signs you out on every device. Then log in with the new password."
		>
			<form onSubmit={submit} className="flex flex-col gap-3.5">
				<div className="overflow-hidden rounded-panel bg-list">
					<FormRow id="password" label="Password">
						<input
							id="password"
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete="new-password"
							placeholder="8 characters or more"
							minLength={8}
							required
							className={fieldClass}
						/>
					</FormRow>
				</div>

				{error !== undefined && <Alert>{error}</Alert>}

				<Button type="submit" size="lg" disabled={busy} className="w-full">
					Change password
				</Button>
			</form>
		</AuthLayout>
	);
}
