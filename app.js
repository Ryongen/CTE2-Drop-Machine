'use strict';
/*
 * CTE2 Drop Machine
 * A faithful port of Mine and Slash's mob-kill loot pipeline:
 *   MasterLootGen.generateLoot -> populateOnce -> each BaseLootGen -> LootInfo.setup -> LootUtils.WhileRoll
 *   -> blueprints (GearRarityPart, UniqueGearPart, MapBlueprint...) -> max-items cap -> populateOnceSpecialDrops.
 */

const POOLS = window.POOLS;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------------------------------------------------------- constants

const RARS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'unique', 'runeword'];
const NORMAL_RARS = RARS.slice(0, 6);
// Display names come from the pack's lang files (e.g. Runeword is "Runed", Omens are "Codex", Auras are "Augments").
const RAR_NAME = { ...POOLS.names.rarity };
const MOB_RARS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'boss', 'uber', 'pinnacle', 'summon'];
const MOB_NAME = { ...POOLS.names.mob };
const RAR_TIER = POOLS.rarityTier; // gear_rarity item_tier: decides which base-item tiers a rarity may use
const IT = POOLS.items;
const LBL = POOLS.labels;
const iconOf = (list, pred) => (list.find(pred) || {}).icon;

// Every generator in populateOnce(), in the order the mod runs them. `icon` is a real item texture from the pack.
const GENS = [
  { key: 'gear', label: 'Gear', icon: iconOf(POOLS.gearTypes.find(t => t.id === 'sword')?.items || [], i => i.min === 'epic'), rate: 'gear', find: null, relic: 'gear', item: 'gear' },
  { key: 'soul', label: IT.soul.name, icon: IT.soul.icon, rate: 'soul', find: null, relic: 'gear', item: 'soul' },
  { key: 'aura', label: LBL.aura, icon: IT.aura.int, rate: 'aura', find: 'skillgem', relic: 'skillgem', item: 'aura' },
  { key: 'support', label: LBL.support, icon: IT.support.str, rate: 'support', find: 'skillgem', relic: 'skillgem', item: 'support' },
  { key: 'jewel', label: 'Jewel', icon: IT.jewel.int.icon, rate: 'jewel', find: 'jewel', relic: 'jewel', item: 'jewel' },
  { key: 'currency', label: 'Currency', icon: iconOf(POOLS.currency, c => c.id === 'chaos_orb'), rate: 'currency', find: 'currency', relic: 'currency', item: 'currency' },
  { key: 'map', label: 'Map', icon: IT.map.icon, rate: 'map', find: 'map', relic: 'map', item: 'map' },
  { key: 'gem', label: 'Gem', icon: iconOf(POOLS.gems, g => g.id === 'ruby4'), rate: 'gem', find: 'gem', relic: 'gem', item: 'gem' },
  { key: 'rune', label: 'Rune', icon: iconOf(POOLS.runes, r => r.id === 'cen'), rate: 'rune', find: 'rune', relic: 'rune', item: 'rune' },
  { key: 'chest', label: 'Loot Chest', icon: IT.chest.epic, rate: 'chest', find: null, relic: 'chest', item: 'chest' },
  { key: 'coin', label: IT.coin.name, icon: IT.coin.icon, rate: 'coin', find: 'coin', relic: 'coin', item: 'coin' },
  { key: 'omen', label: LBL.omen, icon: IT.omen.icon, rate: 'omen', find: 'omen', relic: 'omen', item: 'omen' },
];
// populateOnceSpecialDrops(): chanceIsModified() == false for both.
const SPECIAL_GENS = [
  { key: 'watcher', label: LBL.watcher.split(',')[0], icon: IT.watcher.icon, rate: 'watcher', find: 'watcher', relic: 'watcher', item: 'watcher', special: true },
  { key: 'pinnacle', label: 'Pinnacle Gem', icon: iconOf(POOLS.gems, g => g.id === 'ruby7'), rate: 'pinnacle', find: null, relic: 'gem', item: 'pinnacle', special: true },
];
const img = (src, cls = 'ico') => src ? `<img class="${cls}" src="${src}" alt="" loading="lazy">` : '<span class="ico noimg">?</span>';
const ALL_GENS = [...GENS, ...SPECIAL_GENS];
const GEN_BY_KEY = Object.fromEntries(ALL_GENS.map(g => [g.key, g]));

const RATE_ROWS = [
  ['gear', 'gear_drop_rate'], ['soul', 'soul_drop_rate'], ['aura', 'aura_gem_drop_rate'], ['support', 'support_gem_drop_rate'],
  ['jewel', 'jewel_drop_rate'], ['currency', 'currency_drop_rate'], ['map', 'MAP_DROPRATE'], ['gem', 'gem_drop_rate'],
  ['rune', 'rune_drop_rate'], ['chest', 'loot_chest_drop_rate'], ['coin', 'PROPHECY_COIN_DROPRATE'], ['omen', 'OMEN_DROPRATE'],
  ['watcher', 'WATCHER_EYE_DROPRATE'], ['pinnacle', 'PINNACLE_GEM_DROPRATE'],
];

// ---------------------------------------------------------------- presets

const GEAR_RARITIES_MOD = {
  common: { w: 5000, min: 0, higher: 'uncommon', tiers: [0, 10], type: 'NORMAL' },
  uncommon: { w: 2000, min: 0, higher: 'rare', tiers: [10, 20], type: 'NORMAL' },
  rare: { w: 500, min: 10, higher: 'epic', tiers: [20, 40], type: 'NORMAL' },
  epic: { w: 100, min: 25, higher: 'legendary', tiers: [40, 60], type: 'NORMAL' },
  legendary: { w: 50, min: 40, higher: 'mythic', tiers: [60, 80], type: 'NORMAL' },
  mythic: { w: 25, min: 50, higher: '', tiers: [80, 100], type: 'NORMAL' },
  unique: { w: 25, min: 0, higher: '', tiers: [100, 100], type: 'UNIQUE' },
  runeword: { w: 150, min: 15, higher: '', tiers: [0, 100], type: 'RUNED' },
};
const MOB_RARITIES = {
  common: { loot: 1, hp: -1, min: 0 }, uncommon: { loot: 1.25, hp: -1, min: 0 }, rare: { loot: 1.75, hp: -1, min: 0 },
  epic: { loot: 2.75, hp: -1, min: 10 }, legendary: { loot: 4.75, hp: -1, min: 25 }, mythic: { loot: 8.75, hp: -1, min: 50 },
  boss: { loot: 10.5, hp: 200, min: 1 }, uber: { loot: 15.5, hp: 250, min: 1 }, pinnacle: { loot: 20, hp: 300, min: 1 },
  summon: { loot: 1.5, hp: -1, min: 0 },
};
const FAVOR = { common: 1, uncommon: 1.02, rare: 1.05, epic: 1.1, legendary: 1.15, mythic: 1.25 };

// Mine and Slash source defaults (ServerContainer + GearRaritiesAdder). The pack preset below starts from these and
// overlays everything tools/extract.py read from the pack: the server toml, gear_rarity, mob_rarity and game balance JSON.
const MOD_RATES = { gear: 7, soul: 0.3, aura: 2, support: 2, jewel: 0.25, currency: 1, map: 1, gem: 1, rune: 0.5, chest: 0.1, coin: 1, omen: 0.1, watcher: 33, pinnacle: 100 };
const MOD_SERVER = { maxItems: 20, minItems: 0, rollCap: 75, mfCap: 150, leeway: 2, perLvl: 0.2, minMulti: 0.2, party: 0.2, minLvlMaps: 25, mapFalloff: 5, mapRise: 1, bossFalloff: 0, bossRise: 3, maxLevel: 100 };

function packPreset() {
  const p = { name: 'CTE2 pack', rates: { ...MOD_RATES }, server: { ...MOD_SERVER, maxLevel: POOLS.maxLevel || 100 } };
  for (const [path, v] of Object.entries(POOLS.config.values)) { const [grp, key] = path.split('.'); p[grp][key] = v; }
  p.gearRarities = {};
  for (const r of RARS) { const d = POOLS.gearRarityData[r] || GEAR_RARITIES_MOD[r]; p.gearRarities[r] = { w: d.w, min: d.min, higher: d.higher, tiers: d.tiers, type: d.type }; }
  p.mobRarities = {};
  for (const r of MOB_RARS) p.mobRarities[r] = { ...(POOLS.mobRarityData[r] || MOB_RARITIES[r]) };
  p.favor = {};
  for (const r of NORMAL_RARS) p.favor[r] = (POOLS.gearRarityData[r] || {}).favor ?? FAVOR[r];
  return p;
}

const PRESETS = {
  pack: packPreset(),
  mod: {
    name: 'Mine and Slash defaults',
    rates: { ...MOD_RATES },
    server: { ...MOD_SERVER },
    gearRarities: GEAR_RARITIES_MOD,
    mobRarities: MOB_RARITIES,
    favor: FAVOR,
  },
};

const clone = o => JSON.parse(JSON.stringify(o));
const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

let CFG = store.get('cte2dm.cfg') || clone(PRESETS.pack);
if (!CFG.name) CFG = clone(PRESETS.pack);

// ---------------------------------------------------------------- scenario schema

const LEAGUES = [
  { id: 'none', label: 'None (overworld / normal map)', ids: [] },
  { id: 'harvest', label: 'The Harvest', ids: ['harvest', 'the_harvest'] },
  { id: 'obelisk', label: 'Ancient Obelisks', ids: ['obelisk', 'ancient_obelisks'] },
  { id: 'strongbox', label: 'Strongbox', ids: ['strongbox'] },
  { id: 'prophecy', label: 'Prophecy', ids: ['prophecy'] },
  { id: 'imprisoned_monster', label: 'Imprisoned Monster', ids: ['imprisoned_monster'] },
];

