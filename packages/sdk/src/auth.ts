import { InternalServerError } from "@sugabots/contracts/http";
import { UserText, userText } from "@sugabots/errors";
import { createAuthClient } from "better-auth/client";
import { failureForStatus, isApiFailure } from "./errors.ts";

/**
 * Signing up, in and out, which better-auth serves under `/auth` with a client
 * of its own. better-auth returns `{ data, error }` where the rest of this
 * client throws the API's own failures, so the wrapper below throws too, and
 * callers need not know which half of the API they are talking to.
 */

interface AuthClientOptions {
	baseUrl: string;
	fetch?: typeof globalThis.fetch;
}

export function createAuthApi({ baseUrl, fetch }: AuthClientOptions) {
	// better-auth's `basePath` is ignored whenever `baseURL` already carries a
	// path, and `baseUrl` carries the API's mount path, so /auth goes in the URL.
	const auth = createAuthClient({
		baseURL: `${baseUrl}/auth`,
		fetchOptions: {
			...(fetch ? { customFetchImpl: fetch } : {}),
			credentials: "include",
		},
	});

	return {
		/** `referralCode` is the `code` of the referral link somebody signed up from. */
		signUp: (input: {
			name: string;
			email: string;
			password: string;
			callbackURL?: string;
			referralCode?: string;
		}) => orThrow(auth.signUp.email(input)),

		signIn: (input: { email: string; password: string }) => orThrow(auth.signIn.email(input)),

		/**
		 * Emails a reset link to `email` if it has an account, and answers the
		 * same either way. The link opens `redirectTo` with `?token=`, or with
		 * `?error=INVALID_TOKEN` once it has been used or has expired.
		 */
		requestPasswordReset: (input: { email: string; redirectTo: string }) =>
			orThrow(auth.requestPasswordReset(input)),

		/** Sets a new password with the token from a reset link, and signs out every session. */
		resetPassword: (input: { token: string; newPassword: string }) =>
			orThrow(auth.resetPassword(input)),

		updateName: (input: { name: string }) => orThrow(auth.updateUser(input)),

		async signOut(): Promise<void> {
			await orThrow(auth.signOut());
		},
	};
}

export type AuthApi = ReturnType<typeof createAuthApi>;

interface Failure {
	status?: number;
	statusText?: string;
	message?: string;
	code?: string;
}

/** better-auth answers with `{ data, error }`; this client throws instead. */
async function orThrow<T>(
	call: PromiseLike<{ data: T | null; error: Failure | null }>,
): Promise<T> {
	const { data, error } = await call;

	if (error) {
		const status = error.status ?? 500;
		// better-auth's own words, which the sign-in screens show as they are.
		const message = error.message ?? error.statusText;
		throw failureForStatus(
			status,
			message === undefined
				? userText`Request failed with status ${status}`
				: UserText.unchecked(message),
			error.code,
		);
	}
	if (data === null) {
		throw new InternalServerError({ message: userText`The auth service returned no data` });
	}

	return data;
}

/**
 * Whether the API refused because this account has not proved its address.
 * Other refusals share its 403, so only the code in `details` tells them apart.
 */
export function isEmailUnverified(failure: unknown): boolean {
	return (
		isApiFailure(failure) &&
		typeof failure.details === "string" &&
		emailUnverifiedCodes.has(failure.details)
	);
}

const emailUnverifiedCodes = new Set([
	// Signing in, from better-auth.
	"EMAIL_NOT_VERIFIED",
	// Accepting an invitation.
	"EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION",
]);

/** Whether a password reset was refused because its link has been used or has expired. */
export function isResetLinkInvalid(failure: unknown): boolean {
	return isApiFailure(failure) && failure.details === "INVALID_TOKEN";
}
