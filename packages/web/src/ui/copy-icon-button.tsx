import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton, type IconButtonProps } from "@/ui/icon-button.tsx";

/** How long the result of a copy shows before the button offers to copy again. */
const COPY_RESULT_MS = 2000;

/**
 * An icon button that puts `text` on the clipboard, then says whether it
 * worked: a tick named "Copied", or "Couldn't copy" where the browser refuses,
 * as it does on a page served over plain HTTP.
 */
export function CopyIconButton({
	label,
	text,
	...props
}: Omit<IconButtonProps, "children" | "onClick" | "render"> & { text: string }) {
	const [result, setResult] = useState<"copied" | "failed">();
	useEffect(() => {
		if (!result) return;
		const timer = setTimeout(() => setResult(undefined), COPY_RESULT_MS);
		return () => clearTimeout(timer);
	}, [result]);

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			setResult("copied");
		} catch {
			setResult("failed");
		}
	}

	return (
		<IconButton
			{...props}
			label={result === "copied" ? "Copied" : result === "failed" ? "Couldn't copy" : label}
			onClick={() => void copy()}
		>
			{result === "copied" ? (
				// Pops in where the copy icon was.
				<Check
					aria-hidden
					className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-50 motion-safe:duration-200"
				/>
			) : (
				<Copy aria-hidden />
			)}
		</IconButton>
	);
}
