const MODULE_ID = "telys-barter-shops";
const SETTING = "shops";
const api = foundry.applications.api;
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = api;

const clone = value => foundry.utils.deepClone(value);
const uid = () => foundry.utils.randomID();
const esc = value => foundry.utils.escapeHTML(String(value ?? ""));
const shops = () => clone(game.settings.get(MODULE_ID, SETTING) ?? []).map(normalizeShop);
const saveShops = value => game.settings.set(MODULE_ID, SETTING, value);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const quantityPath = item => foundry.utils.hasProperty(item, "system.quantity") ? "system.quantity" : null;
const itemQuantity = item => {
  const raw = foundry.utils.getProperty(item, "system.quantity");
  return Math.max(0, number(typeof raw === "object" ? raw?.value : raw, 1));
};
const currency = actor => clone(foundry.utils.getProperty(actor, "system.currency") ?? {});
const actorForUser = user => canvas?.tokens?.controlled?.[0]?.actor ?? user.character ?? null;
const canAccess = (shop, user) => user.isGM || shop.access === "all" || (shop.users ?? []).includes(user.id);

function blankShop() {
  return {
    id: uid(), name: "New Shop", description: "", image: "icons/svg/coins.svg", vendorImage: "icons/svg/mystery-man.svg", open: true,
    access: "all", users: [], markup: 1, tileSize: 220,
    till: { currency: { gp: 1000 }, items: [] },
    buyback: { enabled: true, rate: 0.5, denomination: "gp" }, listings: []
  };
}

function normalizeShop(shop) {
  if (!shop.image || shop.image === "icons/svg/shop.svg") shop.image = "icons/svg/coins.svg";
  shop.vendorImage ||= "icons/svg/mystery-man.svg";
  shop.till ||= { currency: { gp: 1000 }, items: [] };
  shop.till.currency ||= { gp: 1000 };
  shop.till.items ||= [];
  shop.listings ||= [];
  shop.offers ||= [];
  for (const listing of shop.listings) {
    listing.payment ||= "barter";
    listing.cost ||= { amount: 0, denomination: "gp", quantity: 1, name: "", type: "", uuid: "", img: "" };
  }
  return shop;
}

function itemSource(item) {
  const data = item.toObject(false);
  delete data._id;
  delete data.uuid;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  delete data._stats;
  return data;
}

function affordableCurrency(actor, denomination, total) {
  return number(foundry.utils.getProperty(actor, `system.currency.${denomination}`)) >= total;
}

function matchingItems(actor, cost) {
  return actor.items.filter(i => {
    const sourceIds = [i.flags?.[MODULE_ID]?.sourceUuid, i.flags?.core?.sourceId, i._stats?.compendiumSource, i._stats?.duplicateSource, i.getFlag?.("core", "sourceId")].filter(Boolean);
    if (cost.uuid && sourceIds.includes(cost.uuid)) return true;
    return i.name.trim().toLowerCase() === String(cost.name ?? "").trim().toLowerCase();
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
    const sourceUuid = data.uuid ?? "";
    delete data._id; delete data.uuid; delete data.folder; delete data.sort; delete data.ownership; delete data._stats;
    data.system ??= {};
    if (foundry.utils.hasProperty(data, "system.quantity")) data.system.quantity = amount;
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...(data.flags[MODULE_ID] ?? {}), sourceUuid };
    const created = await actor.createEmbeddedDocuments("Item", [data], { keepId: false });
    if (!created?.length) throw new Error("Foundry did not create the purchased item.");
  }
}

function tillItem(shop, cost) {
  return shop.till.items.find(i => (cost.uuid && i.uuid === cost.uuid) || (i.name === cost.name && (!cost.type || i.type === cost.type)));
}

