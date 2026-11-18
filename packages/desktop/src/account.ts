import { sessionUserSchema } from "@sugabots/contracts/api";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Schema } from "effect";
import type { Session } from "electron";
import { SavedWorkspace, type SignIn } from "./saved-servers.ts";

/** How long cookies must stay unchanged before checking who's signed in, since signing in sets several. */
const ACCOUNT_CHECK_DELAY_MS = 500;

const HTTP_UNAUTHORIZED = 401;

const isMe = Schema.is(
	Schema.Struct({ user: sessionUserSchema, workspaces: Schema.Array(SavedWorkspace) }),
);

export interface SignInWatch {
	/** Asks again shortly, as when the page may have made, renamed or left a workspace, which changes no cookie. */
	readonly recheck: () => void;
	readonly stop: () => void;
}

/**
 * Reports who `session` is signed in to the server at `origin` as, and their
 * workspaces there, or `undefined` once it's signed out: now, and again
 * whenever its cookies change.
 */
export function watchSignIn(
	session: Session,
	origin: string,
	report: (signIn: SignIn | undefined) => void,
): SignInWatch {
	let timer: NodeJS.Timeout | undefined;
	const check = async () => {
		const response = await session
			.fetch(`${origin}${API_BASE_PATH}/me`, { credentials: "include" })
			.catch(() => undefined);
		// Anything but an answer, such as the server being unreachable, says nothing about who's signed in.
		if (response?.status === HTTP_UNAUTHORIZED) report(undefined);
		if (!response?.ok) return;
		const body: unknown = await response.json().catch(() => undefined);
		if (!isMe(body)) return;
		report({
			account: body.user.email,
			workspaces: body.workspaces.map(({ slug, name }) => ({ slug, name })),
		});
	};
	const checkSoon = () => {
		clearTimeout(timer);
		timer = setTimeout(check, ACCOUNT_CHECK_DELAY_MS);
	};
	session.cookies.on("changed", checkSoon);
	void check();
	return {
		recheck: checkSoon,
		stop: () => {
			clearTimeout(timer);
			session.cookies.off("changed", checkSoon);
		},
	};
}
