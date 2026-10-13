import { useEffect, useState } from "react";

/** How long the result of a copy shows before the control offers to copy again. */
const COPY_RESULT_MS = 2000;

/**
 * Puts text on the clipboard and, for two seconds after, says how it went in
 * the copying control's label: "Copied", or "Couldn't copy" where the browser
 * refuses, as it does on a page served over plain HTTP. `idleLabel` is the
 * label the rest of the time.
 */
export function useCopy(idleLabel: string) {
	const [result, setResult] = useState<"copied" | "failed">();
	useEffect(() => {
		if (!result) return;
		const timer = setTimeout(() => setResult(undefined), COPY_RESULT_MS);
		return () => clearTimeout(timer);
	}, [result]);

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			setResult("copied");
		} catch {
			setResult("failed");
		}
	}

	const label = result === "copied" ? "Copied" : result === "failed" ? "Couldn't copy" : idleLabel;
	return { copied: result === "copied", label, copy };
}
