import { useState } from "react";

/**
 * A save the person waits on, such as a dialog's: whether one is in flight,
 * and why the last one failed, until the next begins. `save` runs `work` unless
 * a save is already in flight, and resolves to whether it succeeded; it never
 * rejects, since the failure is kept in `failure` to show.
 */
export function useSaving() {
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<unknown>();

	async function save(work: () => Promise<unknown> | undefined): Promise<boolean> {
		if (pending) return false;
		setPending(true);
		setFailure(undefined);
		try {
			await work();
			return true;
		} catch (error) {
			setFailure(error);
			return false;
		} finally {
			setPending(false);
		}
	}

	return { pending, failure, save, clearFailure: () => setFailure(undefined) };
}