const SCHEMA = [
  { group: 'The mob', open: true, fields: [
    { id: 'mobRar', label: 'Mob rarity', type: 'select', wide: true, options: () => MOB_RARS.map(r => [r, `${MOB_NAME[r]}  (loot ×${CFG.mobRarities[r].loot})`]) },
    { id: 'mobLevel', label: 'Mob level', type: 'number', min: 1, max: 100, def: 60 },
    { id: 'mobHp', label: 'Mob base max HP', type: 'number', min: 1, def: 20, help: 'Zombie 20. Ignored for boss/uber/pinnacle (forced HP).' },
    { id: 'mobDatapack', label: 'Entity loot_multi', type: 'number', step: 0.1, def: 1, help: 'mmorpg_entity config' },
    { id: 'mobBonus', label: 'Mob "extra drops" %', type: 'number', def: 0, help: 'from mob affixes' },
  ] },
  { group: 'You', open: true, fields: [
    { id: 'playerLevel', label: 'Your level', type: 'number', min: 1, max: 100, def: 60 },
    { id: 'mf', label: 'Magic Find %', type: 'number', min: 0, def: 0, help: 'TreasureQuality · gear, buffs… (total caps at 150)', atlas: 'magic_find' },
    { id: 'iq', label: 'Item Find %', type: 'number', def: 0, help: 'TreasureQuantity · gear, buffs…', atlas: 'increased_quantity' },
    { id: 'favor', label: 'Favor rank', type: 'select', options: () => NORMAL_RARS.map(r => [r, `${RAR_NAME[r]} (×${CFG.favor[r]})`]) },
    { id: 'party', label: 'Party members nearby', type: 'number', min: 0, max: 10, def: 0, help: 'not counting you' },
  ] },
  { group: 'Atlas passive tree', open: true, atlasGroup: true, fields: [] },
  { group: 'Find stats (gear, buffs…)', open: false, fields: [
    { id: 'find_currency', label: 'Currency find %', type: 'number', def: 0, atlas: 'currency_find' },
    { id: 'find_map', label: 'Map find %', type: 'number', def: 0, atlas: 'map_find' },
    { id: 'find_gem', label: 'Gem find %', type: 'number', def: 0, atlas: 'gem_find' },
    { id: 'find_rune', label: 'Rune find %', type: 'number', def: 0, atlas: 'rune_find' },
    { id: 'find_jewel', label: 'Jewel find %', type: 'number', def: 0, atlas: 'jewel_find' },
    { id: 'find_skillgem', label: 'Skill gem find %', type: 'number', def: 0, atlas: 'skill_gem_find' },
    { id: 'find_omen', label: 'Codex find %', type: 'number', def: 0, atlas: 'omen_find' },
    { id: 'find_watcher', label: 'Abyssal Eye find %', type: 'number', def: 0, atlas: 'watcher_eye_find' },
    { id: 'find_coin', label: 'Prophecy coin find %', type: 'number', def: 0, atlas: 'prophecy_coin_find' },
    { id: 'mapBias', label: 'Map rarity bias', type: 'number', def: 0, help: 'maps ignore normal MF', atlas: 'map_rarity_bias' },
    { id: 'bossLoot', label: 'Boss loot %', type: 'number', def: 0, help: 'boss mobs only', atlas: 'boss_loot_quantity' },
    { id: 'mythicLoot', label: 'Mythic mob loot %', type: 'number', def: 0, help: 'mythic mobs only', atlas: 'extra_drop_from_mythics' },
  ] },
  { group: 'Where', open: true, fields: [
    { id: 'inMap', label: 'Killed inside a map', type: 'check', def: false },
    { id: 'mapTier', label: 'Map tier', type: 'number', min: 0, max: 100, def: 20, showIf: s => s.inMap },
    { id: 'finalBoss', label: "It's the map's final boss", type: 'check', def: false, showIf: s => s.inMap },
    { id: 'rewardRoom', label: 'Reward-room multi', type: 'number', step: 0.1, def: 1, showIf: s => s.inMap, help: '1 = not in a reward room' },
    { id: 'prophecy', label: 'Prophecy affixes taken', type: 'number', min: 0, def: 0, showIf: s => s.inMap },
    { id: 'league', label: 'League', type: 'select', wide: true, options: () => LEAGUES.map(l => [l.id, l.label]) },
    { id: 'dimension', label: 'Dimension all_drop_multi', type: 'number', step: 0.1, def: 1 },
    { id: 'antiFarm', label: 'Anti-mob-farm multi', type: 'number', step: 0.1, def: 1, showIf: s => !s.inMap, help: 'outside maps only' },
  ] },
  { group: 'Map relic bonuses %', open: false, showIf: s => s.inMap, fields: [
    { id: 'relic_gear', label: 'Gear (+souls)', type: 'number', def: 0 },
    { id: 'relic_skillgem', label: 'Skill gems', type: 'number', def: 0 },
    { id: 'relic_currency', label: 'Currency', type: 'number', def: 0 },
    { id: 'relic_map', label: 'Maps', type: 'number', def: 0 },
    { id: 'relic_gem', label: 'Gems (+pinnacle)', type: 'number', def: 0 },
    { id: 'relic_rune', label: 'Runes', type: 'number', def: 0 },
    { id: 'relic_jewel', label: 'Jewels', type: 'number', def: 0 },
    { id: 'relic_omen', label: 'Codex', type: 'number', def: 0 },
    { id: 'relic_watcher', label: 'Abyssal Eye', type: 'number', def: 0 },
    { id: 'relic_coin', label: 'Prophecy coins', type: 'number', def: 0 },
    { id: 'relic_chest', label: 'Loot chests', type: 'number', def: 0 },
  ] },
];

function defaultScenario() {
  const s = { mobRar: 'common', favor: 'common', league: 'none' };
  for (const g of SCHEMA) for (const f of g.fields) if (f.def !== undefined) s[f.id] = f.def;
  return s;
}
let SCN = Object.assign(defaultScenario(), store.get('cte2dm.scn') || {});

// ---------------------------------------------------------------- random helpers

const rand100 = () => Math.random() * 100;
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1)); // RandomUtils.RandomRange (inclusive)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function roll(chance) { const r = rand100(); return { r, ok: chance >= r }; } // RandomUtils.roll
// RandomUtils.weightedRandom: zero-weight entries are skipped unless everything is zero (then uniform).
function wpick(list, wf = x => x.w) {
  if (!list.length) return null;
  const pos = list.filter(x => wf(x) > 0);
  if (!pos.length) return list[Math.floor(Math.random() * list.length)];
  let r = Math.random() * pos.reduce((a, x) => a + wf(x), 0);
  for (const x of pos) { r -= wf(x); if (r < 0) return x; }
  return pos[pos.length - 1];
}
const pretty = id => String(id).replace(/[_:]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const fmt = (n, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });
const pct = (n, d = 2) => `${fmt(n, d)}%`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- engine: loot modifiers

function lootModifiers(s, cfg) {
  const mods = [];
  const add = (name, multi, why) => mods.push({ name, multi, why });
  const mob = cfg.mobRarities[s.mobRar];

  if (s.inMap && s.rewardRoom !== 1) add('Map Complete Rarity', s.rewardRoom, 'reward room finish rarity');

  // LootUtils.getLevelDistancePunishmentMulti
  const diff = Math.abs(s.playerLevel - s.mobLevel);
  let ld = 1;
  if (diff > cfg.server.leeway) ld = clamp(1 - (diff - cfg.server.leeway) * cfg.server.perLvl, cfg.server.minMulti, 1);
  add('Level Difference Penalty', ld, `${diff} level gap, ${cfg.server.leeway} free, −${cfg.server.perLvl} per level after, min ${cfg.server.minMulti}`);

  // LootUtils.getMobHealthBasedLootMulti
  const hp = mob.hp > 0 ? mob.hp : s.mobHp;
  add('Mob Health', Math.min(10, 1 + hp / 40), `1 + ${hp} HP / 40${mob.hp > 0 ? ' (forced HP for this rarity)' : ''}, max 10`);
  add('Mob Datapack', s.mobDatapack, 'entity config loot_multi');
  add('Mob Bonus Loot Stat', 1 + s.mobBonus / 100, 'extra drops from mob affixes');
  add('Mob Rarity', mob.loot, `${MOB_NAME[s.mobRar]} loot_multi`);
  if (s.mobRar === 'boss') add('Boss Loot', 1 + s.bossLoot / 100, 'Atlas boss-loot stat');
  if (s.mobRar === 'mythic') add('Mythic Loot', 1 + s.mythicLoot / 100, 'Atlas mythic-loot stat');
  if (s.party > 0) add('Party Bonus', 1 + Math.min(s.party, 3) * cfg.server.party, `+${cfg.server.party} per member, max 3`);
  if (s.playerLevel < 10) add('Low Level', 2, 'you are under level 10');
  add('Favor Rank', cfg.favor[s.favor], `${RAR_NAME[s.favor]} favor`);
  add('Player Loot Quantity', 1 + s.iq / 100, 'Item Find (TreasureQuantity)');
  add('Dimension Datapack', s.dimension, 'dimension all_drop_multi');
  if (s.inMap) add('Adventure Map', 1 + s.mapTier * 0.02, `1 + tier ${s.mapTier} × 0.02`);
  else add('Anti Mob Farm Mod', s.antiFarm, 'outside maps');

  const product = mods.reduce((a, m) => a * m.multi, 1);
  return { mods, product };
}

// ---------------------------------------------------------------- engine: per-generator chance

function genCondition(g, s, cfg) {
  const lvl = s.mobLevel;
  switch (g.key) {
    case 'aura': return lvl > 10 ? null : 'mob level must be > 10';
    case 'support': return lvl > 5 ? null : 'mob level must be > 5';
    case 'jewel': return lvl > 5 ? null : 'mob level must be > 5';
    case 'currency': return lvl > 5 ? null : 'mob level must be > 5';
    case 'map': return lvl > cfg.server.minLvlMaps ? null : `mob level must be > ${cfg.server.minLvlMaps} (min_level_map_drops)`;
    case 'gem': return droppableGems(lvl, cfg).length ? null : 'no gem droppable at this level';
    case 'rune': return lvl > 10 ? null : 'mob level must be > 10';
    case 'coin': return (s.inMap && s.prophecy > 0) ? null : 'only inside a map with prophecy affixes taken';
    case 'omen': return droppableOmens(lvl, cfg).length ? null : `no Codex droppable below level ${Math.ceil(cfg.server.maxLevel * Math.min(...POOLS.omens.map(o => o.lvl)))}`;
    case 'watcher': return s.mobRar === 'uber' ? null : 'uber bosses only';
    case 'pinnacle': return s.mobRar === 'pinnacle' ? null : 'pinnacle bosses only';
  }
  return null;
}

function genChance(g, s, cfg, mods) {
  const base = cfg.rates[g.rate];
  const steps = [{ label: 'base rate', v: base }];
  let chance = base;
  if (g.key === 'coin') {
    const t = 1 + s.mapTier / 25; chance *= t; steps.push({ label: `× map tier (1 + ${s.mapTier}/25)`, v: t });
    chance *= s.prophecy; steps.push({ label: '× prophecy affixes taken', v: s.prophecy });
  }
  if (g.find) {
    const f = 1 + (s['find_' + g.find] || 0) / 100;
    chance *= f; if (f !== 1) steps.push({ label: `× ${g.find} find`, v: f });
  }
  const modified = !g.special;
  if (modified) { chance *= mods.product; steps.push({ label: '× loot modifiers', v: mods.product }); }
  if (s.inMap) {
    const r = 1 + (s['relic_' + g.relic] || 0) / 100;
    chance *= r; if (r !== 1) steps.push({ label: '× map relic', v: r });
  }
  return { chance, steps, modified };
}

// LootUtils.WhileRoll: one roll per 75% "chunk" of chance.
function whileRoll(chance, cap) {
  const chunks = [];
  let amount = 0;
  while (chance > 0) {
    const c = Math.min(chance, cap);
    chance -= c;
    const r = roll(c);
    chunks.push({ c, r: r.r, ok: r.ok });
    if (r.ok) amount++;
    if (chunks.length > 2000) break;
  }
  return { amount, chunks };
}

// ---------------------------------------------------------------- engine: rarity (GearRarityPart)

function hasLower(id, G) { return RARS.some(r => G[r].higher === id); }

function possibleRarities(kind, lvl, G) {
  if (kind === 'skillgem') {
    // the mod's filter: (level >= min_lvl && !unique && hasLower) || hasHigher  — note the || precedence
    return RARS.filter(r => (lvl >= G[r].min && G[r].type !== 'UNIQUE' && hasLower(r, G)) || !!G[r].higher);
  }
  if (kind === 'map') return RARS.filter(r => G[r].type === 'NORMAL');
  let p = RARS.filter(r => lvl >= G[r].min);
  if (kind !== 'gear') p = p.filter(r => G[r].type !== 'UNIQUE' && r !== 'runeword');
  return p;
}

function higherChanceFor(kind, s, cfg) {
  if (kind === 'gear' || kind === 'skillgem') return Math.min(s.mf, cfg.server.mfCap);
  if (kind === 'jewel') return 50;
  if (kind === 'chest') return 75;
  if (kind === 'map') return s.mapBias;
  return 0;
}

