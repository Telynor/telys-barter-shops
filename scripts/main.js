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

function openManagerTrade(shopId) {
  const existing = [...ApplicationV2.instances()].find(app => app instanceof ShopManager);
  const app = existing ?? new ShopManager({ shopId });
  app.shopId = shopId;
  app.render({ force: true });
}

function openPlayerTrade(shopId) {
  const existing = [...ApplicationV2.instances()].find(app => app instanceof ShopBrowser);
  const app = existing ?? new ShopBrowser({ shopId, mode: "sell" });
  app.shopId = shopId;
  app.mode = "sell";
  app.render({ force: true });
}

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
  shop.trades ||= [];
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
  const signature = `${String(source.name).trim()}|${String(source.type).trim()}`.toLowerCase();
  const existing = actor.items.find(i => `${i.name.trim()}|${i.type.trim()}`.toLowerCase() === signature);
  if (existing && quantityPath(existing)) {
    const update = { "system.quantity": itemQuantity(existing) + amount };
    const price = foundry.utils.getProperty(source, "system.price.value");
    const denomination = foundry.utils.getProperty(source, "system.price.denomination");
    if (Number.isFinite(Number(price))) update["system.price.value"] = Number(price);
    if (denomination) update["system.price.denomination"] = denomination;
    await existing.update(update);
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

function sourceWithPrice(source, value, denomination = "gp") {
  const data = clone(source);
  data.system ??= {};
  if (!data.system.price || typeof data.system.price !== "object") data.system.price = {};
  data.system.price.value = Math.max(1, Math.ceil(number(value, 0)));
  data.system.price.denomination = denomination || "gp";
  return data;
}

function tillItem(shop, cost) {
  const name = String(cost.name ?? "").trim().toLowerCase();
  const type = String(cost.type ?? "").trim().toLowerCase();
  return shop.till.items.find(i => (cost.uuid && i.uuid === cost.uuid) || (String(i.name).trim().toLowerCase() === name && (!type || String(i.type).trim().toLowerCase() === type)));
}

function matchingListing(shop, source) {
  const name = String(source.name ?? "").trim().toLowerCase();
  const type = String(source.type ?? "").trim().toLowerCase();
  return shop.listings.find(l => (source.uuid && l.item?.uuid === source.uuid) || (String(l.item?.name ?? "").trim().toLowerCase() === name && String(l.item?.type ?? "").trim().toLowerCase() === type));
}

function addPurchasedStock(shop, source, quantity, salePrice, denomination = "gp", barterCost = null) {
  const listing = matchingListing(shop, source);
  if (listing) {
    if (listing.stock !== null) listing.stock = number(listing.stock) + quantity;
    return listing;
  }
  const pricedSource = sourceWithPrice(source, salePrice, denomination);
  const cost = barterCost ? { amount: Math.max(1, Math.ceil(number(salePrice, 1))), denomination: denomination || "gp", quantity: barterCost.quantity, name: barterCost.name, type: barterCost.type, uuid: barterCost.uuid, img: barterCost.img } : { amount: Math.max(1, Math.ceil(number(salePrice, 1))), denomination: denomination || "gp", quantity: 1, name: "", type: "", uuid: "", img: "" };
  const created = { id: uid(), item: pricedSource, bundle: 1, stock: quantity, payment: barterCost ? "barter" : "currency", cost };
  shop.listings.push(created);
  return created;
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
  if (!game.users.activeGM) { ui.notifications.error("A Game Master must be connected to process shop transactions."); return false; }
  if (game.users.activeGM.id === game.user.id) gmMessage(message);
  else game.socket.emit(`module.${MODULE_ID}`, message);
  return true;
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
  let deliveredPrice = 1;
  let deliveredDenomination = "gp";
  if (payment === "currency") {
    const total = Math.ceil(number(listing.cost.amount) * number(shop.markup, 1) * count);
    if (!affordableCurrency(actor, listing.cost.denomination, total)) throw new Error("You cannot afford that purchase.");
    const current = number(foundry.utils.getProperty(actor, `system.currency.${listing.cost.denomination}`));
    await actor.update({ [`system.currency.${listing.cost.denomination}`]: current - total });
    shop.till.currency[listing.cost.denomination] = number(shop.till.currency[listing.cost.denomination]) + total;
    deliveredPrice = number(listing.cost.amount) * number(shop.markup, 1) / Math.max(1, number(listing.bundle, 1));
    deliveredDenomination = listing.cost.denomination || "gp";
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
    deliveredPrice = number(foundry.utils.getProperty(paidSource, "system.price.value"), 1) * number(listing.cost.quantity, 1) * number(shop.markup, 1) / Math.max(1, number(listing.bundle, 1));
    deliveredDenomination = foundry.utils.getProperty(paidSource, "system.price.denomination") || "gp";
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
    await addItemQuantity(actor, sourceWithPrice(listing.item, deliveredPrice, deliveredDenomination), number(listing.bundle, 1) * count);
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
  const salePrice = payout * number(shop.markup, 1) / count;
  addPurchasedStock(shop, soldSource, count, salePrice, denomination);
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
    const offeredValue = deductions.reduce((sum, d) => sum + number(foundry.utils.getProperty(d.item, "system.price.value"), 0) * d.quantity, 0) + offer.gold;
    const deliveredCount = Math.max(1, number(listing.bundle, 1) * offer.requestedQuantity);
    await addItemQuantity(actor, sourceWithPrice(listing.item, offeredValue * number(shop.markup, 1) / deliveredCount, "gp"), deliveredCount);
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

async function handleSubmitTrade(message) {
  const user = game.users.get(message.userId);
  const actor = message.actorUuid ? await fromUuid(message.actorUuid) : game.actors.get(message.actorId);
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const item = actor?.items.get(message.itemId);
  const quantity = Math.max(1, Math.floor(number(message.quantity, 1)));
  if (!user || !actor || !shop || !item) throw new Error("The character, shop, or sale Item was not found.");
  if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error("You do not own that character.");
  if (!shop.open || !canAccess(shop, user)) throw new Error("This shop is closed or unavailable.");
  if (itemQuantity(item) < quantity) throw new Error(`${actor.name} only has ${itemQuantity(item)} × ${item.name}.`);
  const gold = Math.max(0, Math.floor(number(message.gold, 0)));
  const askedItems = [];
  for (const asked of message.items ?? []) {
    const requested = Math.max(0, Math.floor(number(asked.quantity, 0)));
    if (requested <= 0) continue;
    if (asked.source === "shop") {
      const reserve = shop.till.items.find(i => i.id === asked.reserveId);
      if (reserve) askedItems.push({ source: "shop", reserveId: reserve.id, uuid: reserve.uuid, name: reserve.name, type: reserve.type, img: reserve.img, quantity: requested });
    } else {
      const listing = shop.listings.find(i => i.id === asked.listingId);
      if (listing) askedItems.push({ source: "listing", listingId: listing.id, uuid: listing.item.uuid, name: listing.item.name, type: listing.item.type, img: listing.item.img, quantity: requested });
    }
  }
  if (!gold && !askedItems.length) throw new Error("Ask for gold or at least one item from the shop.");
  const existing = message.tradeId ? shop.trades.find(t => t.id === message.tradeId && t.userId === user.id) : null;
  const trade = existing ?? { id: uid(), userId: user.id, createdAt: Date.now() };
  const sellerItems = [{ itemId: item.id, uuid: item.uuid, name: item.name, type: item.type, img: item.img, quantity }];
  Object.assign(trade, { actorId: actor.id, actorUuid: actor.uuid, actorName: actor.name, itemId: item.id, itemUuid: item.uuid, itemName: item.name, itemType: item.type, itemImg: item.img, quantity, sellerItems, gold, items: askedItems, status: "pending", updatedAt: Date.now() });
  if (!existing) shop.trades.push(trade);
  await saveShops(all);
  notifyResult(user.id, true, `Sale proposal sent to ${shop.name}.`);
  openManagerTrade(shop.id);
}

async function handleCounterTrade(message) {
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const trade = shop?.trades?.find(t => t.id === message.tradeId);
  if (!shop || !trade) throw new Error("That trade no longer exists.");
  const seller = trade.actorUuid ? await fromUuid(trade.actorUuid) : game.actors.get(trade.actorId);
  if (!seller) throw new Error("The offering character no longer exists.");
  const sellerItems = [];
  for (const selected of message.sellerItems ?? []) {
    const item = seller.items.get(selected.itemId);
    const quantity = Math.max(0, Math.floor(number(selected.quantity, 0)));
    if (!quantity) continue;
    if (!item || itemQuantity(item) < quantity) throw new Error(`${trade.actorName} does not have enough ${selected.name}.`);
    sellerItems.push({ itemId: item.id, uuid: item.uuid, name: item.name, type: item.type, img: item.img, quantity });
  }
  if (!sellerItems.length) throw new Error("Select at least one Item from the offerer's inventory.");
  const gold = Math.max(0, Math.floor(number(message.gold, 0)));
  if (number(shop.till.currency.gp) < gold) throw new Error(`${shop.name} only has ${number(shop.till.currency.gp)} GP.`);
  const items = [];
  for (const offered of message.items ?? []) {
    const quantity = Math.max(0, Math.floor(number(offered.quantity, 0)));
    if (!quantity) continue;
    if (offered.source === "shop") {
      const reserve = shop.till.items.find(i => i.id === offered.reserveId);
      if (!reserve || number(reserve.quantity) < quantity) throw new Error(`${shop.name} does not have enough ${offered.name}.`);
      items.push({ source: "shop", reserveId: reserve.id, uuid: reserve.uuid, name: reserve.name, type: reserve.type, img: reserve.img, quantity });
    } else if (offered.source === "listing") {
      const listing = shop.listings.find(i => i.id === offered.listingId);
      if (!listing || (listing.stock !== null && number(listing.stock) < quantity)) throw new Error(`${shop.name} does not have enough ${offered.name}.`);
      items.push({ source: "listing", listingId: listing.id, uuid: listing.item.uuid, name: listing.item.name, type: listing.item.type, img: listing.item.img, quantity });
    }
  }
  if (!gold && !items.length) throw new Error("A counteroffer must include gold or at least one Item.");
  trade.gold = gold;
  trade.items = items;
  trade.sellerItems = sellerItems;
  const primary = sellerItems[0];
  Object.assign(trade, { itemId: primary.itemId, itemUuid: primary.uuid, itemName: primary.name, itemType: primary.type, itemImg: primary.img, quantity: primary.quantity });
  trade.status = "counter";
  trade.updatedAt = Date.now();
  await saveShops(all);
  game.socket.emit(`module.${MODULE_ID}`, { action: "tradePrompt", userId: trade.userId, shopId: shop.id, message: `${shop.name} sent a counteroffer.` });
}

async function handlePlayerRevision(message) {
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const trade = shop?.trades?.find(t => t.id === message.tradeId);
  if (!shop || !trade) throw new Error("That trade no longer exists.");
  if (trade.userId !== message.userId) throw new Error("Only the original offerer can counter this trade.");
  if (trade.status !== "counter") throw new Error("This trade is not waiting for a player counteroffer.");
  trade.status = "playerRevision";
  trade.updatedAt = Date.now();
  await saveShops(all);
  notifyResult(trade.userId, true, "The trade is still open. Adjust your offer and submit the counteroffer.");
}

async function handlePlayerCounter(message) {
  const user = game.users.get(message.userId);
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const trade = shop?.trades?.find(t => t.id === message.tradeId);
  if (!user || !shop || !trade || trade.userId !== user.id) throw new Error("That trade no longer exists.");
  if (trade.status !== "playerRevision") throw new Error("This trade is not ready for another counteroffer.");
  const actor = trade.actorUuid ? await fromUuid(trade.actorUuid) : game.actors.get(trade.actorId);
  if (!actor || (!user.isGM && !actor.testUserPermission(user, "OWNER"))) throw new Error("You do not own the offering character.");
  const sellerItems = [];
  for (const selected of message.sellerItems ?? []) {
    const item = actor.items.get(selected.itemId);
    const quantity = Math.max(0, Math.floor(number(selected.quantity, 0)));
    if (!quantity) continue;
    if (!item || itemQuantity(item) < quantity) throw new Error(`You do not have enough ${selected.name ?? "of that item"}.`);
    sellerItems.push({ itemId: item.id, uuid: item.uuid, name: item.name, type: item.type, img: item.img, quantity });
  }
  if (!sellerItems.length) throw new Error("Select at least one item to give the merchant.");
  const gold = Math.max(0, Math.floor(number(message.gold, 0)));
  const items = [];
  for (const requested of message.items ?? []) {
    const quantity = Math.max(0, Math.floor(number(requested.quantity, 0)));
    if (!quantity) continue;
    if (requested.source === "shop") {
      const reserve = shop.till.items.find(i => i.id === requested.reserveId);
      if (reserve) items.push({ source: "shop", reserveId: reserve.id, uuid: reserve.uuid, name: reserve.name, type: reserve.type, img: reserve.img, quantity });
    } else {
      const listing = shop.listings.find(i => i.id === requested.listingId);
      if (listing) items.push({ source: "listing", listingId: listing.id, uuid: listing.item.uuid, name: listing.item.name, type: listing.item.type, img: listing.item.img, quantity });
    }
  }
  if (!gold && !items.length) throw new Error("A counteroffer must request gold or at least one shop item.");
  const primary = sellerItems[0];
  Object.assign(trade, { sellerItems, gold, items, itemId: primary.itemId, itemUuid: primary.uuid, itemName: primary.name, itemType: primary.type, itemImg: primary.img, quantity: primary.quantity, status: "pending", updatedAt: Date.now() });
  await saveShops(all);
  notifyResult(user.id, true, `Your counteroffer was sent to ${shop.name}.`);
  openManagerTrade(shop.id);
}

async function handleTradeDecision(message, decision) {
  const all = shops();
  const shop = all.find(s => s.id === message.shopId);
  const trade = shop?.trades?.find(t => t.id === message.tradeId);
  if (!shop || !trade) throw new Error("That trade no longer exists.");
  if (decision === "abandon") {
    shop.trades = shop.trades.filter(t => t.id !== trade.id);
    await saveShops(all);
    notifyResult(trade.userId, false, `The trade with ${shop.name} was abandoned.`);
    return;
  }
  if (decision === "reject") {
    trade.status = "revision";
    await saveShops(all);
    notifyResult(trade.userId, false, `${shop.name} declined the proposal. You may adjust it or abandon the trade.`);
    game.socket.emit(`module.${MODULE_ID}`, { action: "tradePrompt", userId: trade.userId, shopId: shop.id });
    return;
  }
  const actor = trade.actorUuid ? await fromUuid(trade.actorUuid) : game.actors.get(trade.actorId);
  if (!actor) throw new Error("The offering character no longer exists.");
  const saleLines = (trade.sellerItems?.length ? trade.sellerItems : [{ itemId: trade.itemId, uuid: trade.itemUuid, name: trade.itemName, type: trade.itemType, img: trade.itemImg, quantity: trade.quantity }]).map(line => {
    const item = actor.items.get(line.itemId);
    if (!item || itemQuantity(item) < line.quantity) throw new Error(`${trade.actorName} no longer has enough ${line.name}.`);
    return { line, item, source: { ...itemSource(item), uuid: line.uuid || item.uuid } };
  });
  if (number(shop.till.currency.gp) < trade.gold) throw new Error(`${shop.name} no longer has enough gold.`);
  const payouts = [];
  for (const asked of trade.items ?? []) {
    if (asked.source === "listing") {
      const listing = shop.listings.find(i => i.id === asked.listingId);
      if (!listing || (listing.stock !== null && number(listing.stock) < asked.quantity)) throw new Error(`${shop.name} no longer has enough ${asked.name}.`);
      payouts.push({ asked, listing, source: listing.item });
      continue;
    }
    const reserve = shop.till.items.find(i => i.id === asked.reserveId);
    if (!reserve || number(reserve.quantity) < asked.quantity || !reserve.item) throw new Error(`${shop.name} no longer has enough ${asked.name}.`);
    payouts.push({ asked, reserve, source: reserve.item });
  }
  for (const sale of saleLines) await removeItemQuantity(actor, [sale.item], sale.line.quantity);
  try {
    if (trade.gold > 0) {
      const balance = number(foundry.utils.getProperty(actor, "system.currency.gp"));
      await actor.update({ "system.currency.gp": balance + trade.gold });
    }
    for (const payout of payouts) await addItemQuantity(actor, payout.source, payout.asked.quantity);
  } catch (error) {
    for (const sale of saleLines) await addItemQuantity(actor, sale.source, sale.line.quantity);
    throw error;
  }
  shop.till.currency.gp = number(shop.till.currency.gp) - trade.gold;
  for (const payout of payouts) {
    if (payout.listing) { if (payout.listing.stock !== null) payout.listing.stock = number(payout.listing.stock) - payout.asked.quantity; }
    else payout.reserve.quantity = number(payout.reserve.quantity) - payout.asked.quantity;
  }
  const merchantSpend = trade.gold + payouts.reduce((sum, payout) => sum + number(foundry.utils.getProperty(payout.source, "system.price.value"), 0) * payout.asked.quantity, 0);
  const purchasedUnits = saleLines.reduce((sum, sale) => sum + sale.line.quantity, 0);
  const resalePrice = merchantSpend * number(shop.markup, 1) / Math.max(1, purchasedUnits);
  const primaryBarter = payouts[0] ?? null;
  const primaryBarterPaid = primaryBarter ? payouts.filter(p => (p.reserve?.id ?? p.listing?.id) === (primaryBarter.reserve?.id ?? primaryBarter.listing?.id)).reduce((sum, p) => sum + p.asked.quantity, 0) : 0;
  const barterCost = primaryBarter ? { quantity: Math.max(1, Math.ceil(primaryBarterPaid * number(shop.markup, 1) / Math.max(1, purchasedUnits))), name: primaryBarter.asked.name, type: primaryBarter.asked.type, uuid: primaryBarter.asked.uuid, img: primaryBarter.asked.img } : null;
  for (const sale of saleLines) {
    const registeredCurrency = tillItem(shop, sale.source);
    if (registeredCurrency) registeredCurrency.quantity = number(registeredCurrency.quantity) + sale.line.quantity;
    else addPurchasedStock(shop, sale.source, sale.line.quantity, resalePrice, "gp", barterCost);
  }
  shop.trades = shop.trades.filter(t => t.id !== trade.id);
  await saveShops(all);
  notifyResult(trade.userId, true, `${shop.name} accepted the trade for ${saleLines.map(s => `${s.line.quantity} × ${s.line.name}`).join(", ")}.`);
  game.socket.emit(`module.${MODULE_ID}`, { action: "tradeComplete", userId: trade.userId, shopId: shop.id });
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
      if (message.action === "submitTrade") await handleSubmitTrade(message);
      if (message.action === "counterTrade") await handleCounterTrade(message);
      if (message.action === "reviseTrade") await handlePlayerRevision(message);
      if (message.action === "playerCounterTrade") await handlePlayerCounter(message);
      if (message.action === "acceptTrade") await handleTradeDecision(message, "accept");
      if (message.action === "rejectTrade") await handleTradeDecision(message, "reject");
      if (message.action === "abandonTrade") await handleTradeDecision(message, "abandon");
      return true;
    } catch (error) {
      console.error(`${MODULE_ID} | Transaction failed`, error);
      notifyResult(message.userId, false, error.message);
      return false;
    }
  });
  return transactionQueue;
}

class ShopBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tbs-browser", classes: ["tbs", "tbs-browser"], tag: "section",
    position: { width: 980, height: 720 }, window: { resizable: true, title: "Tely's Barter Shops", icon: "fa-solid fa-store" },
    actions: { choose: ShopBrowser.choose, buy: ShopBrowser.buy, submitOffer: ShopBrowser.submitOffer, removeOfferItem: ShopBrowser.removeOfferItem, openSell: ShopBrowser.openSell, backToShop: ShopBrowser.backToShop, submitTrade: ShopBrowser.submitTrade, submitPlayerCounter: ShopBrowser.submitPlayerCounter, acceptCounter: ShopBrowser.acceptCounter, reviseCounter: ShopBrowser.reviseCounter, abandonTrade: ShopBrowser.abandonTrade, clearSellItem: ShopBrowser.clearSellItem, back: ShopBrowser.back, windowClose: ShopBrowser.windowClose, windowMinimize: ShopBrowser.windowMinimize }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/browser.hbs` } };
  constructor(options = {}) { super(options); this.shopId = options.shopId ?? null; this.offerDrafts = new Map(); this.mode = options.mode ?? "shop"; this.sellDraft = null; }
  async _prepareContext() {
    const available = shops().filter(s => canAccess(s, game.user));
    const shop = available.find(s => s.id === this.shopId) ?? null;
    const actor = actorForUser(game.user);
    const savedTrade = shop?.trades?.find(t => t.userId === game.user.id && (!actor || t.actorUuid === actor.uuid || t.actorId === actor.id)) ?? null;
    const trade = savedTrade ? { ...savedTrade, sellerSummary: (savedTrade.sellerItems?.length ? savedTrade.sellerItems : [{ name: savedTrade.itemName, quantity: savedTrade.quantity }]).map(i => `${i.quantity} × ${i.name}`).join(", "), requestSummary: [...(savedTrade.items ?? []).map(i => `${i.quantity} × ${i.name}`), ...(savedTrade.gold ? [`${savedTrade.gold} GP`] : [])].join(" and ") } : null;
    const sellItem = this.sellDraft ?? (trade ? { itemId: trade.itemId, name: trade.itemName, img: trade.itemImg, max: actor?.items.get(trade.itemId) ? itemQuantity(actor.items.get(trade.itemId)) : trade.quantity, quantity: trade.quantity } : null);
    const transferableTypes = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);
    const selectedSellerItems = trade?.sellerItems?.length ? trade.sellerItems : [];
    const actorChoices = (actor?.items ?? []).filter(i => itemQuantity(i) > 0 && transferableTypes.has(i.type)).map(i => { const containerId = foundry.utils.getProperty(i, "system.container"); const container = containerId ? actor.items.get(typeof containerId === "string" ? containerId : containerId?.id) : null; return { id: i.id, name: i.name, img: i.img, quantity: itemQuantity(i), containerName: container?.name ?? "Carried", selected: selectedSellerItems.find(line => line.itemId === i.id)?.quantity ?? 0 }; });
    const listingOffers = (shop?.listings ?? []).map(l => ({ source: "listing", refId: l.id, name: l.item.name, img: l.item.img, kind: "Shop item", asked: trade?.items?.find(a => a.source === "listing" && a.listingId === l.id)?.quantity ?? 0 }));
    const reserveOffers = (shop?.till?.items ?? []).map(i => ({ source: "shop", refId: i.id, name: i.name, img: i.img, kind: "Barter currency", asked: trade?.items?.find(a => a.source === "shop" && a.reserveId === i.id)?.quantity ?? 0 }));
    const shopOfferItems = [...reserveOffers, ...listingOffers];
    return {
      shops: available.map(s => ({ ...s, closed: !s.open, cardImage: s.vendorImage || s.image })), shop,
      listings: (shop?.listings ?? []).map(l => ({ ...l, costText: listingCostText(l), showPaymentChoice: l.payment === "both", isBestOffer: l.payment === "bestOffer", draftItems: this.offerDrafts.get(l.id) ?? [], soldOut: l.stock !== null && number(l.stock) <= 0, quantityOptions: Array.from({ length: Math.min(10, l.stock === null ? 10 : Math.max(1, number(l.stock))) }, (_, i) => i + 1) })),
      actor, sellMode: this.mode === "sell", sellItem, trade, tradePending: trade?.status === "pending", tradeCounter: trade?.status === "counter", tradePlayerRevision: trade?.status === "playerRevision", tradeRevision: trade?.status === "revision", askedGold: trade?.gold ?? 0,
      canSell: !!shop?.buyback?.enabled, tileSize: shop?.tileSize ?? 220,
      actorChoices, shopOfferItems
    };
  }
  _onRender(context, options) {
    super._onRender(context, options);
    for (const drop of this.element.querySelectorAll(".tbs-offer-drop")) {
      drop.addEventListener("dragover", event => event.preventDefault());
      drop.addEventListener("drop", event => this._dropOffer(event));
    }
    const sellDrop = this.element.querySelector(".tbs-sell-drop");
    sellDrop?.addEventListener("dragover", event => event.preventDefault());
    sellDrop?.addEventListener("drop", event => this._dropSell(event));
  }
  async _dropSell(event) {
    event.preventDefault();
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    const actor = actorForUser(game.user);
    const item = data.type === "Item" ? await fromUuid(data.uuid) : null;
    if (!actor || !item || item.parent?.id !== actor.id) return ui.notifications.warn("Drag an Item from the selected character's inventory.");
    this.sellDraft = { itemId: item.id, name: item.name, img: item.img, max: itemQuantity(item), quantity: 1 };
    this.render({ force: true });
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
  static openSell() { this.mode = "sell"; this.render({ force: true }); }
  static backToShop() { this.mode = "shop"; this.render({ force: true }); }
  static clearSellItem() { this.sellDraft = null; this.render({ force: true }); }
  static acceptCounter() { const trade = shops().find(s => s.id === this.shopId)?.trades.find(t => t.userId === game.user.id); if (trade && sendRequest({ action: "acceptTrade", userId: game.user.id, shopId: this.shopId, tradeId: trade.id })) { this.sellDraft = null; this.offerDrafts.clear(); this.close(); } }
  static reviseCounter() { const trade = shops().find(s => s.id === this.shopId)?.trades.find(t => t.userId === game.user.id); if (trade) sendRequest({ action: "reviseTrade", userId: game.user.id, shopId: this.shopId, tradeId: trade.id }); }
  static submitTrade(event, target) {
    const actor = actorForUser(game.user); const shop = shops().find(s => s.id === this.shopId);
    if (!actor || !shop) return ui.notifications.warn("Select a character token first.");
    const trade = shop.trades.find(t => t.userId === game.user.id && (t.actorUuid === actor.uuid || t.actorId === actor.id));
    if (trade?.status === "pending") return ui.notifications.warn("The GM is still considering this proposal.");
    const itemId = this.sellDraft?.itemId ?? trade?.itemId; const item = actor.items.get(itemId);
    if (!item) return ui.notifications.warn("Drag an Item into the sale box first.");
    const root = target.closest(".tbs-sell-screen");
    const quantity = Math.max(1, Math.floor(number(root.querySelector("[data-sell-quantity]")?.value, 1)));
    const gold = Math.max(0, Math.floor(number(root.querySelector("[data-ask-gold]")?.value, 0)));
    const items = [...root.querySelectorAll("[data-ask-shop-item]")].map(input => ({ source: input.dataset.offerSource, ...(input.dataset.offerSource === "shop" ? { reserveId: input.dataset.askShopItem } : { listingId: input.dataset.askShopItem }), quantity: Math.max(0, Math.floor(number(input.value, 0))) })).filter(i => i.quantity > 0);
    if (sendRequest({ action: "submitTrade", userId: game.user.id, actorId: actor.id, actorUuid: actor.uuid, shopId: shop.id, tradeId: trade?.id ?? null, itemId: item.id, quantity, gold, items })) { this.sellDraft = null; this.close(); }
  }
  static submitPlayerCounter(event, target) {
    const actor = actorForUser(game.user); const shop = shops().find(s => s.id === this.shopId);
    const trade = shop?.trades?.find(t => t.userId === game.user.id && (!actor || t.actorUuid === actor.uuid || t.actorId === actor.id));
    if (!actor || !shop || !trade) return ui.notifications.warn("That trade is no longer available.");
    const root = target.closest(".tbs-sell-screen");
    const sellerItems = [...root.querySelectorAll("[data-player-seller-item]")].map(input => ({ itemId: input.dataset.playerSellerItem, name: input.dataset.name, quantity: Math.max(0, Math.floor(number(input.value, 0))) })).filter(i => i.quantity > 0);
    const gold = Math.max(0, Math.floor(number(root.querySelector("[data-player-counter-gold]")?.value, 0)));
    const items = [...root.querySelectorAll("[data-player-shop-item]")].map(input => ({ source: input.dataset.offerSource, ...(input.dataset.offerSource === "shop" ? { reserveId: input.dataset.playerShopItem } : { listingId: input.dataset.playerShopItem }), quantity: Math.max(0, Math.floor(number(input.value, 0))) })).filter(i => i.quantity > 0);
    if (sendRequest({ action: "playerCounterTrade", userId: game.user.id, shopId: shop.id, tradeId: trade.id, sellerItems, gold, items })) { this.sellDraft = null; this.close(); }
  }
  static abandonTrade() {
    const actor = actorForUser(game.user); const shop = shops().find(s => s.id === this.shopId);
    const trade = shop?.trades?.find(t => t.userId === game.user.id && (!actor || t.actorUuid === actor.uuid || t.actorId === actor.id));
    if (trade) sendRequest({ action: "abandonTrade", userId: game.user.id, shopId: shop.id, tradeId: trade.id });
    this.sellDraft = null; this.mode = "shop"; this.render({ force: true });
  }
  static async buy(event, target) {
    const actor = actorForUser(game.user);
    if (!actor) return ui.notifications.warn("Select a token or assign a character first.");
    const listing = shops().find(s => s.id === this.shopId)?.listings.find(l => l.id === target.dataset.listingId);
    if (!listing) return ui.notifications.error("That listing no longer exists.");
    const card = target.closest(".tbs-product");
    const quantity = Math.max(1, Math.floor(number(card?.querySelector("[data-quantity-input]")?.value, 1)));
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
    const quantity = Math.max(1, Math.floor(number(card?.querySelector("[data-quantity-input]")?.value, 1)));
    const gold = Math.max(0, Math.floor(number(card?.querySelector("[data-offer-gold]")?.value, 0)));
    const draft = this.offerDrafts.get(listingId) ?? [];
    const items = draft.map(item => ({ itemId: item.itemId, name: item.name, quantity: Math.min(item.max, Math.max(1, Math.floor(number(card?.querySelector(`[data-offer-item-id="${item.itemId}"]`)?.value, 1)))) }));
    sendRequest({ action: "submitOffer", userId: game.user.id, actorId: actor.id, actorUuid: actor.uuid, shopId: this.shopId, listingId, quantity, gold, items });
    this.offerDrafts.delete(listingId);
    this.render({ force: true });
  }
}

class ShopManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tbs-manager", classes: ["tbs", "tbs-manager"], tag: "section",
    position: { width: 1100, height: 760 }, window: { resizable: true, title: "Manage Barter Shops", icon: "fa-solid fa-shop-lock" },
    actions: { create: ShopManager.create, select: ShopManager.select, remove: ShopManager.remove, save: ShopManager.save, removeListing: ShopManager.removeListing, removeCurrency: ShopManager.removeCurrency, acceptOffer: ShopManager.acceptOffer, denyOffer: ShopManager.denyOffer, acceptTrade: ShopManager.acceptTrade, rejectTrade: ShopManager.rejectTrade, counterTrade: ShopManager.counterTrade, abandonTrade: ShopManager.abandonTrade, windowClose: ShopManager.windowClose, windowMinimize: ShopManager.windowMinimize }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/manager.hbs` } };
  constructor(options = {}) { super(options); this.shopId = options.shopId ?? null; }
  async _prepareContext() {
    const all = shops();
    const shop = all.find(s => s.id === this.shopId) ?? all[0] ?? null;
    if (shop) this.shopId = shop.id;
    const offers = (shop?.offers ?? []).map(o => ({ ...o, summary: [...o.items.map(i => `${i.quantity} × ${i.name}`), ...(o.gold ? [`${o.gold} GP`] : [])].join(", ") }));
    const transferableTypes = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);
    const trades = await Promise.all((shop?.trades ?? []).map(async t => {
      const seller = t.actorUuid ? await fromUuid(t.actorUuid) : game.actors.get(t.actorId);
      const selectedSellerItems = t.sellerItems?.length ? t.sellerItems : [{ itemId: t.itemId, quantity: t.quantity }];
      const sellerChoices = (seller?.items ?? []).filter(i => itemQuantity(i) > 0 && transferableTypes.has(i.type)).map(i => { const containerId = foundry.utils.getProperty(i, "system.container"); const container = containerId ? seller.items.get(typeof containerId === "string" ? containerId : containerId?.id) : null; return { id: i.id, name: i.name, img: i.img, quantity: itemQuantity(i), containerName: container?.name ?? "Carried", selected: selectedSellerItems.find(line => line.itemId === i.id)?.quantity ?? 0 }; });
      const sellerSummary = selectedSellerItems.map(line => `${line.quantity} × ${seller?.items.get(line.itemId)?.name ?? line.name ?? "Item"}`).join(", ");
      const shortages = [];
      if (number(t.gold) > number(shop?.till?.currency?.gp)) shortages.push(`Needs ${t.gold} GP; the merchant has ${number(shop?.till?.currency?.gp)} GP.`);
      for (const asked of t.items ?? []) {
        if (asked.source === "listing") {
          const listing = shop?.listings?.find(l => l.id === asked.listingId);
          if (!listing || (listing.stock !== null && number(asked.quantity) > number(listing.stock))) shortages.push(`Needs ${asked.quantity} × ${asked.name}; only ${listing ? number(listing.stock) : 0} are in shop stock.`);
        } else {
          const reserve = shop?.till?.items?.find(i => i.id === asked.reserveId);
          if (!reserve || number(asked.quantity) > number(reserve.quantity)) shortages.push(`Needs ${asked.quantity} × ${asked.name}; the merchant has ${reserve ? number(reserve.quantity) : 0}.`);
        }
      }
      return { ...t, pending: t.status === "pending", counter: t.status === "counter", cannotAccept: shortages.length > 0, shortageText: shortages.join(" "), sellerSummary, requestSummary: [...(t.items ?? []).map(i => `${i.quantity} × ${i.name}`), ...(t.gold ? [`${t.gold} GP`] : [])].join(" and "), reserveChoices: (shop?.till?.items ?? []).filter(i => number(i.quantity) > 0).map(i => ({ ...i, selected: t.items?.find(a => a.source === "shop" && a.reserveId === i.id)?.quantity ?? 0 })), listingChoices: (shop?.listings ?? []).filter(l => l.stock === null || number(l.stock) > 0).map(l => ({ id: l.id, name: l.item.name, img: l.item.img, quantity: l.stock === null ? "Unlimited" : l.stock, max: l.stock === null ? 999999 : number(l.stock), selected: t.items?.find(a => a.source === "listing" && a.listingId === l.id)?.quantity ?? 0 })), sellerChoices };
    }));
    return { shops: all, shop, offers, trades, users: game.users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name, checked: shop?.users?.includes(u.id) })) };
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
  static async acceptTrade(event, target) { const trade = shops().find(s => s.id === this.shopId)?.trades.find(t => t.id === target.dataset.tradeId); if (trade && await gmMessage({ action: "acceptTrade", userId: trade.userId, shopId: this.shopId, tradeId: trade.id })) this.close(); }
  static rejectTrade(event, target) { const trade = shops().find(s => s.id === this.shopId)?.trades.find(t => t.id === target.dataset.tradeId); if (trade) gmMessage({ action: "rejectTrade", userId: trade.userId, shopId: this.shopId, tradeId: trade.id }); }
  static async counterTrade(event, target) { const card = target.closest("[data-trade-card]"); const trade = shops().find(s => s.id === this.shopId)?.trades.find(t => t.id === target.dataset.tradeId); if (!card || !trade) return; const gold = Math.max(0, Math.floor(number(card.querySelector("[data-counter-gold]")?.value, 0))); const reserveItems = [...card.querySelectorAll("[data-counter-reserve]")].map(i => ({ source: "shop", reserveId: i.dataset.counterReserve, name: i.dataset.name, quantity: number(i.value) })).filter(i => i.quantity > 0); const listingItems = [...card.querySelectorAll("[data-counter-listing]")].map(i => ({ source: "listing", listingId: i.dataset.counterListing, name: i.dataset.name, quantity: number(i.value) })).filter(i => i.quantity > 0); const sellerItems = [...card.querySelectorAll("[data-counter-seller-item]")].map(i => ({ itemId: i.dataset.counterSellerItem, name: i.dataset.name, quantity: number(i.value) })).filter(i => i.quantity > 0); if (await gmMessage({ action: "counterTrade", userId: trade.userId, shopId: this.shopId, tradeId: trade.id, gold, items: [...reserveItems, ...listingItems], sellerItems })) this.close(); }
  static abandonTrade(event, target) { const trade = shops().find(s => s.id === this.shopId)?.trades.find(t => t.id === target.dataset.tradeId); if (trade) gmMessage({ action: "abandonTrade", userId: trade.userId, shopId: this.shopId, tradeId: trade.id }); }
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
    else if (message.action === "tradeComplete" && message.userId === game.user.id) {
      for (const app of ApplicationV2.instances()) if (app instanceof ShopBrowser && app.shopId === message.shopId) { app.sellDraft = null; app.offerDrafts.clear(); app.mode = "shop"; app.render({ force: true }); }
    }
    else if (message.action === "tradePrompt" && message.userId === game.user.id) { if (message.message) ui.notifications.info(message.message); openPlayerTrade(message.shopId); }
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
