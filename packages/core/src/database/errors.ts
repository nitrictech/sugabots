/** Whether a rejection from drizzle wraps a Postgres unique violation (code 23505). */
export function isUniqueViolation(failure: unknown): boolean {
	for (let error = failure; error instanceof Error; error = error.cause) {
		if ((error as { code?: string }).code === "23505") {
			return true;
		}
	}
	return false;
}

export function isForeignKeyViolation(failure: unknown, constraint: string): boolean {
	for (let error = failure; error instanceof Error; error = error.cause) {
		const databaseError = error as { code?: string; constraint?: string };
		if (
			(databaseError.code === "23503" || databaseError.code === "23001") &&
			databaseError.constraint === constraint
		) {
			return true;
		}
	}
	return false;
}