function rarityWeights(kind, possible, cfh, G) {
  return possible.map(r => {
    let w = G[r].w;
    const boosted = kind === 'gear' && (r === 'unique' || r === 'runeword');
    if (boosted) w = Math.round(w * clamp(1 + cfh / 200, 1, 10));
    return { r, w, base: G[r].w, boosted };
  });
}

function rollRarity(kind, s, cfg) {
  const G = cfg.gearRarities, lvl = s.mobLevel;
  const possible = possibleRarities(kind, lvl, G);
  const cfh = higherChanceFor(kind, s, cfg);
  const weights = rarityWeights(kind, possible, cfh, G);
  const total = weights.reduce((a, x) => a + x.w, 0);
  let picked;
  let rollN = 0;
  if (total <= 0) picked = weights[0].r;
  else {
    rollN = randInt(1, total);
    let cum = 0;
    for (const x of weights) { cum += x.w; if (rollN <= cum) { picked = x.r; break; } }
  }
  const trace = { kind, weights, total, roll: rollN, picked, cfh, up: null, final: picked };
  const higher = G[picked].higher;
  if (higher) {
    const ratio = clamp(G[higher].w / G[picked].w, 0, 1);
    const chance = cfh * ratio;
    const r = roll(chance);
    const up = { from: picked, to: higher, ratio, chance, r: r.r, ok: r.ok, blocked: null };
    if (r.ok) {
      if (!possibleRarities(kind, lvl, G).includes(higher)) up.blocked = `${RAR_NAME[higher]} can't drop here`;
      else if (lvl < G[higher].min) up.blocked = `${RAR_NAME[higher]} needs level ${G[higher].min}`;
      else trace.final = higher;
    }
    trace.up = up;
  }
  return trace;
}

// ---------------------------------------------------------------- engine: item pools

const leagueIds = s => (LEAGUES.find(l => l.id === s.league) || LEAGUES[0]).ids;
const droppableGems = (lvl, cfg) => POOLS.gems.filter(g => lvl >= Math.floor(cfg.server.maxLevel * g.lvl) && g.tier < 7);
const droppableRunes = (lvl, cfg) => POOLS.runes.filter(r => lvl >= Math.floor(cfg.server.maxLevel * r.lvl));
const droppableOmens = (lvl, cfg) => POOLS.omens.filter(o => lvl >= cfg.server.maxLevel * o.lvl);
const droppableCurrency = s => POOLS.currency.filter(c => !c.league || leagueIds(s).includes(c.league));
function eligibleUniques(s) {
  const tier = s.inMap ? s.mapTier : 0;
  const ids = leagueIds(s);
  return POOLS.uniques.filter(u => u.w > 0 && u.rar === 'unique' && tier >= u.tier && s.mobLevel >= u.lvl && (!u.league || ids.includes(u.league)));
}

function mapTierFor(rar, G) { const b = G[rar].tiers; return randInt(b[0], b[1]); }
function rarityForTier(tier, G) { return NORMAL_RARS.find(r => tier >= G[r].tiers[0] && tier <= G[r].tiers[1]) || 'mythic'; }

function makeItem(g, s, cfg) {
  const G = cfg.gearRarities;
  const it = { gen: g.key, icon: g.icon, rar: 'other', name: g.label, detail: '', notes: [] };
  switch (g.item) {
    case 'gear': case 'soul': {
      // BaseGearTypePart: weighted slot -> weighted base gear type in that slot
      const slot = wpick(POOLS.slots);
      let type = wpick(POOLS.gearTypes.filter(t => t.slot === slot.id));
      if (!type) { it.failed = `No base gear type for slot ${slot.name}`; return it; }
      it.trace = rollRarity('gear', s, cfg);
      let rar = it.trace.final;
      it.notes.push(`Slot <b>${esc(slot.name)}</b> (weight ${slot.w}) → base type <b>${esc(type.name)}</b>`);
      let uniq = null;
      if (rar === 'unique') {
        const pool = eligibleUniques(s);
        if (pool.length) {
          // UniqueGearPart prefers a unique of the base type already rolled
          const same = pool.filter(u => u.base === type.id);
          uniq = wpick(same.length ? same : pool);
          const nt = POOLS.gearTypes.find(t => t.id === uniq.base);
          it.notes.push(`Unique picked from ${pool.length} eligible (${same.length ? `${same.length} are ${esc(type.name)}` : `none are ${esc(type.name)}, so the base type becomes ${esc(nt ? nt.name : uniq.base)}`}). Outside maps the tier is 0, so uniques with a min tier are out.`);
          if (nt) type = nt;
        }
      }
      // BaseGearType.getRandomItem: items whose min rarity's item_tier <= this rarity's item_tier, weighted (1/10/100/...)
      const allowed = type.items.filter(x => RAR_TIER[rar] >= RAR_TIER[x.min]);
      let item = wpick(allowed);
      if (uniq && uniq.force) item = { name: uniq.forceName, icon: uniq.forceIcon || (item && item.icon), forced: true };
      if (item && !item.forced) {
        const tot = allowed.reduce((a, x) => a + x.w, 0);
        it.notes.push(`Base item: ${RAR_NAME[rar]} has item tier ${RAR_TIER[rar]}, so ${allowed.length} of ${type.items.length} ${esc(type.name)} models are allowed → <b>${esc(item.name)}</b> (${pct(item.w / tot * 100, 1)})`);
      }
      if (rar === 'unique' && !uniq) {
        rar = 'common';
        it.notes.push('<span class="bad">Unique rolled but no unique is eligible here (level / map tier / league). The item keeps its unique-tier model but becomes Common.</span>');
      }
      it.rar = rar;
      if (!item) {
        // GearBlueprint.generate: no item for this rarity -> it drops a Stat Soul instead
        it.notes.push(`<span class="bad">No ${esc(type.name)} item allows ${RAR_NAME[rar]}, so the mod drops a Stat Soul instead</span>`);
      }
      if (g.item === 'soul' || !item) {
        it.icon = IT.souls[slot.id] || IT.soul.icon;
        it.name = `${RAR_NAME[rar]} ${IT.soul.name}`;
        it.detail = uniq ? uniq.name : type.name;
      } else {
        it.icon = item.icon || g.icon;
        it.name = uniq ? uniq.name : `${RAR_NAME[rar]} ${type.name}`;
        it.detail = (item.name !== it.name ? `${item.name} · ` : '') + `Lv ${s.mobLevel}`;
      }
      break;
    }
    case 'aura': case 'support': {
      // SkillGemBlueprint: any gem of that kind with min_lvl <= level; none -> the item errors out
      const list = (g.item === 'aura' ? POOLS.auras : POOLS.supports).filter(x => s.mobLevel >= x.lvl);
      const pick = wpick(list);
      if (!pick) { it.failed = `No ${g.label} has min level ≤ ${s.mobLevel}, so the item errors out`; return it; }
      it.trace = rollRarity('skillgem', s, cfg);
      it.rar = it.trace.final;
      it.icon = IT[g.item][pick.style] || g.icon;
      it.name = `${RAR_NAME[it.rar]} ${pick.name}`;
      it.detail = `${g.label} · ${pick.style.toUpperCase()}`;
      it.notes.push(`Picked from ${list.length} ${g.label}s with min level ≤ ${s.mobLevel}`);
      break;
    }
    case 'jewel': {
      it.trace = rollRarity('jewel', s, cfg);
      it.rar = it.trace.final;
      const st = ['str', 'dex', 'int'][randInt(0, 2)];
      it.icon = IT.jewel[st].icon;
      it.name = `${RAR_NAME[it.rar]} ${IT.jewel[st].name}`;
      it.detail = `${st.toUpperCase()} jewel`;
      break;
    }
    case 'chest': {
      it.trace = rollRarity('chest', s, cfg);
      it.rar = it.trace.final;
      it.icon = IT.chest[it.rar] || g.icon;
      it.name = `${RAR_NAME[it.rar]} Loot Chest`;
      break;
    }
    case 'map': {
      it.trace = rollRarity('map', s, cfg);
      let rar = it.trace.final;
      let tier = mapTierFor(rar, G);
      it.notes.push(`${RAR_NAME[rar]} maps roll a tier in ${G[rar].tiers[0]}–${G[rar].tiers[1]} → <b>T${tier}</b>`);
      if (s.inMap && s.mapTier > 0) {
        const boss = s.finalBoss;
        const fall = boss ? cfg.server.bossFalloff : cfg.server.mapFalloff;
        const rise = boss ? cfg.server.bossRise : cfg.server.mapRise;
        const low = Math.max(0, s.mapTier - fall), high = Math.max(low, s.mapTier + rise);
        const floor = randInt(low, high);
        if (floor > tier) {
          tier = floor; const nr = rarityForTier(tier, G);
          it.notes.push(`Tier floor from the map you're in: rolled ${floor} in ${low}–${high} → raised to <b>T${tier}</b>${nr !== rar ? `, rarity becomes ${RAR_NAME[nr]}` : ''}`);
          rar = nr;
        } else it.notes.push(`Tier floor rolled ${floor} (range ${low}–${high}), not higher, kept T${tier}`);
      }
      it.rar = rar; it.icon = IT.map.icon; it.name = `${RAR_NAME[rar]} ${IT.map.name} · T${tier}`;
      break;
    }
    case 'currency': {
      const list = droppableCurrency(s);
      const c = wpick(list);
      const tot = list.reduce((a, x) => a + x.w, 0);
      it.rar = c.rar || 'other'; it.icon = c.icon || g.icon; it.name = c.name; it.detail = 'Currency';
      it.notes.push(`Weighted pick: weight ${c.w} of ${tot} (${pct(c.w / tot * 100)}) among ${list.length} currencies that can drop in this league`);
      break;
    }
    case 'gem': {
      const list = droppableGems(s.mobLevel, cfg);
      const gm = wpick(list);
      const tot = list.reduce((a, x) => a + x.w, 0);
      it.rar = gm.rar; it.icon = gm.icon || g.icon; it.name = gm.name; it.detail = `Gem · tier ${gm.tier}`;
      it.notes.push(`Weighted pick: weight ${gm.w} of ${tot} (${pct(gm.w / tot * 100)}) among ${list.length} gems droppable at level ${s.mobLevel}`);
      break;
    }
    case 'rune': {
      const list = droppableRunes(s.mobLevel, cfg);
      const r = wpick(list);
      const tot = list.reduce((a, x) => a + x.w, 0);
      it.rar = 'runeword'; it.icon = r.icon || g.icon; it.name = r.name; it.detail = 'Rune';
      it.notes.push(`Weighted pick: weight ${r.w} of ${tot} among ${list.length} runes droppable at level ${s.mobLevel}`);
      break;
    }
    case 'coin': it.rar = 'other'; it.icon = IT.coin.icon; it.name = IT.coin.name; break;
    case 'omen': {
      // OmenBlueprint is a rarity item with no MF: weighted rarity roll, upgrade chance 0
      const o = wpick(droppableOmens(s.mobLevel, cfg));
      it.trace = rollRarity('omen', s, cfg);
      it.rar = it.trace.final; it.icon = IT.omen.icon; it.name = `${RAR_NAME[it.rar]} ${o.name}`; it.detail = LBL.omen;
      break;
    }
    case 'watcher': {
      const lvl = s.mobLevel;
      const affixes = lvl >= 100 ? 3 : lvl >= 75 ? 2 : lvl >= 50 ? 1 : 0;
      if (!affixes) { it.failed = 'Uber tier lookup fails below level 50, so the eye errors out and nothing drops'; return it; }
      it.rar = 'unique'; it.icon = IT.watcher.icon; it.name = IT.watcher.name; it.detail = `${affixes} aura affix${affixes > 1 ? 'es' : ''}`;
      it.notes.push(`Uber tier by level: 50+ → 1 affix, 75+ → 2, 100 → 3`);
      break;
    }
    case 'pinnacle': {
      const pool = POOLS.gems.filter(x => x.tier === 7);
      const gm = pool[randInt(0, pool.length - 1)];
      it.rar = gm.rar; it.icon = gm.icon || g.icon; it.name = gm.name; it.detail = 'Gem · tier 7';
      it.notes.push(`All ${pool.length} pinnacle gems have weight 0, so the pick is uniform`);
      break;
    }
  }
  return it;
}

