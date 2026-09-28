import { Cause } from "effect";
import { isSqlError } from "effect/unstable/sql/SqlError";

interface PostgresError {
	code?: string;
	constraint?: string;
}

/**
 * The error Postgres sent, dug out of the wrappers around it: drizzle's query
 * error holds a `Cause`, whose `SqlError` holds a classified reason, whose
 * own cause is the server's error with its SQLSTATE `code`.
 */
function postgresError(failure: unknown): PostgresError | undefined {
	let current = failure;
	while (current !== null && typeof current === "object") {
		if (Cause.isCause(current)) {
			current = Cause.squash(current);
			continue;
		}
		if (typeof (current as PostgresError).code === "string") {
			return current as PostgresError;
		}
		current = isSqlError(current) ? current.reason : (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/** Whether a query failure is a Postgres unique violation (code 23505). */
export function isUniqueViolation(failure: unknown): boolean {
	return postgresError(failure)?.code === "23505";
}

/** The constraint a Postgres unique violation names, or nothing for any other failure. */
export function violatedUniqueConstraint(failure: unknown): string | undefined {
	const error = postgresError(failure);
	return error?.code === "23505" ? error.constraint : undefined;
}

export function isForeignKeyViolation(failure: unknown, constraint: string): boolean {
	const error = postgresError(failure);
	return (error?.code === "23503" || error?.code === "23001") && error.constraint === constraint;
}