function addToTill(shop, cost, quantity, source = null) {
  let entry = tillItem(shop, cost);
  if (!entry) {
    entry = { id: uid(), uuid: cost.uuid ?? "", name: cost.name, type: cost.type ?? "loot", img: source?.img ?? "icons/svg/coins.svg", quantity: 0, item: source ? { ...itemSource(source), uuid: source.uuid } : null };
    shop.till.items.push(entry);
  }
  entry.quantity = number(entry.quantity) + quantity;
}

function listingCostText(listing) {
  if (listing.payment === "barter") return `${listing.cost.quantity} × ${listing.cost.name}`;
  if (listing.payment === "both") return `${listing.cost.quantity} × ${listing.cost.name} or ${listing.cost.amount} ${String(listing.cost.denomination).toUpperCase()}`;
  return `${listing.cost.amount} ${String(listing.cost.denomination).toUpperCase()}`;
}

function notifyResult(userId, ok, message) {
  if (game.user.id === userId) ui.notifications[ok ? "info" : "error"](message);
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
  const actor = message.actorUuid ? await fromUuid(message.actorUuid) : game.actors.get(message.actorId);
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const listing = shop?.listings?.find(l => l.id === message.listingId);
  const count = Math.max(1, Math.floor(number(message.quantity, 1)));
  if (!user || !actor || !shop || !listing) throw new Error("Shop listing was not found.");
  if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You do not own that character.");
  if (!shop.open || !canAccess(shop, user)) throw new Error("This shop is closed or unavailable.");
  if (listing.stock !== null && number(listing.stock) < count) throw new Error("Not enough stock remains.");
  const allowed = ["barter", "currency", "both"].includes(listing.payment) ? listing.payment : "barter";
  const payment = allowed === "both" ? String(message.payment || "barter") : allowed;
  if (!(["barter", "currency"].includes(payment)) || (allowed !== "both" && payment !== allowed)) throw new Error("That payment method is not allowed for this listing.");
  let refund = null;
  if (payment === "currency") {
    const total = Math.ceil(number(listing.cost.amount) * number(shop.markup, 1) * count);
    if (!affordableCurrency(actor, listing.cost.denomination, total)) throw new Error("You cannot afford that purchase.");
    const current = number(foundry.utils.getProperty(actor, `system.currency.${listing.cost.denomination}`));
    await actor.update({ [`system.currency.${listing.cost.denomination}`]: current - total });
    shop.till.currency[listing.cost.denomination] = number(shop.till.currency[listing.cost.denomination]) + total;
    refund = async () => {
      const balance = number(foundry.utils.getProperty(actor, `system.currency.${listing.cost.denomination}`));
      await actor.update({ [`system.currency.${listing.cost.denomination}`]: balance + total });
      shop.till.currency[listing.cost.denomination] = Math.max(0, number(shop.till.currency[listing.cost.denomination]) - total);
    };
  } else {
    const needed = number(listing.cost.quantity, 1) * count;
    if (!listing.cost.uuid && !listing.cost.name) throw new Error("The GM has not assigned a barter currency item to this listing.");
    const matches = matchingItems(actor, listing.cost);
    const available = matches.reduce((sum, item) => sum + itemQuantity(item), 0);
    if (available < needed) throw new Error(`${actor.name} needs ${needed} × ${listing.cost.name}, but only ${available} were found.`);
    const paidSource = matches[0];
    const refundSource = { ...itemSource(paidSource), uuid: listing.cost.uuid || paidSource.uuid };
    await removeItemQuantity(actor, matches, needed);
    addToTill(shop, listing.cost, needed, paidSource);
    refund = async () => {
      await addItemQuantity(actor, refundSource, needed);
      const till = tillItem(shop, listing.cost);
      if (till) till.quantity = Math.max(0, number(till.quantity) - needed);
    };
  }
  try {
    await addItemQuantity(actor, listing.item, number(listing.bundle, 1) * count);
  } catch (error) {
    await refund?.();
    throw error;
  }
  if (listing.stock !== null) listing.stock = number(listing.stock) - count;
  await saveShops(all);
  notifyResult(user.id, true, `Purchased ${count * number(listing.bundle, 1)} × ${listing.item.name}.`);
}

