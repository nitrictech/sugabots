# The pod's software, which Sugabots installs into this Nix profile and keeps
# on every sandbox the pod has, ahead of the image's own.
case ":$PATH:" in
*:/nix/var/nix/profiles/sugabots/bin:*) ;;
*) PATH="/nix/var/nix/profiles/sugabots/bin:$PATH" ;;
esac
