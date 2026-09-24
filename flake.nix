{
  description = "DeepSeek Harness desktop client for macOS (Apple Silicon)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      system = "aarch64-darwin";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      packages.${system} = rec {
        dsh-desktop = pkgs.callPackage ./nix/package.nix { };
        default = dsh-desktop;
      };

      homeManagerModules = rec {
        dsh-desktop = import ./nix/home-manager.nix self;
        default = dsh-desktop;
      };

      formatter.${system} = pkgs.nixfmt;
    };
}
