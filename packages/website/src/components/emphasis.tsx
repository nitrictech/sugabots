import { cn } from "cn";
import type { ComponentProps } from "react";
import { type AccentTone, accentText } from "@/components/accent";

interface EmphasisProps extends ComponentProps<"strong"> {
	tone?: AccentTone;
}

/** A word or phrase in running text that should catch the eye. Use sparingly. */
export function Emphasis({ tone = "emerald", className, ...props }: EmphasisProps) {
	return <strong className={cn("font-semibold", accentText({ tone }), className)} {...props} />;
}
