const MODULE_ID = "telys-barter-shops";
const SETTING = "shops";
const api = foundry.applications.api;
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = api;

const clone = value => foundry.utils.deepClone(value);
const uid = () => foundry.utils.randomID();
const esc = value => foundry.utils.escapeHTML(String(value ?? ""));
const shops = () => clone(game.settings.get(MODULE_ID, SETTING) ?? []);
const saveShops = value => game.settings.set(MODULE_ID, SETTING, value);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const quantityPath = item => foundry.utils.hasProperty(item, "system.quantity") ? "system.quantity" : null;
const itemQuantity = item => Math.max(0, number(foundry.utils.getProperty(item, "system.quantity"), 1));
const currency = actor => clone(foundry.utils.getProperty(actor, "system.currency") ?? {});
const actorForUser = user => user.character ?? canvas?.tokens?.controlled?.[0]?.actor ?? null;
const canAccess = (shop, user) => user.isGM || shop.access === "all" || (shop.users ?? []).includes(user.id);

function blankShop() {
  return {
    id: uid(), name: "New Shop", description: "", image: "icons/svg/shop.svg", open: true,
    access: "all", users: [], markup: 1, tileSize: 220,
    buyback: { enabled: true, rate: 0.5, denomination: "gp" }, listings: []
  };
}

function itemSource(item) {
  const data = item.toObject();
  delete data._id;
  return data;
}

function affordableCurrency(actor, denomination, total) {
  return number(foundry.utils.getProperty(actor, `system.currency.${denomination}`)) >= total;
}

function matchingItems(actor, cost) {
  return actor.items.filter(i => {
    if (cost.uuid && i.flags?.[MODULE_ID]?.sourceUuid === cost.uuid) return true;
    return i.name.trim().toLowerCase() === String(cost.name ?? "").trim().toLowerCase()
      && (!cost.type || i.type === cost.type);
  });
}

async function removeItemQuantity(actor, candidates, amount) {
  let remaining = amount;
  const updates = [];
  const deletes = [];
  for (const item of candidates) {
    if (remaining <= 0) break;
    const q = itemQuantity(item);
    const take = Math.min(q, remaining);
    remaining -= take;
    if (take === q) deletes.push(item.id);
    else updates.push({ _id: item.id, "system.quantity": q - take });
  }
  if (remaining > 0) throw new Error("Required barter items are no longer available.");
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes);
}

async function addItemQuantity(actor, source, amount) {
  const signature = `${source.name}|${source.type}`.toLowerCase();
  const existing = actor.items.find(i => `${i.name}|${i.type}`.toLowerCase() === signature);
  if (existing && quantityPath(existing)) {
    await existing.update({ "system.quantity": itemQuantity(existing) + amount });
  } else {
    const data = clone(source);
    data.system ??= {};
    if (foundry.utils.hasProperty(data, "system.quantity")) data.system.quantity = amount;
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...(data.flags[MODULE_ID] ?? {}), sourceUuid: source.uuid ?? "" };
    await actor.createEmbeddedDocuments("Item", [data]);
  }
}

function listingCostText(listing) {
  if (listing.payment === "barter") return `${listing.cost.quantity} × ${listing.cost.name}`;
  return `${listing.cost.amount} ${String(listing.cost.denomination).toUpperCase()}`;
}

function notifyResult(userId, ok, message) {
  if (game.user.id === userId) (ok ? ui.notifications.info : ui.notifications.error)(message);
  else game.socket.emit(`module.${MODULE_ID}`, { action: "result", userId, ok, message });
}

function sendRequest(message) {
  if (!game.users.activeGM) return ui.notifications.error("A Game Master must be connected to process shop transactions.");
  if (game.users.activeGM.id === game.user.id) gmMessage(message);
  else game.socket.emit(`module.${MODULE_ID}`, message);
}