// ---------------------------------------------------------------- engine: one kill (MasterLootGen.generateLoot)

function runGens(list, s, cfg, mods) {
  const rows = [];
  const items = [];
  for (const g of list) {
    const ch = genChance(g, s, cfg, mods);
    const wr = whileRoll(ch.chance, cfg.server.rollCap);
    const gate = genCondition(g, s, cfg);
    const row = { g, ...ch, ...wr, gate, items: [] };
    for (let i = 0; i < wr.amount; i++) {
      if (gate) continue; // condition() is checked per item, after the amount is rolled
      const it = makeItem(g, s, cfg);
      if (it.failed) { row.failed = it.failed; continue; }
      row.items.push(it); items.push(it);
    }
    rows.push(row);
  }
  return { rows, items };
}

function simulateKill(s, cfg) {
  const mods = lootModifiers(s, cfg);
  const first = runGens(GENS, s, cfg, mods);
  let items = first.items.slice();

  // min-items floor (0 by default): keep re-running populateOnce and add one random item each time
  const fillers = [];
  let tries = 0;
  while (items.length < cfg.server.minItems && tries++ < 20) {
    const extra = runGens(GENS, s, cfg, mods).items;
    if (extra.length) { const it = extra[randInt(0, extra.length - 1)]; it.filler = true; fillers.push(it); items.push(it); }
  }

  const beforeCap = items.slice();
  const removed = [];
  tries = 0;
  while (items.length > cfg.server.maxItems && tries++ < 50) {
    const idx = randInt(0, items.length - 1);
    const [it] = items.splice(idx, 1);
    it.removed = true; removed.push(it);
  }

  const special = runGens(SPECIAL_GENS, s, cfg, mods);
  special.items.forEach(it => { it.special = true; });
  const final = items.concat(special.items);
  final.forEach(it => { it.announce = it.rar === 'unique' || it.rar === 'mythic'; });

  return { s, mods, rows: first.rows, specialRows: special.rows, beforeCap, removed, fillers, final };
}

// ---------------------------------------------------------------- atlas passive tree

const ATLAS = POOLS.atlas;
// atlas stat -> scenario field it adds to (the same stats the loot code reads)
const ATLAS_FIELD = {
  magic_find: 'mf', increased_quantity: 'iq', currency_find: 'find_currency', map_find: 'find_map', gem_find: 'find_gem',
  rune_find: 'find_rune', jewel_find: 'find_jewel', skill_gem_find: 'find_skillgem', omen_find: 'find_omen',
  watcher_eye_find: 'find_watcher', prophecy_coin_find: 'find_coin', map_rarity_bias: 'mapBias',
  boss_loot_quantity: 'bossLoot', extra_drop_from_mythics: 'mythicLoot',
};
let ATLAS_ON = new Set((store.get('cte2dm.atlas') || []).filter(i => ATLAS && i < ATLAS.nodes.length));
let ATLAS_MAX = store.get('cte2dm.atlasMax') ?? (ATLAS ? ATLAS.maxPoints : 0);

const perkOf = i => ATLAS.perks[ATLAS.nodes[i].perk];

function atlasTotals() {
  const t = {};
  if (!ATLAS) return t;
  for (const i of ATLAS_ON) {
    const p = perkOf(i);
    if (!p) continue;
    for (const st of p.stats) t[st.stat] = (t[st.stat] || 0) + st.v; // every atlas stat is FLAT
  }
  return t;
}

// The scenario with atlas stats added on top of the manual values.
function effective() {
  const s = { ...SCN };
  const t = atlasTotals();
  for (const [stat, f] of Object.entries(ATLAS_FIELD)) if (t[stat]) s[f] = (s[f] || 0) + t[stat];
  return s;
}

function atlasHelp(f) {
  if (!f.atlas) return '';
  const a = atlasTotals()[f.atlas] || 0;
  if (!a) return '<span class="help atlas-help"></span>';
  return `<span class="help atlas-help"><span class="plus">${a > 0 ? '+' : ''}${fmt(a)} atlas</span> → ${fmt((SCN[f.id] || 0) + a)} total</span>`;
}

function statName(stat) {
  for (const p of Object.values(ATLAS.perks)) for (const st of p.stats) if (st.stat === stat) return st.name;
  return pretty(stat);
}

function statLine([k, v]) {
  return `<div class="stat-line ${v < 0 ? 'neg' : ''}"><span>${esc(statName(k))}</span><b>${v > 0 ? '+' : ''}${fmt(v)}</b></div>`;
}

function atlasSummaryHtml() {
  if (!ATLAS) return '<p class="muted small">No atlas tree found in the pack data.</p>';
  const loot = Object.entries(atlasTotals()).filter(([k]) => ATLAS_FIELD[k]);
  return `<div class="field wide"><button type="button" class="btn open-atlas">${img(ATLAS.treeIcon, 'ico sm')} Open atlas tree · ${ATLAS_ON.size} / ${ATLAS_MAX} points</button></div>
    <div class="field wide atlas-summary">${loot.length ? loot.map(statLine).join('') : '<span class="muted">No drop stats allocated.</span>'}</div>`;
}

function canAllocate(i) {
  if (ATLAS_ON.has(i) || ATLAS_ON.size >= ATLAS_MAX) return false;
  const p = perkOf(i);
  if (!p) return false;
  if (!p.entry && !ATLAS.nodes[i].links.some(j => ATLAS_ON.has(j))) return false;
  if (p.one_kind && [...ATLAS_ON].some(j => perkOf(j)?.one_kind === p.one_kind)) return false;
  return true;
}

// TalentsData.canRemove: every allocated non-entry neighbour must still reach an entry node without this one
function canRemove(i) {
  if (!ATLAS_ON.has(i)) return false;
  for (const c of ATLAS.nodes[i].links) {
    if (!ATLAS_ON.has(c) || perkOf(c)?.entry) continue;
    if (!hasPathToStart(c, i)) return false;
  }
  return true;
}
function hasPathToStart(check, removing) {
  const open = [...ATLAS.nodes[check].links];
  const seen = new Set();
  while (open.length) {
    const cur = open.shift();
    if (cur === removing || !ATLAS_ON.has(cur)) continue;
    if (perkOf(cur)?.entry) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    open.push(...ATLAS.nodes[cur].links);
  }
  return false;
}

const ATLAS_VIEW = { x: 0, y: 0, w: 100, h: 100 };
const CELL = 10;
const NODE_R = { START: 11, MAJOR: 15, SPECIAL: 12, STAT: 9 };

function buildAtlasSvg() {
  const N = ATLAS.nodes;
  const lines = [];
  N.forEach((n, i) => n.links.forEach(j => {
    if (j > i) lines.push(`<line class="an-link" data-a="${i}" data-b="${j}" x1="${n.x * CELL}" y1="${n.y * CELL}" x2="${N[j].x * CELL}" y2="${N[j].y * CELL}"/>`);
  }));
  const nodes = N.map((n, i) => {
    const p = ATLAS.perks[n.perk] || { type: 'STAT', stats: [] };
    const r = NODE_R[p.entry ? 'START' : p.type] || 9;
    const shape = p.type === 'MAJOR' ? `<rect class="ring" x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" rx="4" transform="rotate(45)"/>`
      : p.type === 'SPECIAL' ? `<rect class="ring" x="${-r}" y="${-r}" width="${2 * r}" height="${2 * r}" rx="3"/>`
      : `<circle class="ring" r="${r}"/>`;
    const is = r * 1.3;
    return `<g class="an${p.loot ? ' loot' : ' dim'}" data-i="${i}" transform="translate(${n.x * CELL},${n.y * CELL})">${shape}${p.icon ? `<image href="${p.icon}" x="${-is / 2}" y="${-is / 2}" width="${is}" height="${is}"/>` : ''}</g>`;
  }).join('');
  const c = ATLAS.center;
  $('#atlasSvg').innerHTML = `<g id="atlasLinks">${lines.join('')}</g>${c ? `<circle class="an-center" cx="${c[0] * CELL}" cy="${c[1] * CELL}" r="16"/>` : ''}<g id="atlasNodes">${nodes}</g>`;
}

function fitAtlas() {
  const view = $('#atlasView');
  const xs = ATLAS.nodes.map(n => n.x * CELL), ys = ATLAS.nodes.map(n => n.y * CELL);
  const pad = 30;
  let x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  let w = Math.max(...xs) - Math.min(...xs) + 2 * pad, h = Math.max(...ys) - Math.min(...ys) + 2 * pad;
  // keep the view's aspect ratio so pan maths stays 1:1
  const ar = (view.clientWidth || 1) / (view.clientHeight || 1);
  if (w / h > ar) { const nh = w / ar; y -= (nh - h) / 2; h = nh; } else { const nw = h * ar; x -= (nw - w) / 2; w = nw; }
  Object.assign(ATLAS_VIEW, { x, y, w, h });
  applyAtlasView();
}
function applyAtlasView() {
  const v = ATLAS_VIEW;
  $('#atlasSvg').setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
}

function refreshAtlas() {
  $$('#atlasNodes .an').forEach(g => {
    const i = +g.dataset.i;
    const on = ATLAS_ON.has(i);
    g.classList.toggle('on', on);
    g.classList.toggle('can', !on && canAllocate(i));
  });
  $$('#atlasLinks line').forEach(l => {
    const a = ATLAS_ON.has(+l.dataset.a), b = ATLAS_ON.has(+l.dataset.b);
    l.classList.toggle('on', a && b);
    l.classList.toggle('half', a !== b);
  });
  $('#atlasUsed').textContent = ATLAS_ON.size;
  const t = Object.entries(atlasTotals());
  const loot = t.filter(([k]) => ATLAS_FIELD[k]);
  const other = t.filter(([k]) => !ATLAS_FIELD[k]);
  $('#atlasTotals').innerHTML = loot.length ? loot.map(statLine).join('') : '<p class="muted small">Nothing yet. Blue-ringed nodes change drops.</p>';
  $('#atlasOther').innerHTML = other.length ? other.map(statLine).join('') : '<p class="muted small">None.</p>';
}

function atlasChanged() {
  store.set('cte2dm.atlas', [...ATLAS_ON]);
  refreshAtlas();
  buildScenario();
  onScenarioChange();
}