async function handleSell(message) {
  const user = game.users.get(message.userId);
  const actor = message.actorUuid ? await fromUuid(message.actorUuid) : game.actors.get(message.actorId);
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
  const denomination = shop.buyback.denomination || "gp";
  if (number(shop.till.currency[denomination]) < payout) throw new Error("The merchant does not have enough money for this buyback.");
  const soldSource = { ...itemSource(item), uuid: item.uuid };
  await removeItemQuantity(actor, [item], count);
  const current = number(foundry.utils.getProperty(actor, `system.currency.${denomination}`));
  await actor.update({ [`system.currency.${denomination}`]: current + payout });
  shop.till.currency[denomination] = number(shop.till.currency[denomination]) - payout;
  const resale = shop.listings.find(l => l.item?.name === soldSource.name && l.item?.type === soldSource.type);
  if (resale) resale.stock = number(resale.stock) + count;
  else shop.listings.push({ id: uid(), item: soldSource, bundle: 1, stock: count, payment: "currency", cost: { amount: Math.max(1, base), denomination, quantity: 1, name: "", type: "", uuid: "" } });
  await saveShops(all);
  notifyResult(user.id, true, `Sold ${count} × ${item.name} for ${payout} ${denomination.toUpperCase()}.`);
}

async function handleSubmitOffer(message) {
  const user = game.users.get(message.userId);
  const actor = message.actorUuid ? await fromUuid(message.actorUuid) : game.actors.get(message.actorId);
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const listing = shop?.listings?.find(l => l.id === message.listingId);
  const requestedQuantity = Math.max(1, Math.floor(number(message.quantity, 1)));
  if (!user || !actor || !shop || !listing) throw new Error("The Best Offer listing was not found.");
  if (listing.payment !== "bestOffer") throw new Error("This listing is not accepting Best Offers.");
  if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You do not own that character.");
  if (!shop.open || !canAccess(shop, user)) throw new Error("This shop is closed or unavailable.");
  if (listing.stock !== null && requestedQuantity > number(listing.stock)) throw new Error("Not enough stock remains.");
  const offeredItems = [];
  for (const offered of message.items ?? []) {
    const item = actor.items.get(offered.itemId);
    const quantity = Math.max(1, Math.floor(number(offered.quantity, 1)));
    if (!item || itemQuantity(item) < quantity) throw new Error(`You no longer have enough ${offered.name || "of an offered item"}.`);
    offeredItems.push({ itemId: item.id, uuid: item.uuid, name: item.name, type: item.type, img: item.img, quantity });
  }
  const gold = Math.max(0, Math.floor(number(message.gold, 0)));
  if (number(foundry.utils.getProperty(actor, "system.currency.gp")) < gold) throw new Error("You do not have that much gold.");
  if (!offeredItems.length && gold <= 0) throw new Error("A Best Offer must include at least one Item or some gold.");
  shop.offers.push({ id: uid(), userId: user.id, actorId: actor.id, actorUuid: actor.uuid, actorName: actor.name, listingId: listing.id, listingName: listing.item.name, listingImg: listing.item.img, requestedQuantity, items: offeredItems, gold, createdAt: Date.now() });
  await saveShops(all);
  notifyResult(user.id, true, `Best Offer submitted for ${listing.item.name}.`);
}

