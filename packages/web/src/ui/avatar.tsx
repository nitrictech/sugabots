import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { cn } from "cn";
import { useMemo, useState } from "react";

export function PersonAvatar({
	person: { name, email, image },
	size = 32,
	className,
}: {
	person: { name: string; email: string; image?: string | null };
	size?: number;
	className?: string;
}) {
	const gravatar = useMemo(() => gravatarUrl(email, size), [email, size]);
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
 * Avatars up to this many CSS pixels all ask Gravatar for the same image, so a
 * person's image is downloaded once however many sizes the page shows it at.
 */
const LARGEST_SHARED_GRAVATAR_PX = 64;

/**
 * gravatarUrl returns the address of `email`'s Gravatar image, sharp when shown
 * at `size` CSS pixels. The address is the same for every `size` up to
 * `LARGEST_SHARED_GRAVATAR_PX`. It answers 404 when `email` has no Gravatar,
 * rather than serving a generated placeholder.
 */
function gravatarUrl(email: string, size: number): string {
	// Not `crypto.subtle`: browsers leave it undefined on pages served over plain HTTP.
	const hash = bytesToHex(sha256(utf8ToBytes(email.trim().toLowerCase())));
	const requestedPx = Math.max(size, LARGEST_SHARED_GRAVATAR_PX) * GRAVATAR_PIXEL_RATIO;
	return `https://gravatar.com/avatar/${hash}?s=${requestedPx}&d=404`;
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0] ?? "?";
	const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
	return (last ? first.slice(0, 1) + last.slice(0, 1) : first.slice(0, 2)).toUpperCase();
}
