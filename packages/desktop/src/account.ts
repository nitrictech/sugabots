import { sessionUserSchema } from "@sugabots/contracts/api";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Schema } from "effect";
import type { Session } from "electron";

/** How long cookies must stay unchanged before checking who's signed in, since signing in sets several. */
const ACCOUNT_CHECK_DELAY_MS = 500;

const HTTP_UNAUTHORIZED = 401;

const isMe = Schema.is(Schema.Struct({ user: sessionUserSchema }));

/**
 * Reports the email `session` is signed in to the server at `origin` as, or
 * `undefined` once it's signed out: now, and again whenever its cookies
 * change. Returns a function that stops watching.
 */
export function watchAccount(
	session: Session,
	origin: string,
	report: (account: string | undefined) => void,
): () => void {
	let timer: NodeJS.Timeout | undefined;
	const check = async () => {
		const response = await session
			.fetch(`${origin}${API_BASE_PATH}/me`, { credentials: "include" })
			.catch(() => undefined);
		// Anything but an answer, such as the server being unreachable, says nothing about who's signed in.
		if (response?.status === HTTP_UNAUTHORIZED) report(undefined);
		if (!response?.ok) return;
		const body: unknown = await response.json().catch(() => undefined);
		if (isMe(body)) report(body.user.email);
	};
	const checkSoon = () => {
		clearTimeout(timer);
		timer = setTimeout(check, ACCOUNT_CHECK_DELAY_MS);
	};
	session.cookies.on("changed", checkSoon);
	void check();
	return () => {
		clearTimeout(timer);
		session.cookies.off("changed", checkSoon);
	};
}
