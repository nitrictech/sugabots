import { cn } from "cn";
import { renderHashvatar } from "hashvatar";
import { useEffect, useRef } from "react";

export function PersonAvatar({
	name,
	email,
	image,
	size = 32,
	className,
}: {
	name: string;
	email: string;
	image?: string | null;
	size?: number;
	className?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		if (!canvasRef.current || image) return;
		return renderHashvatar(canvasRef.current, {
			hash: email.trim().toLowerCase(),
			size,
			mode: "dither",
		});
	}, [email, image, size]);

	return (
		<span
			title={name}
			className={cn(
				"relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted",
				className,
			)}
			style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.34)) }}
		>
			{image ? (
				<img src={image} alt="" className="size-full object-cover" />
			) : (
				<>
					<canvas ref={canvasRef} className="absolute inset-0 size-full rounded-full" />
					<span
						className="relative font-bold text-white"
						style={{ textShadow: "0 1px 2px #000, 0 0 2px #000" }}
					>
						{initials(name)}
					</span>
				</>
			)}
		</span>
	);
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0] ?? "?";
	const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
	return (last ? first.slice(0, 1) + last.slice(0, 1) : first.slice(0, 2)).toUpperCase();
}
