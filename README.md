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
- Barter stores the UUID, image, name, and type of the currency Item dropped onto the listing, then matches the selected character's owned copy by source UUID or exact name and type.
- Each listing can accept barter only (the default), regular D&D 5e currency only, or either payment method.
- Players choose quantity directly on the item card or type a bulk quantity; purchasing does not open a quantity dialog.
- Best Offer listings let players offer multiple owned loot Items and/or gold without paying immediately. The GM can accept or deny; acceptance revalidates and deducts the offer, delivers the purchase, and decrements stock.
- Fixed-price Buy clicks process automatically through the active GM and only show the final result.
- Module sockets are explicitly enabled, and transactions use the selected Actor's full UUID so player purchases and synthetic-token inventories reach the GM correctly.
- Price markup applies to currency purchases. `1.25` means 25% above the listed price.
- Buyback pays a percentage of an item's D&D 5e `system.price.value` into the configured denomination.
- The dedicated Sell screen accepts a dragged inventory Item and lets the player request merchant gold and/or custom currency Items, limited by the merchant's current reserves.
- Player sales are negotiations: rejection returns the unchanged proposal for editing, acceptance moves both sides of the trade, and either side can abandon without moving anything.
- Sale proposals automatically open the GM review screen. A GM counteroffer selects only from the original offerer's carried and contained inventory, while merchant payment remains limited to shop gold and currency reserves; counteroffers automatically reopen on the player screen.
- Counteroffers can request multiple player Items. Final acceptance removes those exact Items and quantities, merges them into shop stock, and delivers only the merchant payment.
- Purchased Items receive a minimum nonzero per-item price calculated from the currency or barter value paid and the shop markup, preventing zero-value quick-buyback loops.
- Purchase and sale requests are validated and executed by the active GM client.

## Release packaging

The included GitHub Actions workflow creates the ZIP and publishes `manifest.json`, `module.json`, and `telys-barter-shops.zip` whenever a version tag such as `v0.1.0` is pushed.
