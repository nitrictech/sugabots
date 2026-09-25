import { BotFace, type BotLook } from "@sugabots/avatars";
import { cn } from "cn";
import type { ComponentProps } from "react";
import { Avatar } from "@/components/ui/avatar";

type BotAvatarProps = BotLook & Omit<ComponentProps<typeof Avatar>, "color">;

/** A bot's face at one of the avatar sizes, so it stacks in an `AvatarGroup`. */
export function BotAvatar({ color, face, className, ...props }: BotAvatarProps) {
	return (
		<Avatar className={cn("after:hidden", className)} {...props}>
			<BotFace color={color} face={face} className="size-full" />
		</Avatar>
	);
}
