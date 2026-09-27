import { CheckIcon, CopyIcon } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Languages that are commands to type, framed as a terminal. */
const SHELL_LANGUAGES = new Set(["sh", "bash", "shell", "zsh"]);

/** How long the copy button shows its tick. */
const COPIED_FEEDBACK_MS = 1600;

type CodeBlockProps = ComponentProps<"pre"> & {
	"data-language"?: string;
	"data-title"?: string;
};

/** A highlighted code block in a card, labelled, with a copy button. Shell blocks get a terminal's title bar. */
export function CodeBlock({
	"data-language": language,
	"data-title": title,
	children,
	className,
	style,
	...props
}: CodeBlockProps) {
	const code = useRef<HTMLPreElement>(null);
	const [copied, setCopied] = useState(false);
	const isShell = language !== undefined && SHELL_LANGUAGES.has(language);

	async function copy() {
		const text = code.current?.textContent;
		if (!text) return;
		await navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
	}

	return (
		<figure className="group/code my-6 overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
			<figcaption className="flex h-10 items-center gap-3 border-b px-4 text-xs font-semibold text-muted-foreground">
				{isShell && (
					<span className="flex gap-1.5" aria-hidden>
						<span className="size-2.5 rounded-full bg-rose-400" />
						<span className="size-2.5 rounded-full bg-yellow-400" />
						<span className="size-2.5 rounded-full bg-green-400" />
					</span>
				)}
				<span className="flex-1">{title ?? (isShell ? "Terminal" : language)}</span>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={copied ? "Copied" : "Copy code"}
					onClick={copy}
					className="text-muted-foreground"
				>
					{copied ? <CheckIcon /> : <CopyIcon />}
				</Button>
			</figcaption>
			<pre
				ref={code}
				// Shiki sets the theme's background inline; the card supplies it instead.
				style={{ ...style, backgroundColor: undefined }}
				className="overflow-x-auto px-5 py-4 font-mono text-[0.85rem] leading-relaxed"
				{...props}
			>
				{children}
			</pre>
		</figure>
	);
}