function showAtlasTip(i, ev) {
  const tip = $('#atlasTip');
  const p = perkOf(i);
  if (!p) { tip.hidden = true; return; }
  let why;
  if (ATLAS_ON.has(i)) why = canRemove(i) ? 'Click to remove.' : "Can't remove: other allocated nodes depend on it.";
  else if (canAllocate(i)) why = 'Click to allocate.';
  else if (ATLAS_ON.size >= ATLAS_MAX) why = 'No points left.';
  else if (p.one_kind && [...ATLAS_ON].some(j => perkOf(j)?.one_kind === p.one_kind)) why = 'Only one of this kind can be taken.';
  else why = 'Must connect to an allocated node. Paths start at an Atlas Start node.';
  tip.innerHTML = `<h4>${esc(p.name)}</h4>${p.stats.map(st => `<div class="st">${st.v > 0 ? '+' : ''}${fmt(st.v)}${st.type === 'PERCENT' ? '%' : ''} ${esc(st.name)}</div>`).join('')}
    ${p.loot ? '' : '<div class="why">Doesn\'t change what a single kill drops.</div>'}<div class="why">${why}</div>`;
  tip.hidden = false;
  const box = $('#atlasView').getBoundingClientRect();
  let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
  if (x + 290 > box.width) x -= 310;
  if (y + 140 > box.height) y -= 160;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

function initAtlas() {
  if (!ATLAS) return;
  const dlg = $('#atlasDlg');
  const view = $('#atlasView');
  let drag = null;
  view.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, vx: ATLAS_VIEW.x, vy: ATLAS_VIEW.y, moved: false };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        view.classList.add('dragging');
        const sc = ATLAS_VIEW.w / view.clientWidth;
        ATLAS_VIEW.x = drag.vx - dx * sc;
        ATLAS_VIEW.y = drag.vy - dy * sc;
        applyAtlasView();
        $('#atlasTip').hidden = true;
        return;
      }
    }
    const g = document.elementFromPoint(e.clientX, e.clientY)?.closest('.an');
    if (g) showAtlasTip(+g.dataset.i, e); else $('#atlasTip').hidden = true;
  });
  view.addEventListener('pointerup', e => {
    const wasDrag = drag && drag.moved;
    drag = null;
    view.classList.remove('dragging');
    if (wasDrag) return;
    const g = document.elementFromPoint(e.clientX, e.clientY)?.closest('.an');
    if (!g) return;
    const i = +g.dataset.i;
    if (ATLAS_ON.has(i)) { if (!canRemove(i)) return; ATLAS_ON.delete(i); }
    else if (canAllocate(i)) ATLAS_ON.add(i);
    else return;
    atlasChanged();
    showAtlasTip(i, e);
  });
  view.addEventListener('wheel', e => {
    e.preventDefault();
    const box = view.getBoundingClientRect();
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const fx = (e.clientX - box.left) / box.width, fy = (e.clientY - box.top) / box.height;
    const px = ATLAS_VIEW.x + fx * ATLAS_VIEW.w, py = ATLAS_VIEW.y + fy * ATLAS_VIEW.h;
    ATLAS_VIEW.w *= k;
    ATLAS_VIEW.h *= k;
    ATLAS_VIEW.x = px - fx * ATLAS_VIEW.w;
    ATLAS_VIEW.y = py - fy * ATLAS_VIEW.h;
    applyAtlasView();
  }, { passive: false });
  $('#atlasClose').onclick = () => dlg.close();
  $('#atlasFit').onclick = fitAtlas;
  $('#atlasReset').onclick = () => { ATLAS_ON.clear(); atlasChanged(); };
  $('#atlasHighlight').onchange = e => view.classList.toggle('hl-off', !e.target.checked);
  const mx = $('#atlasMax');
  mx.value = ATLAS_MAX;
  $('#atlasMaxNote').textContent = `The pack's atlas map gives ${ATLAS.maxPoints} points in total (each placed node's reward, once). Lower it to match your own progress.`;
  mx.oninput = () => {
    ATLAS_MAX = Math.max(0, parseInt(mx.value, 10) || 0);
    store.set('cte2dm.atlasMax', ATLAS_MAX);
    // un-allocate the newest nodes that no longer fit, as long as removing them is legal
    for (const i of [...ATLAS_ON].reverse()) {
      if (ATLAS_ON.size <= ATLAS_MAX) break;
      if (canRemove(i)) ATLAS_ON.delete(i);
    }
    atlasChanged();
  };
}

let atlasBuilt = false;
function openAtlas() {
  if (!ATLAS) return;
  if (!atlasBuilt) buildAtlasSvg();
  refreshAtlas();
  $('#atlasDlg').showModal();
  if (!atlasBuilt) { fitAtlas(); atlasBuilt = true; }
}

// ---------------------------------------------------------------- UI: scenario form

