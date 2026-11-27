import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";

/**
 * A provider settings view's one error line: `act` runs a change, clearing the
 * line first and filling it with why the change failed, if it did.
 * `setError` says something else went wrong, such as a value that does not
 * read, or clears the line.
 */
export function useProviderSettingsAction() {
	const [error, setError] = useState<string>();

	async function act(work: () => Promise<unknown>) {
		setError(undefined);
		try {
			await work();
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	return { error, setError, act };
}