async function handleOfferDecision(message, accepted) {
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const offer = shop?.offers?.find(o => o.id === message.offerId);
  if (!shop || !offer) throw new Error("That Best Offer no longer exists.");
  if (!accepted) {
    shop.offers = shop.offers.filter(o => o.id !== offer.id);
    await saveShops(all);
    notifyResult(offer.userId, false, `Your Best Offer for ${offer.listingName} was denied.`);
    return;
  }
  const actor = offer.actorUuid ? await fromUuid(offer.actorUuid) : game.actors.get(offer.actorId);
  const listing = shop.listings.find(l => l.id === offer.listingId);
  if (!actor || !listing) throw new Error("The buyer or listing no longer exists.");
  if (listing.stock !== null && number(listing.stock) < offer.requestedQuantity) throw new Error("The shop no longer has enough stock.");
  const deductions = [];
  for (const offered of offer.items) {
    const item = actor.items.get(offered.itemId);
    if (!item || itemQuantity(item) < offered.quantity) throw new Error(`${actor.name} no longer has enough ${offered.name}.`);
    deductions.push({ item, quantity: offered.quantity, source: { ...itemSource(item), uuid: offered.uuid } });
  }
  const goldBalance = number(foundry.utils.getProperty(actor, "system.currency.gp"));
  if (goldBalance < offer.gold) throw new Error(`${actor.name} no longer has enough gold.`);
  for (const deduction of deductions) await removeItemQuantity(actor, [deduction.item], deduction.quantity);
  if (offer.gold > 0) await actor.update({ "system.currency.gp": goldBalance - offer.gold });
  try {
    await addItemQuantity(actor, listing.item, number(listing.bundle, 1) * offer.requestedQuantity);
  } catch (error) {
    for (const deduction of deductions) await addItemQuantity(actor, deduction.source, deduction.quantity);
    if (offer.gold > 0) await actor.update({ "system.currency.gp": goldBalance });
    throw error;
  }
  for (const deduction of deductions) addToTill(shop, { uuid: deduction.source.uuid, name: deduction.source.name, type: deduction.source.type }, deduction.quantity, deduction.item);
  shop.till.currency.gp = number(shop.till.currency.gp) + offer.gold;
  if (listing.stock !== null) listing.stock = number(listing.stock) - offer.requestedQuantity;
  shop.offers = shop.offers.filter(o => o.id !== offer.id);
  await saveShops(all);
  notifyResult(offer.userId, true, `Your Best Offer was accepted. You received ${number(listing.bundle, 1) * offer.requestedQuantity} × ${listing.item.name}.`);
}

