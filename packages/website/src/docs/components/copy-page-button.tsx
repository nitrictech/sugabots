import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const COPIED_FEEDBACK_MS = 1600;

/** Copies the page as Markdown, for pasting into a chat with an agent. */
export function CopyPageButton({ markdown }: { markdown: string }) {
	const [copied, setCopied] = useState(false);

	async function copy() {
		await navigator.clipboard.writeText(markdown);
		setCopied(true);
		setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
	}

	return (
		<Button variant="outline" size="sm" onClick={copy}>
			{copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
			{copied ? "Copied" : "Copy as Markdown"}
		</Button>
	);
}
