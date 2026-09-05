# Tely's Barter Shops

A Foundry Virtual Tabletop v14 module for D&D 5e that creates player-facing shops with item barter, normal character currency, stock, markup, buyback, access controls, and a resizable tile-based storefront.

## Install

Paste this manifest URL into **Setup → Add-on Modules → Install Module**:

`https://github.com/Telynor/telys-barter-shops/releases/latest/download/manifest.json`

For local testing, copy the `telys-barter-shops` folder into Foundry's `Data/modules` folder, restart Foundry, and enable **Tely's Barter Shops** in your world.

## GM quick start

1. Click the shop icon in the scene controls and choose **Manage Shops**.
2. Create a shop.
3. Drag Items from the Items sidebar or a compendium into **Stock & prices**.
4. Choose Currency or Item barter for each listing and set its cost.
5. Set access and switch **Open for business** on.
6. Save. Players use **Open Shops** under the same scene-control icon.

## Important behavior

- A listing's blank stock value means unlimited stock.
- Currency names are D&D 5e currency keys such as `gp`, `sp`, and `cp`.
- Barter currently matches an owned item by exact name and optionally item type.
- Price markup applies to currency purchases. `1.25` means 25% above the listed price.
- Buyback pays a percentage of an item's D&D 5e `system.price.value` into the configured denomination.
- Purchase and sale requests are validated and executed by the active GM client.

## Release packaging

The included GitHub Actions workflow creates the ZIP and publishes `manifest.json`, `module.json`, and `telys-barter-shops.zip` whenever a version tag such as `v0.1.0` is pushed.
