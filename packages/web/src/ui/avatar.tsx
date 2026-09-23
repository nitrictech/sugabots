import { cn } from "cn";

export function PersonAvatar({
	name,
	image,
	size = 32,
	className,
}: {
	name: string;
	image?: string | null;
	size?: number;
	className?: string;
}) {
	return (
		<span
			title={name}
			className={cn(
				"grid shrink-0 place-items-center overflow-hidden rounded-full bg-person-avatar font-bold text-person-avatar-foreground",
				className,
			)}
			style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.34)) }}
		>
			{image ? <img src={image} alt="" className="size-full object-cover" /> : initials(name)}
		</span>
	);
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0] ?? "?";
	const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
	return (last ? first.slice(0, 1) + last.slice(0, 1) : first.slice(0, 2)).toUpperCase();
}
