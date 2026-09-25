import logoUrl from "@sugabots/avatars/sugabots-logo.svg";
import { cn } from "cn";

/** The Sugabots mark. */
export function SiteLogo({ className }: { className?: string }) {
	return <img src={logoUrl} alt="" className={cn("shrink-0", className)} />;
}
