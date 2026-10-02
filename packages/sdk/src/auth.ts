import { InternalServerError } from "@sugabots/contracts/http";
import { createAuthClient } from "better-auth/client";
import { failureForStatus, isApiFailure } from "./errors.ts";
import type { TokenStore } from "./tokens.ts";

/**
 * Signing up, in and out, which better-auth serves under `/auth` with a client
 * of its own. better-auth returns `{ data, error }` where the rest of this
 * client throws the API's own failures, so the wrapper below throws too, and
 * callers need not know which half of the API they are talking to.
 */

export interface AuthClientOptions {
	baseUrl: string;
	tokens?: TokenStore;
	fetch?: typeof globalThis.fetch;
	/** Overrides the declared origin outside the browser. See below. */
	origin?: string;
}

export function createAuthApi({ baseUrl, tokens, fetch, origin }: AuthClientOptions) {
	// better-auth's `basePath` is ignored whenever `baseURL` already carries a
	// path, and `baseUrl` carries the API's mount path, so /auth goes in the URL.
	const auth = createAuthClient({
		baseURL: `${baseUrl}/auth`,
		fetchOptions: {
			...(fetch ? { customFetchImpl: fetch } : {}),
			credentials: tokens ? "omit" : "include",
			headers: declaredOrigin(baseUrl, origin),
			...(tokens
				? {
						auth: { type: "Bearer" as const, token: () => tokens.get() },
						onSuccess: (context: { response: Response }) => {
							const issued = context.response.headers.get("set-auth-token");
							if (issued) {
								tokens.set(issued);
							}
						},
					}
				: {}),
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
			try {
				await orThrow(auth.signOut());
			} finally {
				// Whether or not the server accepted it, this client is done
				// with the token; keeping it would only fail every next request.
				tokens?.set(undefined);
			}
		},
	};
}

export type AuthApi = ReturnType<typeof createAuthApi>;

/**
 * better-auth refuses a sign-in that arrives without an `Origin` it trusts,
 * which is what stops a page on another site from posting a form at it. A
 * browser sets that header itself and will not let us touch it. Nothing else
 * sets it at all, so Electron, React Native and scripts have to say who they
 * are, and the honest answer is the API's own origin: they are not a web page.
 *
 * Sending it only outside the browser keeps the protection where it matters —
 * a caller that can set headers freely was never the thing being defended
 * against.
 */
function declaredOrigin(baseUrl: string, override?: string): Record<string, string> {
	if (typeof window !== "undefined") {
		return {};
	}
	return { origin: override ?? new URL(baseUrl).origin };
}

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
		const message = error.message ?? error.statusText ?? `Request failed with status ${status}`;
		throw failureForStatus(status, message, error.code);
	}
	if (data === null) {
		throw new InternalServerError({ message: "The auth service returned no data" });
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
