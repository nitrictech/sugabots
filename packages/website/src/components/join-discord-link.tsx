import type { VariantProps } from "class-variance-authority";
import { ArrowUpRightIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { siteLinks } from "@/site-links";

/** A button linking to the Discord, where launch news is posted. For use before launch. */
export function JoinDiscordLink({ size, variant }: VariantProps<typeof buttonVariants>) {
	return (
		<a href={siteLinks.discord} className={buttonVariants({ size, variant })}>
			Join Discord
			<ArrowUpRightIcon data-icon="inline-end" />
		</a>
	);
}
