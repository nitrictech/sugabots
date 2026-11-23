import { type AvatarParts, StillBotFace } from "@sugabots/avatars";
import { cn } from "cn";
import type { ComponentProps } from "react";
import { Avatar } from "@/components/ui/avatar";

type BotAvatarProps = AvatarParts & Omit<ComponentProps<typeof Avatar>, "color">;

/** A bot's face at one of the avatar sizes. */
export function BotAvatar({ color, eyes, className, ...props }: BotAvatarProps) {
	return (
		<Avatar className={cn("after:hidden", className)} {...props}>
			<StillBotFace color={color} eyes={eyes} className="size-full" />
		</Avatar>
	);
}
