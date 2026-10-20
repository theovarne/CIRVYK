# Self-hosted wallet and social marks

These assets identify third-party wallet providers and user-specified social destinations. Their presence does not imply partnership or endorsement. No third-party scripts, trackers, or remote image loads are used.

## Sources

- `public/assets/wallets/phantom.svg`: decoded icon from the [Solana wallet adapter Phantom adapter](https://github.com/anza-xyz/wallet-adapter/blob/master/packages/wallets/phantom/src/adapter.ts). Byte-identical to the already saved project reference asset.
- `public/assets/wallets/solflare.svg`: decoded icon from the [Solana wallet adapter Solflare adapter](https://github.com/anza-xyz/wallet-adapter/blob/master/packages/wallets/solflare/src/adapter.ts). Byte-identical to the already saved project reference asset.
- `public/assets/wallets/coinbase.svg`: decoded icon from the [Solana wallet adapter Coinbase adapter](https://github.com/anza-xyz/wallet-adapter/blob/master/packages/wallets/coinbase/src/adapter.ts).
- `public/assets/wallets/okx.png`: official [OKX Wallet website](https://web3.okx.com/) favicon, served at `https://web3.okx.com/cdn/assets/imgs/441/655A924890DB43CDA7E79F6A9CA93434.png`. Current 64×64 green checker symbol.
- `public/assets/wallets/backpack.png`: official [Backpack Wallet website](https://backpack.app/) icon, served at `https://backpack.app/icon/128x128.png`. 128×128 red backpack symbol.
- `public/assets/social-github.svg`: official Invertocat from [GitHub logo package](https://brand.github.com/GitHub_Logos.zip), `GitHub Logos/SVG/GitHub_Invertocat_White.svg`, geometry preserved and monochrome fill adapted to the site's muted header icon color. [Brand usage](https://brand.github.com/foundations/logo) permits a social button linking to a GitHub profile or project.
- `public/assets/social-x.svg`: existing reference implementation's X silhouette, preserved and self-hosted with the same muted header icon color.

## Scope

Logos are presentation assets only. Connection availability comes from actual Wallet Standard registration or recognized injected Solana provider detection. No wallet installation or asset custody is supplied by these images. The wallet names and logos remain trademarks of their respective owners.
