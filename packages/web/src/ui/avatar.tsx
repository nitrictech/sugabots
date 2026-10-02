import { cn } from "cn";
import { useEffect, useState } from "react";

export function PersonAvatar({
	person: { name, email, image },
	size = 32,
	className,
}: {
	person: { name: string; email: string; image?: string | null };
	size?: number;
	className?: string;
}) {
	const gravatar = useGravatarUrl(email, size);
	const [missingGravatar, setMissingGravatar] = useState<string>();

	return (
		<span
			title={name}
			className={cn(
				"relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-person-avatar font-bold text-person-avatar-foreground",
				className,
			)}
			style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.34)) }}
		>
			{image ? (
				<img src={image} alt="" className="size-full object-cover" />
			) : (
				<>
					{initials(name)}
					{gravatar && gravatar !== missingGravatar && (
						<img
							src={gravatar}
							alt=""
							className="absolute inset-0 size-full object-cover"
							onError={() => setMissingGravatar(gravatar)}
						/>
					)}
				</>
			)}
		</span>
	);
}

/** Drawn at twice the displayed size so it stays sharp on high-density screens. */
const GRAVATAR_PIXEL_RATIO = 2;

/**
 * The Gravatar for an email address, once its hash is computed. Gravatar is
 * asked to fail rather than draw a stand-in, so someone without one keeps their
 * initials.
 */
function useGravatarUrl(email: string, size: number): string | undefined {
	const [found, setFound] = useState<{ email: string; size: number; url: string }>();

	useEffect(() => {
		let current = true;
		void sha256Hex(email.trim().toLowerCase()).then((hash) => {
			if (!current) return;
			const pixels = size * GRAVATAR_PIXEL_RATIO;
			setFound({ email, size, url: `https://gravatar.com/avatar/${hash}?s=${pixels}&d=404` });
		});
		return () => {
			current = false;
		};
	}, [email, size]);

	return found?.email === email && found.size === size ? found.url : undefined;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0] ?? "?";
	const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
	return (last ? first.slice(0, 1) + last.slice(0, 1) : first.slice(0, 2)).toUpperCase();
}
