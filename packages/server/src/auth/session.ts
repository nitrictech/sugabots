import type { SessionUser } from "@sugabots/contracts";

/**
 * How the API turns request credentials into the person who sent them.
 *
 * HTTP tests hand `createTestApp` a resolver of their own, which is what lets
 * them run without a database.
 */
export interface Session {
	user: SessionUser;
}

export type SessionResolver = (headers: Headers) => Promise<Session | null>;
