import { client } from "@/api.ts";

/** Where a reset email's link lands: with `?token=`, or with `?error=` once it has expired or been used. */
export const RESET_PASSWORD_PATH = "/reset-password";

/** Emails a link back to `RESET_PASSWORD_PATH` in this app, if `email` has an account. */
export function requestPasswordReset(email: string) {
	return client.auth.requestPasswordReset({
		email,
		redirectTo: new URL(RESET_PASSWORD_PATH, window.location.origin).toString(),
	});
}
