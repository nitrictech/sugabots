import type { SessionUser } from "@sugabots/contracts";
import type { Auth } from "./auth.ts";

/**
 * How the API turns request credentials into the person who sent them.
 *
 * The middleware knows only this function, which is what lets the HTTP tests
 * run without a database: they hand `createTestApp` a resolver of their own.
 */
export interface Session {
	user: SessionUser;
}

export type SessionResolver = (headers: Headers) => Promise<Session | null>;

/** Returns a resolver that asks Better Auth who holds the request credentials. */
export function betterAuthSessionResolver(auth: Auth): SessionResolver {
	return async (headers) => {
		const result = await auth.api.getSession({ headers });

		if (!result) {
			return null;
		}

		const { id, email, name, image } = result.user;
		return { user: { id, email, name, image: image ?? null } };
	};
}
