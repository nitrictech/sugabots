import { createRoute, Navigate, redirect, useNavigate } from "@tanstack/react-router";
import { RESET_PASSWORD_PATH } from "@/lib/password-reset.ts";
import { useSession } from "@/lib/session.ts";
import { lazyNamed } from "./lazy-screen.tsx";
import { rootRoute } from "./root.tsx";
import { optionalString } from "./search.ts";

const Invite = lazyNamed(() => import("@/screens/Invite.tsx"), "Invite");
const Login = lazyNamed(() => import("@/screens/Login.tsx"), "Login");
const ResetPassword = lazyNamed(
	() => import("@/screens/ResetPassword.tsx").then(({ ResetPassword }) => ({ ResetPassword })),
	"ResetPassword",
);

interface LoginSearch {
	/** The invitation to open once signed in. */
	invite?: string;
	/** Set on the way back from a password reset. */
	passwordChanged?: boolean;
	/** Where signing in interrupted, as a path in this app; anything else is dropped. */
	returnTo?: string;
}

export const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	validateSearch: (search: Record<string, unknown>): LoginSearch => ({
		invite: optionalString(search.invite),
		passwordChanged: search.passwordChanged === true ? true : undefined,
		returnTo: isAppPath(search.returnTo) ? search.returnTo : undefined,
	}),
	component: LoginRoute,
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

function LoginRoute() {
	const session = useSession();
	const { invite, passwordChanged, returnTo = "/" } = loginRoute.useSearch();
	const navigate = useNavigate();

	if (session.user) {
		return invite !== undefined ? (
			<Navigate to="/invite/$id" params={{ id: invite }} replace />
		) : (
			<Navigate to={returnTo} replace />
		);
	}

	return (
		<Login
			inviteId={invite}
			passwordChanged={passwordChanged}
			onSignedIn={async () => {
				await session.refresh();
				await navigate({
					to: invite !== undefined ? "/invite/$id" : returnTo,
					params: invite !== undefined ? { id: invite } : undefined,
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

	if (session.user) return <Navigate to="/" replace />;

	return (
		<Login
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
	const toLogin = (search: LoginSearch) => navigate({ to: "/login", search, replace: true });

	return (
		<ResetPassword
			token={token}
			onBack={() => toLogin({})}
			onReset={async () => {
				// The reset ended every session, this browser's included.
				await session.refresh();
				await toLogin({ passwordChanged: true });
			}}
		/>
	);
}

export const inviteRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/invite/$id",
	beforeLoad: ({ context, params }) => {
		// An invitation is accepted as somebody. Sign in first, and come back:
		// the id rides along so the link is not lost on the way.
		if (context.user === null) {
			throw redirect({ to: "/login", search: { invite: params.id } });
		}
	},
	component: InviteRoute,
});

function InviteRoute() {
	const session = useSession();
	const { id } = inviteRoute.useParams();
	const navigate = useNavigate();

	return (
		<Invite
			id={id}
			onDone={async () => {
				await session.refresh();
				await navigate({ to: "/", replace: true });
			}}
		/>
	);
}