async function gmMessage(message) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  transactionQueue = transactionQueue.then(async () => {
    try {
      if (message.action === "purchase") await handlePurchase(message);
      if (message.action === "sell") await handleSell(message);
      if (message.action === "submitOffer") await handleSubmitOffer(message);
      if (message.action === "acceptOffer") await handleOfferDecision(message, true);
      if (message.action === "denyOffer") await handleOfferDecision(message, false);
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
    actions: { choose: ShopBrowser.choose, buy: ShopBrowser.buy, submitOffer: ShopBrowser.submitOffer, removeOfferItem: ShopBrowser.removeOfferItem, sell: ShopBrowser.sell, back: ShopBrowser.back, windowClose: ShopBrowser.windowClose, windowMinimize: ShopBrowser.windowMinimize }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/browser.hbs` } };
  constructor(options = {}) { super(options); this.shopId = options.shopId ?? null; this.offerDrafts = new Map(); }
  async _prepareContext() {
    const available = shops().filter(s => canAccess(s, game.user));
    const shop = available.find(s => s.id === this.shopId) ?? null;
    const actor = actorForUser(game.user);
    return {
      shops: available.map(s => ({ ...s, closed: !s.open, cardImage: s.vendorImage || s.image })), shop,
      listings: (shop?.listings ?? []).map(l => ({ ...l, costText: listingCostText(l), showPaymentChoice: l.payment === "both", isBestOffer: l.payment === "bestOffer", draftItems: this.offerDrafts.get(l.id) ?? [], soldOut: l.stock !== null && number(l.stock) <= 0, quantityOptions: Array.from({ length: Math.min(10, l.stock === null ? 10 : Math.max(1, number(l.stock))) }, (_, i) => i + 1) })),
      actor, inventory: actor?.items.filter(i => itemQuantity(i) > 0).map(i => ({ id: i.id, name: i.name, img: i.img, quantity: itemQuantity(i), value: number(foundry.utils.getProperty(i, "system.price.value")) })) ?? [],
      canSell: !!shop?.buyback?.enabled, tileSize: shop?.tileSize ?? 220,
      merchantCoins: Object.entries(shop?.till?.currency ?? {}).filter(([, value]) => number(value) > 0).map(([key, value]) => ({ key: key.toUpperCase(), value })),
      merchantItems: (shop?.till?.items ?? []).filter(i => number(i.quantity) > 0)
    };
  }
  _onRender(context, options) {
    super._onRender(context, options);
    for (const drop of this.element.querySelectorAll(".tbs-offer-drop")) {
      drop.addEventListener("dragover", event => event.preventDefault());
      drop.addEventListener("drop", event => this._dropOffer(event));
    }
  }
  async _dropOffer(event) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data.type !== "Item") return ui.notifications.warn("Only Items can be added to a Best Offer.");
    const actor = actorForUser(game.user);
    const item = await fromUuid(data.uuid);
    const listingId = event.target.closest("[data-offer-listing-id]")?.dataset.offerListingId;
    if (!actor || !item || item.parent?.id !== actor.id) return ui.notifications.warn("Drag an Item from the selected character's inventory.");
    const draft = this.offerDrafts.get(listingId) ?? [];
    const existing = draft.find(i => i.itemId === item.id);
    if (existing) existing.max = itemQuantity(item);
    else draft.push({ itemId: item.id, name: item.name, img: item.img, max: itemQuantity(item), quantity: 1 });
    this.offerDrafts.set(listingId, draft);
    this.render({ force: true });
  }
  static windowClose() { this.close(); }
  static windowMinimize() { this.minimize(); }
  static choose(event, target) { this.shopId = target.dataset.shopId; this.render({ force: true }); }
  static back() { this.shopId = null; this.render({ force: true }); }
  static async buy(event, target) {
    const actor = actorForUser(game.user);
    if (!actor) return ui.notifications.warn("Select a token or assign a character first.");
    const listing = shops().find(s => s.id === this.shopId)?.listings.find(l => l.id === target.dataset.listingId);
    if (!listing) return ui.notifications.error("That listing no longer exists.");
    const card = target.closest(".tbs-product");
    const shortcut = Math.floor(number(card?.querySelector("[data-bulk-quantity]")?.value, 0));
    const selected = Math.floor(number(card?.querySelector("[data-quantity-select]")?.value, 1));
    const quantity = Math.max(1, shortcut || selected);
    if (listing.stock !== null && quantity > number(listing.stock)) return ui.notifications.warn(`Only ${listing.stock} remain in stock.`);
    const payment = card?.querySelector("[data-payment-select]")?.value || listing.payment;
    sendRequest({ action: "purchase", userId: game.user.id, actorId: actor.id, actorUuid: actor.uuid, shopId: this.shopId, listingId: target.dataset.listingId, quantity, payment });
  }
  static removeOfferItem(event, target) {
    const draft = this.offerDrafts.get(target.dataset.listingId) ?? [];
    this.offerDrafts.set(target.dataset.listingId, draft.filter(i => i.itemId !== target.dataset.itemId));
    this.render({ force: true });
  }
  static submitOffer(event, target) {
    const actor = actorForUser(game.user);
    if (!actor) return ui.notifications.warn("Select a character token or assign a character first.");
    const card = target.closest(".tbs-product");
    const listingId = target.dataset.listingId;
    const shortcut = Math.floor(number(card?.querySelector("[data-bulk-quantity]")?.value, 0));
    const selected = Math.floor(number(card?.querySelector("[data-quantity-select]")?.value, 1));
    const quantity = Math.max(1, shortcut || selected);
    const gold = Math.max(0, Math.floor(number(card?.querySelector("[data-offer-gold]")?.value, 0)));
    const draft = this.offerDrafts.get(listingId) ?? [];
    const items = draft.map(item => ({ itemId: item.itemId, name: item.name, quantity: Math.min(item.max, Math.max(1, Math.floor(number(card?.querySelector(`[data-offer-item-id="${item.itemId}"]`)?.value, 1)))) }));
    sendRequest({ action: "submitOffer", userId: game.user.id, actorId: actor.id, actorUuid: actor.uuid, shopId: this.shopId, listingId, quantity, gold, items });
    this.offerDrafts.delete(listingId);
    this.render({ force: true });
  }
  static async sell(event, target) {
    const actor = actorForUser(game.user);
    const item = actor?.items.get(target.dataset.itemId);
    if (!actor || !item) return;
    const quantity = await DialogV2.prompt({ window: { title: `Sell ${item.name}` }, content: `<label>Quantity <input type="number" name="quantity" min="1" max="${itemQuantity(item)}" value="1"></label>`, ok: { label: "Sell", callback: (event, button, dialog) => number(new FormData(dialog.form).get("quantity"), 1) } });
    if (!quantity) return;
    sendRequest({ action: "sell", userId: game.user.id, actorId: actor.id, actorUuid: actor.uuid, shopId: this.shopId, itemId: item.id, quantity });
  }
}

class ShopManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tbs-manager", classes: ["tbs", "tbs-manager"], tag: "section",
    position: { width: 1100, height: 760 }, window: { resizable: true, title: "Manage Barter Shops", icon: "fa-solid fa-shop-lock" },
    actions: { create: ShopManager.create, select: ShopManager.select, remove: ShopManager.remove, save: ShopManager.save, removeListing: ShopManager.removeListing, removeCurrency: ShopManager.removeCurrency, acceptOffer: ShopManager.acceptOffer, denyOffer: ShopManager.denyOffer, windowClose: ShopManager.windowClose, windowMinimize: ShopManager.windowMinimize }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/manager.hbs` } };
  constructor(options = {}) { super(options); this.shopId = null; }
  async _prepareContext() {
    const all = shops();
    const shop = all.find(s => s.id === this.shopId) ?? all[0] ?? null;
    if (shop) this.shopId = shop.id;
    const offers = (shop?.offers ?? []).map(o => ({ ...o, summary: [...o.items.map(i => `${i.quantity} × ${i.name}`), ...(o.gold ? [`${o.gold} GP`] : [])].join(", ") }));
    return { shops: all, shop, offers, users: game.users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name, checked: shop?.users?.includes(u.id) })) };
  }
  static windowClose() { this.close(); }
  static windowMinimize() { this.minimize(); }
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector(".tbs-listings")?.addEventListener("drop", e => this._drop(e));
    this.element.querySelector(".tbs-listings")?.addEventListener("dragover", e => e.preventDefault());
    this.element.querySelector(".tbs-currency-drop")?.addEventListener("drop", e => this._drop(e));
    this.element.querySelector(".tbs-currency-drop")?.addEventListener("dragover", e => e.preventDefault());
  }
  async _drop(event) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (data.type !== "Item") return;
    const item = await fromUuid(data.uuid);
    if (!item) return;
    const all = shops(); const shop = all.find(s => s.id === this.shopId); if (!shop) return;
    if (event.target.closest(".tbs-currency-drop")) {
      addToTill(shop, { uuid: item.uuid, name: item.name, type: item.type }, itemQuantity(item), item);
      await saveShops(all); this.render({ force: true }); return;
    }
    const costTarget = event.target.closest("[data-cost-listing-id]");
    if (costTarget) {
      const listing = shop.listings.find(l => l.id === costTarget.dataset.costListingId);
      if (!listing) return;
      listing.payment = "barter";
      listing.cost = { ...listing.cost, name: item.name, type: item.type, uuid: item.uuid, img: item.img, quantity: Math.max(1, number(listing.cost?.quantity, 1)) };
      await saveShops(all); this.render({ force: true }); return;
    }
    shop.listings.push({ id: uid(), item: { ...itemSource(item), uuid: item.uuid }, bundle: 1, stock: null, payment: "barter", cost: { amount: number(item.system?.price?.value, 1) || 1, denomination: item.system?.price?.denomination ?? "gp", quantity: 1, name: "", type: "", uuid: "", img: "" } });
    await saveShops(all); this.render({ force: true });
  }
  static async create() { const all = shops(); const shop = blankShop(); all.push(shop); await saveShops(all); this.shopId = shop.id; this.render({ force: true }); }
  static select(event, target) { this.shopId = target.dataset.shopId; this.render({ force: true }); }
  static async remove() {
    const yes = await DialogV2.confirm({ window: { title: "Delete Shop" }, content: "<p>Delete this shop permanently?</p>" });
    if (!yes) return; const all = shops().filter(s => s.id !== this.shopId); await saveShops(all); this.shopId = all[0]?.id ?? null; this.render({ force: true });
  }
  static async removeListing(event, target) { const all = shops(); const shop = all.find(s => s.id === this.shopId); shop.listings = shop.listings.filter(l => l.id !== target.dataset.listingId); await saveShops(all); this.render({ force: true }); }
  static async removeCurrency(event, target) { const all = shops(); const shop = all.find(s => s.id === this.shopId); shop.till.items = shop.till.items.filter(i => i.id !== target.dataset.currencyId); await saveShops(all); this.render({ force: true }); }
  static acceptOffer(event, target) { const offer = shops().find(s => s.id === this.shopId)?.offers.find(o => o.id === target.dataset.offerId); if (offer) gmMessage({ action: "acceptOffer", userId: offer.userId, shopId: this.shopId, offerId: offer.id }); }
  static denyOffer(event, target) { const offer = shops().find(s => s.id === this.shopId)?.offers.find(o => o.id === target.dataset.offerId); if (offer) gmMessage({ action: "denyOffer", userId: offer.userId, shopId: this.shopId, offerId: offer.id }); }
  static async save() {
    const form = this.element.querySelector("form"); const fd = new FormData(form); const all = shops(); const shop = all.find(s => s.id === this.shopId); if (!shop) return;
    shop.name = String(fd.get("name") || "Unnamed Shop"); shop.description = String(fd.get("description") || ""); shop.image = String(fd.get("image") || "icons/svg/coins.svg"); shop.vendorImage = String(fd.get("vendorImage") || "icons/svg/mystery-man.svg");
    shop.open = fd.has("open"); shop.access = String(fd.get("access")); shop.users = fd.getAll("users"); shop.markup = Math.max(0, number(fd.get("markup"), 1)); shop.tileSize = Math.min(360, Math.max(160, number(fd.get("tileSize"), 220)));
    shop.buyback = { enabled: fd.has("buybackEnabled"), rate: Math.max(0, number(fd.get("buybackRate"), 0.5)), denomination: String(fd.get("buybackDenomination") || "gp") };
    shop.till.currency.gp = Math.max(0, number(fd.get("merchantGp"), 0));
    for (const entry of shop.till.items) entry.quantity = Math.max(0, number(fd.get(`currency.${entry.id}.quantity`), entry.quantity));
    for (const listing of shop.listings) {
      const p = `listing.${listing.id}.`; listing.bundle = Math.max(1, number(fd.get(p + "bundle"), 1));
      const stockRaw = String(fd.get(p + "stock") ?? "").trim(); listing.stock = stockRaw === "" ? null : Math.max(0, Math.floor(number(stockRaw)));
      listing.payment = String(fd.get(p + "payment") || "barter"); listing.cost.amount = Math.max(0, number(fd.get(p + "amount"))); listing.cost.denomination = String(fd.get(p + "denomination") || "gp"); listing.cost.quantity = Math.max(1, number(fd.get(p + "quantity"), 1)); listing.cost.name = String(fd.get(p + "costName") || ""); listing.cost.type = String(fd.get(p + "costType") || "");
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
    if (message.action === "result" && message.userId === game.user.id) ui.notifications[message.ok ? "info" : "error"](message.message);
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
