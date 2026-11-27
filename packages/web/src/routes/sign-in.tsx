import { createRoute, Navigate, redirect, useNavigate } from "@tanstack/react-router";
import { RESET_PASSWORD_PATH } from "@/lib/password-reset.ts";
import { useSession } from "@/lib/session.ts";
import { lazyNamed } from "./lazy-screen.tsx";
import { rootRoute } from "./root.tsx";
import { decodeRouteId, optionalRouteId, optionalString } from "./search.ts";

const Invitation = lazyNamed(() => import("@/screens/Invitation.tsx"), "Invitation");
const SignIn = lazyNamed(() => import("@/screens/SignIn.tsx"), "SignIn");
const ResetPassword = lazyNamed(
	() => import("@/screens/ResetPassword.tsx").then(({ ResetPassword }) => ({ ResetPassword })),
	"ResetPassword",
);

interface SignInSearch {
	/** The invitation to open once signed in. */
	invitation?: string;
	/** Set on the way back from a password reset. */
	passwordChanged?: boolean;
	/** Where signing in interrupted, as a path in this app; anything else is dropped. */
	returnTo?: string;
}

export const signInRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/sign-in",
	validateSearch: (search: Record<string, unknown>): SignInSearch => ({
		invitation: optionalRouteId(search.invitation),
		passwordChanged: search.passwordChanged === true ? true : undefined,
		returnTo: isAppPath(search.returnTo) ? search.returnTo : undefined,
	}),
	component: SignInRoute,
});

/** A path in this app: not protocol-relative or backslashed, which a browser would take elsewhere. */
function isAppPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!value.includes("\\")
	);
}

function SignInRoute() {
	const session = useSession();
	const { invitation, passwordChanged, returnTo = "/" } = signInRoute.useSearch();
	const navigate = useNavigate();

	if (session.member) {
		return invitation !== undefined ? (
			<Navigate to="/invitations/$id" params={{ id: invitation }} replace />
		) : (
			<Navigate to={returnTo} replace />
		);
	}

	return (
		<SignIn
			invitationId={invitation}
			passwordChanged={passwordChanged}
			onSignedIn={async () => {
				await session.refresh();
				await navigate({
					to: invitation !== undefined ? "/invitations/$id" : returnTo,
					params: invitation !== undefined ? { id: invitation } : undefined,
					replace: true,
				});
			}}
		/>
	);
}

/** `$code` is from a member's referral link; the API decides whether it still works. */
export const joinRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/join/$code",
	component: JoinRoute,
});

/** Signing up from a referral link. Somebody already signed in has no use for it and goes home. */
function JoinRoute() {
	const session = useSession();
	const { code } = joinRoute.useParams();
	const navigate = useNavigate();

	if (session.member) return <Navigate to="/" replace />;

	return (
		<SignIn
			referralCode={code}
			onSignedIn={async () => {
				await session.refresh();
				await navigate({ to: "/", replace: true });
			}}
		/>
	);
}

interface ResetPasswordSearch {
	/** From a link the API has checked; absent with `error` once it has expired or been used. */
	token?: string;
}

export const resetPasswordRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: RESET_PASSWORD_PATH,
	validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => ({
		token: optionalString(search.token),
	}),
	component: ResetPasswordRoute,
});

function ResetPasswordRoute() {
	const session = useSession();
	const { token } = resetPasswordRoute.useSearch();
	const navigate = useNavigate();
	const toSignIn = (search: SignInSearch) => navigate({ to: "/sign-in", search, replace: true });

	return (
		<ResetPassword
			token={token}
			onBack={() => toSignIn({})}
			onReset={async () => {
				// The reset ended every session, this browser's included.
				await session.refresh();
				await toSignIn({ passwordChanged: true });
			}}
		/>
	);
}

export const invitationRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/invitations/$id",
	params: { parse: ({ id }) => ({ id: decodeRouteId(id) }) },
	beforeLoad: ({ context, params }) => {
		// An invitation is accepted as somebody. Sign in first, and come back:
		// the id rides along so the link is not lost on the way.
		if (context.member === null) {
			throw redirect({ to: "/sign-in", search: { invitation: params.id } });
		}
	},
	component: InvitationRoute,
});

function InvitationRoute() {
	const session = useSession();
	const { id } = invitationRoute.useParams();
	const navigate = useNavigate();

	return (
		<Invitation
			id={id}
			onDone={async () => {
				await session.refresh();
				await navigate({ to: "/", replace: true });
			}}
		/>
	);
}
