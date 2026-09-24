# The packaged app, built by the same scripts/package.mjs as `pnpm package`.
#
# Inputs Nix supplies instead of the network:
#   - Electron: the official 43.0.0 release zip. Exactly this build — the
#     harness's native module checks the V8 and Node versions it was built for,
#     and nixpkgs carries neither 43.x nor the older point releases.
#   - Harness: runtime/pnpm-lock.yaml through fetchPnpmDeps, installed hoisted,
#     production only, with no install scripts (same as the non-Nix build).
#
# The bundle is re-sealed with /usr/bin/codesign. Nix's sigtool can sign
# Mach-O files but not a bundle's resource seal, and editing Info.plist breaks
# that seal. So the build is not pure: it needs the host's codesign, which is
# available because nix-darwin builds run without the sandbox by default. With
# `sandbox = true` in nix.conf, __impureHostDeps admits it.
#
# `name`, `icon`, and `bundleId` are baked in as the bundle's defaults, and the
# bundle is marked as managed by Nix, so the app never tries to rename or
# re-sign itself (the copy home-manager installs is overwritten on switch).
{
  lib,
  stdenvNoCC,
  fetchurl,
  unzip,
  nodejs_24,
  pnpm_11,
  fetchPnpmDeps,
  pnpmConfigHook,
  zstd,
  source ? ../.,
  name ? null,
  icon ? null,
  bundleId ? null,
}:

let
  manifest = lib.importJSON (source + "/package.json");
  appName = if name == null then manifest.productName else name;

  electronVersion = "43.0.0";
  electron = fetchurl {
    url = "https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-darwin-arm64.zip";
    hash = "sha256-5plPaNumWmNxV36vaKxppYWNLFI3GGmDfGSv/GFX7KU=";
  };

  runtimeSrc = lib.fileset.toSource {
    root = source + "/runtime";
    fileset = lib.fileset.unions [
      (source + "/runtime/package.json")
      (source + "/runtime/pnpm-lock.yaml")
      (source + "/runtime/pnpm-workspace.yaml")
    ];
  };

  # The bundled DSH harness as a hoisted node_modules tree.
  runtime = stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "dsh-desktop-runtime";
    version = (lib.importJSON (source + "/runtime/package.json")).dependencies."@deepseek-ai/dsh";
    src = runtimeSrc;

    pnpmDeps = fetchPnpmDeps {
      inherit (finalAttrs) pname version src;
      pnpm = pnpm_11;
      fetcherVersion = 3;
      hash = "sha256-unpv8hiZ9NqB6FO7nJP299UTDicT7B/z5RA5Db1xHRc=";
    };

    nativeBuildInputs = [
      nodejs_24
      pnpm_11
      pnpmConfigHook
      zstd
    ];

    # pnpmConfigHook runs `pnpm install --offline --frozen-lockfile
    # --ignore-scripts`; these make it the production, hoisted install the
    # packager expects. nodeLinker also comes from pnpm-workspace.yaml.
    pnpmInstallFlags = [ "--prod" ];
    env.npm_config_node_linker = "hoisted";

    dontBuild = true;
    installPhase = ''
      runHook preInstall
      rm -rf node_modules/.bin node_modules/.pnpm node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json
      mkdir -p $out
      mv node_modules $out/node_modules
      runHook postInstall
    '';

    # Prebuilt darwin-arm64 addons; nothing to patch.
    dontFixup = true;
  });
in
stdenvNoCC.mkDerivation {
  pname = "dsh-desktop";
  inherit (manifest) version;

  src = lib.fileset.toSource {
    root = source;
    fileset = lib.fileset.unions [
      (source + "/package.json")
      (source + "/src")
      (source + "/plugins")
      (source + "/assets")
      (source + "/runtime/package.json")
      (source + "/scripts/package.mjs")
    ];
  };

  nativeBuildInputs = [
    unzip
    nodejs_24
  ];

  __impureHostDeps = [
    "/usr/bin/codesign"
    "/usr/bin/ditto"
    "/usr/bin/plutil"
    "/usr/bin/sips"
    "/usr/bin/iconutil"
  ];

  env = {
    DSH_DESKTOP_APP_NAME = appName;
  }
  // lib.optionalAttrs (icon != null) { DSH_DESKTOP_ICON = "${icon}"; }
  // lib.optionalAttrs (bundleId != null) { DSH_DESKTOP_BUNDLE_ID = bundleId; };

  dontConfigure = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild

    # The packager shells out to plutil, ditto, codesign, sips, and iconutil.
    export PATH="$PATH:/usr/bin"
    # Keeps pngToIcns's cache and Electron's userData out of the store.
    export HOME="$TMPDIR/home"
    export DSH_DESKTOP_USER_DATA="$TMPDIR/user-data"

    unzip -q ${electron} -d electron Electron.app/'*'

    node scripts/package.mjs \
      --electron-app electron/Electron.app \
      --runtime-modules ${runtime}/node_modules \
      --out dist \
      --managed-by nix

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications $out/bin
    mv "dist/${appName}.app" $out/Applications/
    # A launcher rather than a symlink: Electron finds its bundle from the path
    # it was started with, and a symlink outside the bundle would hide it.
    cat > $out/bin/dsh-desktop <<EOF
    #!/bin/sh
    exec "$out/Applications/${appName}.app/Contents/MacOS/Electron" "\$@"
    EOF
    chmod +x $out/bin/dsh-desktop
    runHook postInstall
  '';

  passthru = {
    inherit runtime electron appName;
  };

  meta = {
    description = "DeepSeek Harness desktop client: an Electron shell hosting the DSH Cordis tree";
    mainProgram = "dsh-desktop";
    platforms = [ "aarch64-darwin" ];
    sourceProvenance = with lib.sourceTypes; [
      fromSource
      binaryNativeCode
    ];
  };
}
