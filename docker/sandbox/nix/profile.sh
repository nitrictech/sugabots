# What agents install with `nix profile install`, on their PATH, with the
# data it brings, such as GTK apps' schemas and icons, beside the system's,
# where those apps find the desktop's theme.
export PATH="$HOME/.nix-profile/bin:$PATH"
export XDG_DATA_DIRS="$HOME/.nix-profile/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
