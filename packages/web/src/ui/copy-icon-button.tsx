import { Check, Copy } from "lucide-react";
import { IconButton, type IconButtonProps } from "@/ui/icon-button.tsx";
import { useCopy } from "@/ui/use-copy.ts";

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
	const copying = useCopy(label);

	return (
		<IconButton {...props} label={copying.label} onClick={() => void copying.copy(text)}>
			{copying.copied ? (
				<Check aria-hidden className="motion-safe:animate-copy-confirmation" />
			) : (
				<Copy aria-hidden />
			)}
		</IconButton>
	);
}