function buildScenario() {
  const root = $('#scenario');
  root.innerHTML = '';
  for (const grp of SCHEMA) {
    if (grp.showIf && !grp.showIf(SCN)) continue;
    const d = document.createElement('details');
    d.className = 'group';
    d.open = store.get('cte2dm.open.' + grp.group) ?? grp.open;
    d.addEventListener('toggle', () => store.set('cte2dm.open.' + grp.group, d.open));
    d.innerHTML = `<summary>${esc(grp.group)}</summary><div class="fields"></div>`;
    const box = $('.fields', d);
    if (grp.atlasGroup) { box.classList.add('atlas-box'); box.innerHTML = atlasSummaryHtml(); const ob = $('.open-atlas', box); if (ob) ob.onclick = openAtlas; }
    for (const f of grp.fields) {
      if (f.showIf && !f.showIf(SCN)) continue;
      const w = document.createElement('div');
      w.className = 'field' + (f.wide ? ' wide' : '') + (f.type === 'check' ? ' checkfield' : '');
      const id = 'f_' + f.id;
      if (f.type === 'check') {
        w.innerHTML = `<input type="checkbox" id="${id}" ${SCN[f.id] ? 'checked' : ''}><label for="${id}">${esc(f.label)}</label>`;
      } else if (f.type === 'select') {
        w.innerHTML = `<label for="${id}">${esc(f.label)}</label><select id="${id}">${f.options().map(([v, l]) => `<option value="${v}" ${SCN[f.id] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      } else {
        w.innerHTML = `<label for="${id}">${esc(f.label)}</label><input type="number" id="${id}" value="${SCN[f.id]}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} step="${f.step || 1}">${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}${atlasHelp(f)}`;
      }
      const input = $('input,select', w);
      input.addEventListener(f.type === 'number' ? 'input' : 'change', () => {
        if (f.type === 'check') SCN[f.id] = input.checked;
        else if (f.type === 'select') SCN[f.id] = input.value;
        else { const v = parseFloat(input.value); SCN[f.id] = Number.isFinite(v) ? v : 0; const h = $('.atlas-help', w); if (h) h.outerHTML = atlasHelp(f); }
        store.set('cte2dm.scn', SCN);
        if (f.type !== 'number') buildScenario();
        onScenarioChange();
      });
      box.appendChild(w);
    }
    root.appendChild(d);
  }
  const rb = document.createElement('div');
  rb.className = 'group';
  rb.innerHTML = '<button class="btn ghost" id="resetScn">Reset scenario</button>';
  root.appendChild(rb);
  $('#resetScn').onclick = () => { SCN = defaultScenario(); store.set('cte2dm.scn', SCN); buildScenario(); onScenarioChange(); };
}

function onScenarioChange() {
  $('#mobTitle').textContent = `${MOB_NAME[SCN.mobRar]} mob · Lv ${SCN.mobLevel}${SCN.inMap ? ` · Map T${SCN.mapTier}` : ''}`;
  buildReels();
  renderOdds();
}

// ---------------------------------------------------------------- UI: reels

function reelHtml(g) {
  const E = effective();
  const gate = genCondition(g, E, CFG);
  const mods = lootModifiers(E, CFG);
  const ch = genChance(g, E, CFG, mods).chance;
  return `<div class="reel ${gate ? 'locked' : ''}" data-gen="${g.key}" title="${esc(g.label)}: ${fmt(ch, 3)}% chance${gate ? ' — ' + gate : ''}">
    <div class="sym">${img(g.icon, 'reel-ico')}</div><div class="num">${gate ? '🔒' : '–'}</div>
    <div class="name">${esc(g.label)}</div><div class="chance">${gate ? 'locked' : pct(ch, ch < 1 ? 3 : 1)}</div></div>`;
}
function buildReels() {
  $('#reels').innerHTML = GENS.map(reelHtml).join('');
  $('#bonusReels').innerHTML = SPECIAL_GENS.map(reelHtml).join('');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function animateReels(res, fast) {
  const rows = [...res.rows, ...res.specialRows];
  const reels = rows.map(r => $(`.reel[data-gen="${r.g.key}"]`));
  if (fast) { rows.forEach((r, i) => landReel(reels[i], r)); return; }
  const machine = $('.machine');
  machine.classList.add('spinning');
  reels.forEach(el => { el.classList.remove('hit', 'zero'); el.classList.add('spin'); });
  const syms = ALL_GENS.map(g => g.icon);
  const pool = [...syms, ...POOLS.currency.slice(0, 12).map(c => c.icon), ...POOLS.gems.slice(0, 8).map(x => x.icon)].filter(Boolean);
  const tick = setInterval(() => reels.forEach(el => {
    if (!el.classList.contains('spin')) return;
    $('.sym img', el)?.setAttribute('src', pool[randInt(0, pool.length - 1)]);
    $('.num', el).textContent = randInt(0, 3);
  }), 70);
  await sleep(450);
  for (let i = 0; i < rows.length; i++) { landReel(reels[i], rows[i]); await sleep(95); }
  clearInterval(tick);
  machine.classList.remove('spinning');
}
function landReel(el, row) {
  el.classList.remove('spin');
  const n = row.items.length;
  $('.sym', el).innerHTML = img(row.g.icon, 'reel-ico');
  const num = $('.num', el);
  num.textContent = row.gate ? (row.amount ? `🔒×${row.amount}` : '🔒') : n;
  num.classList.remove('land'); void num.offsetWidth; num.classList.add('land');
  el.classList.toggle('hit', n > 0);
  el.classList.toggle('zero', n === 0);
}

// ---------------------------------------------------------------- UI: loot tray

function itemHtml(it, i = 0) {
  const cls = ['item', 'rar-' + (RARS.includes(it.rar) ? it.rar : 'other')];
  if (it.special) cls.push('special');
  if (it.announce) cls.push('announce');
  if (it.removed) cls.push('removed');
  return `<div class="${cls.join(' ')}" style="animation-delay:${Math.min(i * 40, 900)}ms" title="${esc(GEN_BY_KEY[it.gen].label)}">
    <span class="ic">${img(it.icon)}</span><span><span class="t">${esc(it.name)}</span>${it.detail ? `<br><span class="d">${esc(it.detail)}${it.special ? ' · bonus pool' : ''}${it.announce ? ' · 📣 announced' : ''}</span>` : (it.special ? '<br><span class="d">bonus pool</span>' : '')}</span></div>`;
}

let SESSION = { kills: 0, items: 0, best: null };
const RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, other: 1, runeword: 5, mythic: 6, unique: 7 };

function renderTray(res) {
  const loot = $('#loot');
  loot.innerHTML = res.final.length ? res.final.map(itemHtml).join('') : '<p class="empty">Nothing dropped. That\'s most kills.</p>';
  $('#trayCount').textContent = `${res.final.length} item${res.final.length === 1 ? '' : 's'}${res.removed.length ? ` · ${res.removed.length} discarded by the cap` : ''}`;
  $('#discarded').innerHTML = res.removed.length
    ? `<h3>Randomly removed to get down to ${CFG.server.maxItems} items</h3><div class="loot">${res.removed.map(itemHtml).join('')}</div>` : '';
}

function updateSession(res) {
  SESSION.kills++;
  SESSION.items += res.final.length;
  for (const it of res.final) if (!SESSION.best || RANK[it.rar] > RANK[SESSION.best.rar]) SESSION.best = it;
  $('#session').innerHTML = `Session: <b>${SESSION.kills}</b> kills · <b>${SESSION.items}</b> items${SESSION.best ? ` · best: <span class="rc rar-${RARS.includes(SESSION.best.rar) ? SESSION.best.rar : 'other'}">${esc(SESSION.best.name)}</span>` : ''}`;
}

// ---------------------------------------------------------------- UI: steps

function stepCard(n, title, summary, body, open = false) {
  return `<details class="step" ${open ? 'open' : ''} style="animation-delay:${n * 60}ms"><summary><span class="n">${n}</span><span class="st">${title}</span><span class="sum">${summary}</span></summary><div class="body">${body}</div></details>`;
}

function chipsHtml(row) {
  if (!row.chunks.length) return '<span class="chip gate">0% — never rolls</span>';
  const show = row.chunks.length > 24 ? row.chunks.slice(0, 24) : row.chunks;
  let h = show.map(c => `<span class="chip ${c.ok ? 'ok' : 'no'}" title="rolled ${fmt(c.r, 2)} vs ${fmt(c.c, 3)}">${fmt(c.c, c.c < 1 ? 3 : 1)}% ${c.ok ? '✓' : '✗'}</span>`).join('');
  if (row.chunks.length > 24) h += `<span class="chip gate">+${row.chunks.length - 24} more</span>`;
  return `<div class="chips">${h}</div>`;
}

function rollTable(rows, special) {
  const body = rows.map(r => {
    const calc = r.steps.map((st, i) => i === 0 ? fmt(st.v, 3) : `<span title="${esc(st.label)}">× ${fmt(st.v, 3)}</span>`).join(' ');
    let res = `<b>${r.items.length}</b>`;
    if (r.gate && r.amount) res = `<span class="bad" title="${esc(r.gate)}">${r.amount} → 0</span>`;
    else if (r.failed) res = `<span class="bad" title="${esc(r.failed)}">${r.amount} → 0</span>`;
    return `<tr class="${!r.items.length ? 'dim' : ''}">
      <td class="tn">${img(r.g.icon, 'ico sm')} ${esc(r.g.label)}${r.gate ? `<br><small>🔒 ${esc(r.gate)}</small>` : ''}${r.failed ? `<br><small class="bad">${esc(r.failed)}</small>` : ''}</td>
      <td class="num">${calc}</td><td class="num"><b>${pct(r.chance, r.chance < 1 ? 3 : 2)}</b></td><td>${chipsHtml(r)}</td><td class="num">${res}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Type</th><th class="num">base × find × ${special ? '<s>modifiers</s>' : 'modifiers'} × relic</th><th class="num">Chance</th><th>Rolls (75% max each)</th><th class="num">Drops</th></tr></thead><tbody>${body}</tbody></table>`;
}

function wbarHtml(trace) {
  const tot = trace.total || 1;
  let cum = 0, mark = 0;
  const spans = trace.weights.map(w => {
    const start = cum; cum += w.w;
    if (trace.roll > start && trace.roll <= cum) mark = (start + (trace.roll - start)) / tot * 100;
    return `<span class="rar-${w.r}" style="width:${w.w / tot * 100}%" title="${RAR_NAME[w.r]} ${w.w}/${tot} = ${pct(w.w / tot * 100)}"></span>`;
  }).join('');
  return `<div class="wbar">${spans}<i style="left:${mark}%"></i></div>`;
}

function rarityTraceHtml(t) {
  const kindText = { gear: 'magic find', skillgem: 'magic find', jewel: 'fixed 50 (jewels ignore MF)', chest: 'fixed 75 (chests ignore MF)', map: 'map rarity bias (maps ignore MF)' }[t.kind];
  const w = t.weights.map(x => `<span class="rc rar-${x.r}">${RAR_NAME[x.r]}</span> ${x.w}${x.boosted && x.w !== x.base ? ` <small>(${x.base} × ${fmt(clamp(1 + t.cfh / 200, 1, 10))} MF boost)</small>` : ''}`).join(', ');
  let h = `<li>Eligible rarities &amp; weights: ${w}</li>`;
  h += `<li>Weighted roll <b>${t.roll}</b> of ${t.total} → <span class="rc rar-${t.picked}">${RAR_NAME[t.picked]}</span> (${pct((t.weights.find(x => x.r === t.picked)?.w || 0) / (t.total || 1) * 100)} chance)${wbarHtml(t)}</li>`;
  if (t.up) {
    const u = t.up;
    const res = u.ok ? (u.blocked ? `<span class="bad">succeeded but blocked: ${esc(u.blocked)}</span>` : `<span class="good">success → ${RAR_NAME[u.to]}</span>`) : '<span class="bad">failed</span>';
    h += `<li>Upgrade try to <span class="rc rar-${u.to}">${RAR_NAME[u.to]}</span>: ${kindText} <b>${fmt(t.cfh)}</b> × weight ratio ${G_ratioText(u)} = <b>${pct(u.chance)}</b>; rolled ${fmt(u.r)} → ${res}</li>`;
  } else {
    h += `<li>No upgrade step: ${RAR_NAME[t.picked]} has no higher rarity${t.picked === 'unique' || t.picked === 'runeword' ? ' (uniques/runewords are only reached by the weighted roll)' : ''}</li>`;
  }
  return h;
}
function G_ratioText(u) {
  const G = CFG.gearRarities;
  return `${G[u.to].w}/${G[u.from].w} = ${fmt(u.ratio, 3)}`;
}

function renderSteps(res) {
  const s = res.s;
  const out = [];
  // 1 modifiers
  const modRows = res.mods.mods.map(m => `<tr><td>${esc(m.name)}</td><td><small>${esc(m.why)}</small></td><td class="num ${m.multi > 1 ? 'good' : m.multi < 1 ? 'bad' : ''}">×${fmt(m.multi, 3)}</td></tr>`).join('');
  out.push(stepCard(1, 'Loot modifiers', `product ×${fmt(res.mods.product, 3)}`,
    `<p>Every normal drop type's chance is multiplied by the product of these (<code>LootInfo.gatherLootMultipliers</code>).</p>
     <table><tbody>${modRows}<tr class="total"><td>Product</td><td></td><td class="num">×${fmt(res.mods.product, 3)}</td></tr></tbody></table>`));

  // 2 type rolls
  const rolled = res.rows.reduce((a, r) => a + r.items.length, 0);
  out.push(stepCard(2, 'Roll every drop type independently', `${rolled} item${rolled === 1 ? '' : 's'} rolled`,
    `<p>Each of the 12 generators runs on its own. Its chance is split into chunks of at most ${CFG.server.rollCap}%, and each chunk is one roll. So 180% becomes 75% + 75% + 30%: up to 3 drops, about 1.8 on average.</p>
     ${rollTable(res.rows, false)}
     <p class="note">The level/league gate (🔒) is checked <i>after</i> the count is rolled, once per item, so a gated type can "hit" and still drop nothing.</p>`, true));

  // 3 item rolls
  const all = [...res.rows.flatMap(r => r.items), ...res.fillers];
  const itemsBody = all.length ? all.map(it => {
    const lines = [];
    if (it.trace) lines.push(rarityTraceHtml(it.trace));
    it.notes.forEach(n => lines.push(`<li>${n}</li>`));
    return `<div class="itemroll"><div class="hd">${img(it.icon, 'ico sm')} <span class="rc rar-${RARS.includes(it.rar) ? it.rar : 'other'}">${esc(it.name)}</span><small>${esc(GEN_BY_KEY[it.gen].label)}${it.filler ? ' · min-items filler' : ''}</small></div>${lines.length ? `<ol>${lines.join('')}</ol>` : ''}</div>`;
  }).join('') : '<p class="muted">No items to roll this time.</p>';
  out.push(stepCard(3, 'Roll each item: rarity, then a magic find upgrade', `${all.length} item${all.length === 1 ? '' : 's'}`,
    `<p>Items with a rarity roll it from the weight table, then get <b>one</b> chance to go up exactly one tier: <code>chance = MF × (higher weight ÷ current weight)</code>. There's never a +2 jump, and Unique/Runed aren't upgrade targets. Magic find instead multiplies their weight by <code>1 + MF/200</code>.</p>${itemsBody}`, all.length > 0 && all.length <= 6));

  // 4 cap
  out.push(stepCard(4, `Cap at ${CFG.server.maxItems} items`, res.removed.length ? `${res.beforeCap.length} → ${res.beforeCap.length - res.removed.length} (${res.removed.length} removed)` : `${res.beforeCap.length} ≤ ${CFG.server.maxItems}, nothing removed`,
    res.removed.length
      ? `<p>${res.beforeCap.length} items rolled. Random items are removed one at a time until ${CFG.server.maxItems} are left. Every item has the same odds of being removed, rarity doesn't matter.</p>
         ${res.beforeCap.length - res.removed.length > CFG.server.maxItems ? `<p class="note"><b>The cap gave up.</b> The mod's removal loop stops after 50 tries, so a kill that rolls more than ${CFG.server.maxItems + 50} items keeps everything past that: ${res.beforeCap.length - res.removed.length} items stay here.</p>` : ''}
         <div class="loot">${res.removed.map(itemHtml).join('')}</div>`
      : `<p>${res.beforeCap.length} items, under the cap of ${CFG.server.maxItems}. The cap only matters on high-multiplier kills (bosses, lots of Item Find, parties).${CFG.server.minItems > 0 ? ` The min-items floor is ${CFG.server.minItems}${res.fillers.length ? `, and it added ${res.fillers.length} filler item(s)` : ''}.` : ''}</p>`));

  // 5 special
  const sp = res.specialRows.reduce((a, r) => a + r.items.length, 0);
  out.push(stepCard(5, "Bonus pool: Abyssal Eye (Watcher's Eye) and Pinnacle Gems", sp ? `${sp} bonus drop${sp === 1 ? '' : 's'}` : 'none',
    `<p>These roll <b>after</b> the cap, so they never count toward it or get removed. Loot modifiers (mob rarity, Item Find, party…) <b>don't</b> apply; only their own find stat and map relics do.</p>
     ${rollTable(res.specialRows, true)}
     <p class="note">Abyssal Eye (the Watcher's Eye jewel): uber bosses only. Pinnacle Gem: pinnacle bosses only; at 100% it rolls 75% + 25%, so 0, 1 or 2 gems (1 on average).</p>`));

  // 6 final
  const ann = res.final.filter(x => x.announce);
  out.push(stepCard(6, 'Drop on the ground', `${res.final.length} item${res.final.length === 1 ? '' : 's'}${ann.length ? ` · ${ann.length} announced` : ''}`,
    `<p>Everything left spawns at the mob. Unique and Mythic drops are announced in chat (<code>ItemUtils.tryAnnounceItem</code>), and uniques play a ding.</p>`));

  $('#tab-steps').innerHTML = out.join('');
}

// ---------------------------------------------------------------- UI: odds sheet (analytic)

function rarityDistribution(kind, s, cfg) {
  const G = cfg.gearRarities, lvl = s.mobLevel;
  const possible = possibleRarities(kind, lvl, G);
  const cfh = higherChanceFor(kind, s, cfg);
  const weights = rarityWeights(kind, possible, cfh, G);
  const total = weights.reduce((a, x) => a + x.w, 0) || 1;
  const p0 = Object.fromEntries(RARS.map(r => [r, 0]));
  weights.forEach(x => { p0[x.r] = x.w / total; });
  const p = { ...p0 };
  for (const r of possible) {
    const h = G[r].higher;
    if (!h || !possible.includes(h) || lvl < G[h].min) continue;
    const u = clamp(cfh * clamp(G[h].w / G[r].w, 0, 1), 0, 100) / 100;
    p[r] -= p0[r] * u; p[h] += p0[r] * u;
  }
  return { p0, p, possible };
}

function renderOdds() {
  const s = effective(), cfg = CFG;
  const mods = lootModifiers(s, cfg);
  let pNone = 1, exp = 0;
  const rows = ALL_GENS.map(g => {
    const { chance, modified } = genChance(g, s, cfg, mods);
    const gate = genCondition(g, s, cfg);
    const e = gate ? 0 : chance / 100;
    let p0 = 1, c = chance;
    while (c > 0) { const k = Math.min(c, cfg.server.rollCap); p0 *= 1 - k / 100; c -= k; }
    if (!gate && !g.special) { pNone *= p0; exp += e; }
    const oneIn = e > 0 ? (e >= 1 ? '—' : `1 in ${fmt(1 / e, e > 0.01 ? 1 : 0)}`) : '—';
    return `<tr class="${gate ? 'dim' : ''}"><td class="tn">${img(g.icon, 'ico sm')} ${esc(g.label)}${g.special ? ' <small>(bonus)</small>' : ''}${gate ? `<br><small>🔒 ${esc(gate)}</small>` : ''}</td>
      <td class="num">${fmt(cfg.rates[g.rate], 3)}%</td><td class="num">${modified ? '×' + fmt(mods.product, 2) : '<small>not applied</small>'}</td>
      <td class="num"><b>${pct(chance, chance < 1 ? 3 : 2)}</b></td><td class="num">${gate ? '0' : fmt(e, 4)}</td><td class="num">${gate ? '0%' : pct((1 - p0) * 100)}</td><td class="num">${gate ? '—' : oneIn}</td></tr>`;
  }).join('');

  const distTable = (kind, title, note) => {
    const d = rarityDistribution(kind, s, cfg);
    const r = RARS.filter(x => d.possible.includes(x)).map(x => `<tr><td class="rc rar-${x}">${RAR_NAME[x]}</td><td class="num">${pct(d.p0[x] * 100)}</td><td class="num"><b>${pct(d.p[x] * 100)}</b></td><td class="barcell"><div class="bar rar-${x}" style="--c:var(--r-${x});width:${Math.max(0.5, d.p[x] * 100)}%"></div></td></tr>`).join('');
    const missing = RARS.filter(x => !d.possible.includes(x));
    return `<div><h3>${title}</h3><table><thead><tr><th>Rarity</th><th class="num">Weight roll</th><th class="num">After upgrade</th><th></th></tr></thead><tbody>${r}</tbody></table>
      <p class="note">${note}${missing.length ? ` Can't roll here: ${missing.map(x => RAR_NAME[x]).join(', ')}.` : ''}</p></div>`;
  };

  const G = cfg.gearRarities;
  const ratioRows = NORMAL_RARS.filter(r => G[r].higher).map(r => {
    const h = G[r].higher, ratio = clamp(G[h].w / G[r].w, 0, 1);
    return `<tr><td><span class="rc rar-${r}">${RAR_NAME[r]}</span> → <span class="rc rar-${h}">${RAR_NAME[h]}</span></td><td class="num">${G[h].w}/${G[r].w} = ${fmt(ratio, 3)}</td>
      ${[50, 100, 150].map(m => `<td class="num">${pct(m * ratio, 1)}</td>`).join('')}<td class="num"><b>${pct(Math.min(s.mf, cfg.server.mfCap) * ratio, 1)}</b></td><td class="num">${G[h].min ? 'Lv ' + G[h].min : '—'}</td></tr>`;
  }).join('');

  $('#tab-odds').innerHTML = `
    <p>Exact odds for the current scenario, worked out from the formulas instead of sampled. Change anything on the left and this updates.</p>
    <div class="kpis">
      <div class="kpi"><b>${fmt(exp, 3)}</b><span>expected normal drops per kill</span></div>
      <div class="kpi"><b>${pct((1 - pNone) * 100)}</b><span>chance of at least one normal drop</span></div>
      <div class="kpi"><b>×${fmt(mods.product, 3)}</b><span>loot modifier product</span></div>
      <div class="kpi"><b>${fmt(Math.min(s.mf, cfg.server.mfCap), 0)}</b><span>effective magic find${s.mf > cfg.server.mfCap ? ` (capped from ${s.mf})` : ''}</span></div>
    </div>
    <h3>Per drop type</h3>
    <table><thead><tr><th>Type</th><th class="num">Base</th><th class="num">Modifiers</th><th class="num">Final chance</th><th class="num">Expected / kill</th><th class="num">≥1 drop</th><th class="num">Roughly</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">Expected drops per kill are exactly <code>chance ÷ 100</code>. The 75% chunking changes the spread (how often you get 0, 1, 2…), not the average. Watch the 20-item cap at very high chances, though.</p>
    <h3>Magic find upgrade chance per step</h3>
    <table><thead><tr><th>Step</th><th class="num">Weight ratio</th><th class="num">50 MF</th><th class="num">100 MF</th><th class="num">150 MF</th><th class="num">Your MF</th><th class="num">Needs</th></tr></thead><tbody>${ratioRows}</tbody></table>
    <div class="two">
      ${distTable('gear', 'Gear rarity (and Stat Souls)', `Unique &amp; Runed weights include the MF boost (×${fmt(clamp(1 + Math.min(s.mf, cfg.server.mfCap) / 200, 1, 10))}). A Unique with no eligible item becomes Common.`)}
      ${distTable('skillgem', 'Augment &amp; Support gem rarity', 'Uses MF. The mod\'s rarity filter lets Common–Legendary through at any level (only Mythic is level-gated), because of how its condition is grouped.')}
      ${distTable('jewel', 'Jewel rarity', 'Jewels ignore your MF. Their upgrade chance is fixed at 50.')}
      ${distTable('map', 'Map rarity', 'Maps ignore MF and level gates, only Map Rarity Bias upgrades them. Inside a map, a tier floor then pushes low rolls up.')}
    </div>`;
}

// ---------------------------------------------------------------- UI: bulk test

function runBulk(n) {
  const out = $('#bulkOut');
  out.innerHTML = '<p class="muted">Simulating…</p>';
  setTimeout(() => {
    const t0 = performance.now();
    const byGen = Object.fromEntries(ALL_GENS.map(g => [g.key, 0]));
    const byRar = Object.fromEntries([...RARS, 'other'].map(r => [r, 0]));
    const gearRar = Object.fromEntries(RARS.map(r => [r, 0]));
    let total = 0, capped = 0, removed = 0, empty = 0, maxDrop = 0;
    const named = {};
    const E = effective();
    for (let i = 0; i < n; i++) {
      const r = simulateKill(E, CFG);
      total += r.final.length; if (!r.final.length) empty++;
      maxDrop = Math.max(maxDrop, r.final.length);
      if (r.removed.length) { capped++; removed += r.removed.length; }
      for (const it of r.final) {
        byGen[it.gen]++; byRar[RARS.includes(it.rar) ? it.rar : 'other']++;
        if (it.gen === 'gear') gearRar[it.rar]++;
        if (it.unique || it.gen === 'watcher' || it.gen === 'pinnacle') named[it.name] = (named[it.name] || 0) + 1;
      }
    }
    const ms = performance.now() - t0;
    const genRows = ALL_GENS.filter(g => byGen[g.key]).map(g => `<tr><td class="tn">${img(g.icon, 'ico sm')} ${esc(g.label)}</td><td class="num">${byGen[g.key].toLocaleString()}</td><td class="num">${fmt(byGen[g.key] / n, 4)}</td><td class="barcell"><div class="bar" style="width:${byGen[g.key] / Math.max(...Object.values(byGen)) * 100}%"></div></td></tr>`).join('');
    const gTot = Object.values(gearRar).reduce((a, b) => a + b, 0) || 1;
    const rarRows = RARS.filter(r => gearRar[r]).map(r => `<tr><td class="rc rar-${r}">${RAR_NAME[r]}</td><td class="num">${gearRar[r].toLocaleString()}</td><td class="num">${pct(gearRar[r] / gTot * 100)}</td><td class="barcell"><div class="bar" style="--c:var(--r-${r});width:${gearRar[r] / gTot * 100}%"></div></td></tr>`).join('');
    const top = Object.entries(named).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `<tr><td class="rc rar-unique">${esc(k)}</td><td class="num">${v}</td></tr>`).join('');
    out.innerHTML = `
      <div class="kpis">
        <div class="kpi"><b>${n.toLocaleString()}</b><span>kills simulated (${fmt(ms, 0)} ms)</span></div>
        <div class="kpi"><b>${fmt(total / n, 3)}</b><span>items per kill</span></div>
        <div class="kpi"><b>${pct(empty / n * 100, 1)}</b><span>kills with no drop</span></div>
        <div class="kpi"><b>${maxDrop}</b><span>most items from one kill</span></div>
        <div class="kpi"><b>${pct(capped / n * 100, 1)}</b><span>kills that hit the ${CFG.server.maxItems}-item cap</span></div>
        <div class="kpi"><b>${removed.toLocaleString()}</b><span>items thrown away by the cap</span></div>
      </div>
      <div class="two">
        <div><h3>Drops by type</h3><table><thead><tr><th>Type</th><th class="num">Total</th><th class="num">Per kill</th><th></th></tr></thead><tbody>${genRows || '<tr><td colspan="4" class="muted">Nothing dropped.</td></tr>'}</tbody></table></div>
        <div><h3>Gear by rarity</h3><table><thead><tr><th>Rarity</th><th class="num">Count</th><th class="num">Share</th><th></th></tr></thead><tbody>${rarRows || '<tr><td colspan="4" class="muted">No gear.</td></tr>'}</tbody></table>
        ${top ? `<h3>Uniques &amp; special drops</h3><table><tbody>${top}</tbody></table>` : ''}</div>
      </div>`;
  }, 20);
}

// ---------------------------------------------------------------- UI: rules tab

function renderRules() {
  $('#tab-rules').innerHTML = `<div class="rules">
  <p>What happens when a player kills a mob, in the order the mod does it (<code>MasterLootGen.generateLoot</code>). Steps marked <span class="new">EXTRA</span> are easy to miss.</p>
  <ol class="flow">
    <li><h4>Gather the loot modifiers <span class="new">EXTRA</span></h4>
      <p>One product of multipliers applies to every normal drop type: level gap penalty, mob HP (1 + HP/40, max ×10; bosses use forced HP), entity datapack multi, mob affix bonus, <b>mob rarity loot_multi</b>, Atlas boss/mythic loot, party bonus, the ×2 under-level-10 boost, favor rank, Item Find, dimension multi, and either the map tier bonus (1 + tier × 0.02) or the anti-mob-farm multi.</p></li>
    <li><h4>Roll each of the 12 drop types independently</h4>
      <p>Gear, Gear Stat Soul, Augment gem, Support gem, Jewel, Currency, Map, Gem, Rune, Loot Chest, Prophecy Coin, Codex. There's no weight table between types, so one kill can drop gear, a rune and currency together.</p>
      <ul><li><code>chance = base rate × (1 + type find%) × modifier product × (1 + map relic%)</code></li>
      <li>Currency, map, gem, rune, jewel, skill gem, omen and prophecy coin have their own find stat folded into the base. Gear and souls don't.</li>
      <li>Prophecy coins also scale with map tier and prophecy affixes taken, and are 0 outside maps.</li>
      <li><span class="new">EXTRA</span> The atlas passive tree adds flat points to these find stats, Map Rarity, Boss Loot and Mythic Extra Drops. It has no Magic Find or Item Quantity nodes; those come from gear and buffs.</li></ul></li>
    <li><h4>Split the chance into rolls of 75% at most</h4>
      <p><code>WhileRoll</code>: 180% → 75% + 75% + 30%. Each chunk is one independent roll, and every success is one item. The average is always chance ÷ 100. The cap just stops a single roll from being a guaranteed drop.</p></li>
    <li><h4>Check the type's gate, per item <span class="new">EXTRA</span></h4>
      <p>Augment gems and runes need mob level &gt; 10. Support gems, jewels and currency need &gt; 5. Maps need &gt; <code>min_level_map_drops</code>. Codexes and gems need something droppable at that level. League-only currency (Harvest/Obelisk orbs) only shows up in its league.</p></li>
    <li><h4>Roll the item's rarity from the weight table</h4>
      <p>Only rarities you're high enough level for are eligible (e.g. Mythic needs level 50). For gear, Unique and Runed weights are multiplied by <code>1 + MF/200</code> (max ×10). That's the only way MF gets you a Unique.</p></li>
    <li><h4>One magic find upgrade try</h4>
      <p><code>chance = MF × (higher weight ÷ current weight)</code>, then rolled as a percent. It's one step only (Rare → Epic, never Rare → Legendary). Mythic, Unique and Runed have nothing above them. If the higher rarity needs more level than the mob has, a successful roll is thrown away. MF caps at 150.</p>
      <ul><li><span class="new">EXTRA</span> Jewels ignore your MF (fixed 50), loot chests too (fixed 75), maps use only the Atlas <i>Map Rarity Bias</i>, and Codexes get no upgrade try at all.</li></ul></li>
    <li><h4>Gear picks a real base item <span class="new">EXTRA</span></h4>
      <p>A weighted gear slot, then a weighted base type in that slot (e.g. Boots → Plate Boots), then one of its six item models. Only models whose minimum rarity fits the rolled rarity's <i>item tier</i> are allowed, weighted 1 / 10 / 100 / 1,000 / 10,000 / 100,000, so you almost always get the highest-tier model allowed. Runed (tier 10) and Unique (tier 5) use the top models. If no model fits, the mod drops a Gear Stat Soul instead.</p></li>
    <li><h4>Unique gear picks an actual unique <span class="new">EXTRA</span></h4>
      <p>From uniques with weight &gt; 0 that pass level, <b>map tier</b> (outside maps the tier is 0, so min_tier uniques can't drop) and league (Harvest, Obelisk, Strongbox, Prophecy… uniques only drop there). It prefers one matching the rolled slot. If none is eligible, <b>the item becomes Common</b>.</p></li>
    <li><h4>Maps inside maps get a tier floor <span class="new">EXTRA</span></h4>
      <p>The rolled rarity gives a tier band. Inside a map, a floor is rolled between (tier − falloff) and (tier + rise), with a tighter band for the final boss. If the floor is higher, the map goes up to it and its rarity follows the tier.</p></li>
    <li><h4>Cap at 20 items</h4>
      <p>If more than <code>maxItems</code> (20 for mobs, 7 chests, 1 spawners) were rolled, random items are deleted one by one, no matter their rarity. A min-items floor also exists (0 for mobs).</p>
      <ul><li><span class="new">EXTRA</span> The removal loop gives up after 50 tries, so a kill that rolls more than 70 items (big bosses with lots of Item Find) keeps everything past 70.</li></ul></li>
    <li><h4>Bonus pool: Abyssal Eye &amp; Pinnacle Gems</h4>
      <p>Rolled <b>after</b> the cap, so they're never removed. The loot modifier product isn't applied, only their own find stat and map relics. Abyssal Eye (the mod's Watcher's Eye): uber bosses only, 1/2/3 aura affixes at level 50/75/100 (it fails below 50). Pinnacle Gem: pinnacle bosses only, 100% → 75% + 25%, so up to 2.</p></li>
    <li><h4>Announce</h4>
      <p>Unique and Mythic drops are announced in chat, and uniques play a ding.</p></li>
  </ol>
  <p class="note">Not modeled: slime size penalty, mercenary kills (their find stats stack on the owner's), chest/spawner loot origins, the exact affixes/stats on each item. Loot Chests and Stat Souls are 0% in the CTE2 config but work if you raise their rate.</p>
  </div>`;
}

// ---------------------------------------------------------------- UI: settings

function numInput(path, val, step = 'any', cls = '') {
  return `<input type="number" step="${step}" data-path="${path}" value="${val}" class="${cls}">`;
}
function getPath(o, p) { return p.split('.').reduce((a, k) => a?.[k], o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }

function buildSettings() {
  const mod = PRESETS.mod, pack = PRESETS.pack;
  const ref = (p) => `<span class="ref">${getPath(pack, p)} / ${getPath(mod, p)}</span>`;
  const rates = RATE_ROWS.map(([k, cfgName]) => `<tr><td class="tn">${img(GEN_BY_KEY[k].icon, 'ico sm')} ${esc(GEN_BY_KEY[k].label)}<br><small><code>${cfgName}</code></small></td><td>${numInput('rates.' + k, CFG.rates[k])}</td><td>${ref('rates.' + k)}</td></tr>`).join('');
  const srv = [
    ['maxItems', 'Max items per mob kill', 1], ['minItems', 'Min items per kill', 1], ['rollCap', 'Max chance per roll (WhileRoll cap)', 1], ['mfCap', 'Magic Find cap', 1],
    ['leeway', 'LEVEL_DISTANCE_PENALTY_LEEWAY', 1], ['perLvl', 'lvl_distance_loot_penalty_per_level'], ['minMulti', 'min_loot_chance'],
    ['party', 'PARTY_DROP_BONUS'], ['minLvlMaps', 'min_level_map_drops', 1], ['mapFalloff', 'MAP_TIER_DROP_FALLOFF', 1], ['mapRise', 'MAP_TIER_DROP_RISE', 1],
    ['bossFalloff', 'MAP_BOSS_TIER_FALLOFF', 1], ['bossRise', 'MAP_BOSS_TIER_RISE', 1], ['maxLevel', 'Max level (game balance)', 1],
  ].map(([k, l, st]) => `<tr><td>${esc(l)}</td><td>${numInput('server.' + k, CFG.server[k], st || 'any')}</td><td>${ref('server.' + k)}</td></tr>`).join('');
  const gr = RARS.map(r => { const g = CFG.gearRarities[r]; return `<tr><td class="rc rar-${r}">${RAR_NAME[r]}</td><td>${numInput(`gearRarities.${r}.w`, g.w, 1)}</td><td>${numInput(`gearRarities.${r}.min`, g.min, 1)}</td><td>${g.higher ? RAR_NAME[g.higher] : '—'}</td><td>${g.type === 'NORMAL' ? numInput(`gearRarities.${r}.tiers.0`, g.tiers[0], 1) + ' – ' + numInput(`gearRarities.${r}.tiers.1`, g.tiers[1], 1) : '—'}</td><td>${ref(`gearRarities.${r}.w`)}</td></tr>`; }).join('');
  const mr = MOB_RARS.map(r => { const m = CFG.mobRarities[r]; return `<tr><td>${MOB_NAME[r]}</td><td>${numInput(`mobRarities.${r}.loot`, m.loot)}</td><td>${numInput(`mobRarities.${r}.hp`, m.hp, 1)}</td></tr>`; }).join('');
  const fv = NORMAL_RARS.map(r => `<tr><td class="rc rar-${r}">${RAR_NAME[r]}</td><td>${numInput('favor.' + r, CFG.favor[r])}</td></tr>`).join('');
  $('#settingsBody').innerHTML = `
    <div class="two">
      <div><h3>Drop rates (% per kill before modifiers)</h3><table><thead><tr><th>Type</th><th>Value</th><th>CTE2 / mod</th></tr></thead><tbody>${rates}</tbody></table></div>
      <div><h3>Rules</h3><table><thead><tr><th>Setting</th><th>Value</th><th>CTE2 / mod</th></tr></thead><tbody>${srv}</tbody></table></div>
    </div>
    <h3>Gear rarities (<code>mmorpg_gear_rarity</code>): also used by gems, jewels, maps, chests</h3>
    <table><thead><tr><th>Rarity</th><th>Weight</th><th>Min level</th><th>Upgrades to</th><th>Map tier band</th><th>CTE2 / mod weight</th></tr></thead><tbody>${gr}</tbody></table>
    <div class="two">
      <div><h3>Mob rarities (<code>mmorpg_mob_rarity</code>)</h3><table><thead><tr><th>Mob</th><th>loot_multi</th><th>Forced HP (−1 = none)</th></tr></thead><tbody>${mr}</tbody></table></div>
      <div><h3>Favor rank loot multi</h3><table><thead><tr><th>Rank</th><th>Multi</th></tr></thead><tbody>${fv}</tbody></table></div>
    </div>`;
  $$('#settingsBody input[data-path]').forEach(inp => {
    const p = inp.dataset.path;
    const packV = getPath(PRESETS.pack, p);
    inp.classList.toggle('changed', getPath(CFG, p) !== packV);
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      setPath(CFG, p, v);
      CFG.name = 'Custom';
      inp.classList.toggle('changed', v !== packV);
      saveCfg();
    });
  });
}
function saveCfg() { store.set('cte2dm.cfg', CFG); $('#presetTag').textContent = 'Settings: ' + CFG.name; buildScenario(); onScenarioChange(); }

// ---------------------------------------------------------------- wiring

let busy = false;
async function pull(fast) {
  if (busy) return;
  busy = true;
  $('#pull').disabled = true; $('#pull10').disabled = true;
  const res = simulateKill(effective(), CFG);
  await animateReels(res, fast);
  renderTray(res);
  renderSteps(res);
  updateSession(res);
  $('#pull').disabled = false; $('#pull10').disabled = false;
  busy = false;
  return res;
}

function init() {
  buildScenario();
  onScenarioChange();
  renderRules();
  initAtlas();
  $('#presetTag').textContent = 'Settings: ' + CFG.name;

  $('#pull').addEventListener('click', () => pull($('#fast').checked));
  $('#pull10').addEventListener('click', async () => {
    for (let i = 0; i < 10; i++) { await pull(true); await sleep(120); }
  });
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    $$('.tab-body').forEach(t => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
  }));
  $$('[data-bulk]').forEach(b => b.addEventListener('click', () => runBulk(+b.dataset.bulk)));

  const dlg = $('#settings');
  $('#openSettings').addEventListener('click', () => { buildSettings(); dlg.showModal(); });
  $$('[data-preset]').forEach(b => b.addEventListener('click', () => { CFG = clone(PRESETS[b.dataset.preset]); saveCfg(); buildSettings(); }));
  $('#exportCfg').addEventListener('click', async () => {
    const txt = JSON.stringify(CFG, null, 2);
    try { await navigator.clipboard.writeText(txt); $('#exportCfg').textContent = 'Copied ✓'; } catch { prompt('Copy this:', txt); }
    setTimeout(() => { $('#exportCfg').textContent = 'Copy as JSON'; }, 1500);
  });
  $('#importCfg').addEventListener('click', () => {
    const txt = prompt('Paste settings JSON:');
    if (!txt) return;
    try { const o = JSON.parse(txt); if (!o.rates || !o.server || !o.gearRarities) throw 0; CFG = o; CFG.name = CFG.name || 'Imported'; saveCfg(); buildSettings(); }
    catch { alert("That doesn't look like settings JSON from this page."); }
  });

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(document.activeElement.tagName) && !dlg.open) { e.preventDefault(); pull($('#fast').checked); }
  });
}

init();