let transactionQueue = Promise.resolve();
async function handlePurchase(message) {
  const user = game.users.get(message.userId);
  const actor = game.actors.get(message.actorId);
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const listing = shop?.listings?.find(l => l.id === message.listingId);
  const count = Math.max(1, Math.floor(number(message.quantity, 1)));
  if (!user || !actor || !shop || !listing) throw new Error("Shop listing was not found.");
  if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You do not own that character.");
  if (!shop.open || !canAccess(shop, user)) throw new Error("This shop is closed or unavailable.");
  if (listing.stock !== null && number(listing.stock) < count) throw new Error("Not enough stock remains.");
  if (listing.payment === "currency") {
    const total = Math.ceil(number(listing.cost.amount) * number(shop.markup, 1) * count);
    if (!affordableCurrency(actor, listing.cost.denomination, total)) throw new Error("You cannot afford that purchase.");
    const current = number(foundry.utils.getProperty(actor, `system.currency.${listing.cost.denomination}`));
    await actor.update({ [`system.currency.${listing.cost.denomination}`]: current - total });
  } else {
    const needed = number(listing.cost.quantity, 1) * count;
    const matches = matchingItems(actor, listing.cost);
    if (matches.reduce((sum, item) => sum + itemQuantity(item), 0) < needed) throw new Error("You do not have enough barter items.");
    await removeItemQuantity(actor, matches, needed);
  }
  await addItemQuantity(actor, listing.item, number(listing.bundle, 1) * count);
  if (listing.stock !== null) listing.stock = number(listing.stock) - count;
  await saveShops(all);
  notifyResult(user.id, true, `Purchased ${count * number(listing.bundle, 1)} × ${listing.item.name}.`);
}

async function handleSell(message) {
  const user = game.users.get(message.userId);
  const actor = game.actors.get(message.actorId);
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const item = actor?.items.get(message.itemId);
  const count = Math.max(1, Math.floor(number(message.quantity, 1)));
  if (!user || !actor || !shop || !item) throw new Error("The item could not be sold.");
  if (!shop.open || !shop.buyback?.enabled || !canAccess(shop, user)) throw new Error("This shop is not buying items.");
  if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You do not own that character.");
  if (itemQuantity(item) < count) throw new Error("You do not have that many items.");
  const base = number(foundry.utils.getProperty(item, "system.price.value"), 0);
  const payout = Math.floor(base * number(shop.buyback.rate, 0.5) * count);
  if (payout <= 0) throw new Error("This item has no buyback value.");
  await removeItemQuantity(actor, [item], count);
  const denomination = shop.buyback.denomination || "gp";
  const current = number(foundry.utils.getProperty(actor, `system.currency.${denomination}`));
  await actor.update({ [`system.currency.${denomination}`]: current + payout });
  notifyResult(user.id, true, `Sold ${count} × ${item.name} for ${payout} ${denomination.toUpperCase()}.`);
}

async function gmMessage(message) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  transactionQueue = transactionQueue.then(async () => {
    try {
      if (message.action === "purchase") await handlePurchase(message);
      if (message.action === "sell") await handleSell(message);
    } catch (error) {
      console.error(`${MODULE_ID} | Transaction failed`, error);
      notifyResult(message.userId, false, error.message);
    }
  });
}

class ShopBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tbs-browser", classes: ["tbs", "tbs-browser"], tag: "section",
    position: { width: 980, height: 720 }, window: { resizable: true, title: "Tely's Barter Shops", icon: "fa-solid fa-store" },
    actions: { choose: ShopBrowser.choose, buy: ShopBrowser.buy, sell: ShopBrowser.sell, back: ShopBrowser.back }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/browser.hbs` } };
  constructor(options = {}) { super(options); this.shopId = options.shopId ?? null; }
  async _prepareContext() {
    const available = shops().filter(s => canAccess(s, game.user));
    const shop = available.find(s => s.id === this.shopId) ?? null;
    const actor = actorForUser(game.user);
    return {
      shops: available.map(s => ({ ...s, closed: !s.open })), shop,
      listings: (shop?.listings ?? []).map(l => ({ ...l, costText: listingCostText(l), soldOut: l.stock !== null && number(l.stock) <= 0 })),
      actor, inventory: actor?.items.filter(i => itemQuantity(i) > 0).map(i => ({ id: i.id, name: i.name, img: i.img, quantity: itemQuantity(i), value: number(foundry.utils.getProperty(i, "system.price.value")) })) ?? [],
      canSell: !!shop?.buyback?.enabled, tileSize: shop?.tileSize ?? 220
    };
  }
  static choose(event, target) { this.shopId = target.dataset.shopId; this.render({ force: true }); }
  static back() { this.shopId = null; this.render({ force: true }); }
  static async buy(event, target) {
    const actor = actorForUser(game.user);
    if (!actor) return ui.notifications.warn("Select a token or assign a character first.");
    const listing = shops().find(s => s.id === this.shopId)?.listings.find(l => l.id === target.dataset.listingId);
    const max = listing?.stock === null ? 99 : Math.max(1, number(listing?.stock, 1));
    const quantity = await DialogV2.prompt({ window: { title: "Purchase" }, content: `<label>Quantity <input type="number" name="quantity" min="1" max="${max}" value="1"></label>`, ok: { label: "Buy", callback: (event, button, dialog) => number(new FormData(dialog.form).get("quantity"), 1) } });
    if (!quantity) return;
    sendRequest({ action: "purchase", userId: game.user.id, actorId: actor.id, shopId: this.shopId, listingId: target.dataset.listingId, quantity });
    ui.notifications.info("Purchase request sent.");
  }
  static async sell(event, target) {
    const actor = actorForUser(game.user);
    const item = actor?.items.get(target.dataset.itemId);
    if (!actor || !item) return;
    const quantity = await DialogV2.prompt({ window: { title: `Sell ${item.name}` }, content: `<label>Quantity <input type="number" name="quantity" min="1" max="${itemQuantity(item)}" value="1"></label>`, ok: { label: "Sell", callback: (event, button, dialog) => number(new FormData(dialog.form).get("quantity"), 1) } });
    if (!quantity) return;
    sendRequest({ action: "sell", userId: game.user.id, actorId: actor.id, shopId: this.shopId, itemId: item.id, quantity });
  }
}

class ShopManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tbs-manager", classes: ["tbs", "tbs-manager"], tag: "section",
    position: { width: 1100, height: 760 }, window: { resizable: true, title: "Manage Barter Shops", icon: "fa-solid fa-shop-lock" },
    actions: { create: ShopManager.create, select: ShopManager.select, remove: ShopManager.remove, save: ShopManager.save, removeListing: ShopManager.removeListing }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/manager.hbs` } };
  constructor(options = {}) { super(options); this.shopId = null; }
  async _prepareContext() {
    const all = shops();
    const shop = all.find(s => s.id === this.shopId) ?? all[0] ?? null;
    if (shop) this.shopId = shop.id;
    return { shops: all, shop, users: game.users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name, checked: shop?.users?.includes(u.id) })) };
  }
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector(".tbs-listings")?.addEventListener("drop", e => this._drop(e));
    this.element.querySelector(".tbs-listings")?.addEventListener("dragover", e => e.preventDefault());
  }
  async _drop(event) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data.type !== "Item") return;
    const item = await fromUuid(data.uuid);
    if (!item) return;
    const all = shops(); const shop = all.find(s => s.id === this.shopId); if (!shop) return;
    const costTarget = event.target.closest("[data-cost-listing-id]");
    if (costTarget) {
      const listing = shop.listings.find(l => l.id === costTarget.dataset.costListingId);
      if (!listing) return;
      listing.payment = "barter";
      listing.cost = { ...listing.cost, name: item.name, type: item.type, uuid: item.uuid, quantity: Math.max(1, number(listing.cost?.quantity, 1)) };
      await saveShops(all); this.render({ force: true }); return;
    }
    shop.listings.push({ id: uid(), item: { ...itemSource(item), uuid: item.uuid }, bundle: 1, stock: null, payment: "currency", cost: { amount: number(item.system?.price?.value, 1) || 1, denomination: item.system?.price?.denomination ?? "gp", quantity: 1, name: "", type: "", uuid: "" } });
    await saveShops(all); this.render({ force: true });
  }
  static async create() { const all = shops(); const shop = blankShop(); all.push(shop); await saveShops(all); this.shopId = shop.id; this.render({ force: true }); }
  static select(event, target) { this.shopId = target.dataset.shopId; this.render({ force: true }); }
  static async remove() {
    const yes = await DialogV2.confirm({ window: { title: "Delete Shop" }, content: "<p>Delete this shop permanently?</p>" });
    if (!yes) return; const all = shops().filter(s => s.id !== this.shopId); await saveShops(all); this.shopId = all[0]?.id ?? null; this.render({ force: true });
  }
  static async removeListing(event, target) { const all = shops(); const shop = all.find(s => s.id === this.shopId); shop.listings = shop.listings.filter(l => l.id !== target.dataset.listingId); await saveShops(all); this.render({ force: true }); }
  static async save() {
    const form = this.element.querySelector("form"); const fd = new FormData(form); const all = shops(); const shop = all.find(s => s.id === this.shopId); if (!shop) return;
    shop.name = String(fd.get("name") || "Unnamed Shop"); shop.description = String(fd.get("description") || ""); shop.image = String(fd.get("image") || "icons/svg/shop.svg");
    shop.open = fd.has("open"); shop.access = String(fd.get("access")); shop.users = fd.getAll("users"); shop.markup = Math.max(0, number(fd.get("markup"), 1)); shop.tileSize = Math.min(360, Math.max(160, number(fd.get("tileSize"), 220)));
    shop.buyback = { enabled: fd.has("buybackEnabled"), rate: Math.max(0, number(fd.get("buybackRate"), 0.5)), denomination: String(fd.get("buybackDenomination") || "gp") };
    for (const listing of shop.listings) {
      const p = `listing.${listing.id}.`; listing.bundle = Math.max(1, number(fd.get(p + "bundle"), 1));
      const stockRaw = String(fd.get(p + "stock") ?? "").trim(); listing.stock = stockRaw === "" ? null : Math.max(0, Math.floor(number(stockRaw)));
      listing.payment = String(fd.get(p + "payment") || "currency"); listing.cost.amount = Math.max(0, number(fd.get(p + "amount"))); listing.cost.denomination = String(fd.get(p + "denomination") || "gp"); listing.cost.quantity = Math.max(1, number(fd.get(p + "quantity"), 1)); listing.cost.name = String(fd.get(p + "costName") || ""); listing.cost.type = String(fd.get(p + "costType") || "");
    }
    await saveShops(all); ui.notifications.info("Shop saved."); this.render({ force: true });
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING, { scope: "world", config: false, type: Array, default: [] });
  game.settings.registerMenu(MODULE_ID, "manager", { name: "Manage Barter Shops", label: "Open Shop Manager", hint: "Create shops, stock listings, and set payment rules.", icon: "fa-solid fa-store", type: ShopManager, restricted: true });
  game.modules.get(MODULE_ID).api = { open: shopId => new ShopBrowser({ shopId }).render({ force: true }), manage: () => new ShopManager().render({ force: true }) };
});

Hooks.once("ready", () => {
  game.socket.on(`module.${MODULE_ID}`, message => {
    if (message.action === "result" && message.userId === game.user.id) (message.ok ? ui.notifications.info : ui.notifications.error)(message.message);
    else gmMessage(message);
  });
});

Hooks.on("getSceneControlButtons", controls => {
  const control = { name: "tbs", title: "Tely's Barter Shops", icon: "fa-solid fa-store", order: 70, visible: true, tools: {} };
  control.tools.open = { name: "open", title: "Open Shops", icon: "fa-solid fa-basket-shopping", order: 1, button: true, onChange: () => new ShopBrowser().render({ force: true }) };
  if (game.user.isGM) control.tools.manage = { name: "manage", title: "Manage Shops", icon: "fa-solid fa-gears", order: 2, button: true, onChange: () => new ShopManager().render({ force: true }) };
  if (Array.isArray(controls)) controls.push(control); else controls.tbs = control;
});

Hooks.on("updateSetting", setting => {
  if (setting.key !== `${MODULE_ID}.${SETTING}`) return;
  for (const app of ApplicationV2.instances()) if (app instanceof ShopBrowser || app instanceof ShopManager) app.render({ force: true });
});
