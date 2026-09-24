# Home Manager module: `programs.dsh-desktop`.
#
# Installs the packaged app into home.packages. Home Manager's
# targets.darwin.copyApps (the default from stateVersion 25.11) then copies it
# to ~/Applications/Home Manager Apps, where Spotlight and Launchpad find it.
#
# Name and icon are part of the build. Changing them here rebuilds the bundle;
# the Settings page inside the app can still change the window title, Dock
# icon, and About panel, but never rewrites a Nix-managed bundle.
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.dsh-desktop;
in
{
  options.programs.dsh-desktop = {
    enable = lib.mkEnableOption "the DeepSeek Harness desktop app";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default.override {
        inherit (cfg) name icon bundleId;
      };
      defaultText = lib.literalExpression "dsh-desktop.packages.\${system}.default with name, icon, and bundleId applied";
      description = "The app package. Overriding it bypasses `name`, `icon`, and `bundleId`.";
    };

    name = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "[^/:]{1,64}");
      default = null;
      example = "大燒貨";
      description = ''
        Name shown in the menu bar, Cmd-Tab, and Finder; also the `.app`
        file name. `null` keeps the default, "DeepSeek Harness".
      '';
    };

    icon = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "./icons/harness.png";
      description = "Icon as a `.png` (ideally 1024×1024) or `.icns` file. `null` keeps the default.";
    };

    dshHome = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.dsh";
      defaultText = lib.literalExpression ''"''${config.home.homeDirectory}/.dsh"'';
      readOnly = true;
      description = ''
        The DSH home the app uses (settings, credentials, sessions, and the
        home-layer `.env`). It is the CLI's `~/.dsh`, shared as upstream DSH
        Desktop does; the app boots its own `desktop` profile inside it. Use
        it to place files there, e.g. a sops template at
        `"''${config.programs.dsh-desktop.dshHome}/.env"`.
      '';
    };

    bundleId = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "[A-Za-z0-9.-]+");
      default = null;
      description = "CFBundleIdentifier. `null` keeps the default, `dev.dsh-desktop`.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.system == "aarch64-darwin";
        message = "programs.dsh-desktop: only aarch64-darwin is supported";
      }
    ];

    home.packages = [ cfg.package ];
  };
}
