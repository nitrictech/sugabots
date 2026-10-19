{
  description = "Sugabots development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs:
        let
          inherit (pkgs.stdenv.hostPlatform) isLinux;

          # Keep in step with the `// @hutch cli=` pin in packages/desktop/hutch.config.ts.
          # Hashes from https://hutch.blackboard.sh/hutch/releases/<version>/manifest.json.
          hutchVersion = "0.27.1";
          hutchRevision = "b40b131488097aa46f3df767b35dea81b44315fd";
          hutchArchives = {
            x86_64-linux = { platform = "linux-x64"; sha256 = "ed64b3d3f3d38d3ab04a8d178b9883571a7d62d5100b8143a89da597dc8e8d21"; };
            aarch64-linux = { platform = "linux-arm64"; sha256 = "ff3c08044fb73403455c3b25553a3033ab81e3afad9e8b8aaa8d6f791bb99376"; };
            aarch64-darwin = { platform = "macos-arm64"; sha256 = "5478ebc6ea25e93b12964615956f8a1cbaf38b9e7da38850e20e1c6aa5022e2b"; };
          };
          hutchArchive = hutchArchives.${pkgs.stdenv.hostPlatform.system};

          hutch = pkgs.stdenvNoCC.mkDerivation {
            pname = "hutch";
            version = hutchVersion;
            src = pkgs.fetchurl {
              url = "https://hutch.blackboard.sh/hutch/builds/${hutchRevision}/${hutchArchive.platform}/hutch.tar.gz";
              inherit (hutchArchive) sha256;
            };
            nativeBuildInputs = pkgs.lib.optionals isLinux [ pkgs.autoPatchelfHook ];
            installPhase = ''
              mkdir -p $out
              cp -r bin hutch-release.json $out/
            '';
          };

          # Electrobun's prebuilt launcher and native wrapper, which Hutch fetches,
          # dlopen these. Its compatibility guide lists GTK 3, WebKitGTK 4.1, Ayatana
          # AppIndicator and librsvg as required on Linux.
          electrobunLibs = with pkgs; [
            gtk3
            webkitgtk_4_1
            libayatana-appindicator
            librsvg
            libsecret
            glib
            libsoup_3
            cairo
            pango
            gdk-pixbuf
            at-spi2-atk
            stdenv.cc.cc.lib
            zlib
          ];
        in
        {
          default = pkgs.mkShell {
            packages = [ pkgs.bun pkgs.nodejs_26 hutch ];
            buildInputs = pkgs.lib.optionals isLinux (electrobunLibs ++ [ pkgs.glib-networking ]);

            # Prebuilt binaries run through nix-ld, which reads this path.
            NIX_LD_LIBRARY_PATH = pkgs.lib.optionalString isLinux (pkgs.lib.makeLibraryPath electrobunLibs);

            shellHook = pkgs.lib.optionalString isLinux ''
              # GTK aborts on file dialogs and theming without its schemas.
              export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
              # WebKitGTK's TLS comes from glib-networking; without it every https page fails.
              export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"
              # WebKitGTK's DMA-BUF renderer crashes the window with GLXBadWindow on some GPUs.
              export WEBKIT_DISABLE_DMABUF_RENDERER=1

              # The desktop app's WebKitGTK trusts only this bundle, so add Portless's
              # local CA for https://sugabots.localhost. Rerun `nix develop` after
              # Portless first creates it.
              if [ -f "$HOME/.portless/ca.pem" ]; then
                mkdir -p .temp
                cat ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt "$HOME/.portless/ca.pem" > .temp/ca-bundle.pem
                export SSL_CERT_FILE="$PWD/.temp/ca-bundle.pem"
                export NIX_SSL_CERT_FILE="$SSL_CERT_FILE"
              fi
            '';
          };
        });
    };
}
