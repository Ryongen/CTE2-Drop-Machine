"""
Rebuilds pools.js and icons/ from an installed Craft to Exile 2 instance.

    python tools/extract.py ["path/to/instance/minecraft"]

Data (JSON) comes from every mod jar, then the pack's openloader datapack overrides on top.
Names come from every mod's en_us.json, then the pack's openloader lang overrides on top.
Icons are resolved like Minecraft does: item model -> parent chain -> layer0 texture,
with openloader resource overrides winning over the jars. Animated textures keep their first frame.
"""
import glob
import io
import json
import os
import re
import sys
import zipfile

from PIL import Image

INST = sys.argv[1] if len(sys.argv) > 1 else r"G:/PrismLauncher/instances/Craft to Exile 2 - 2.0 Atlas Update Test/minecraft"
OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(OUT, "icons")


# ------------------------------------------------------------------ file sources

class Source:
    """A jar/zip or a folder, both addressed with 'assets/...' / 'data/...' paths."""

    def __init__(self, path):
        self.path = path
        if os.path.isdir(path):
            self.zip = None
            self.names = set()
            for root, _, files in os.walk(path):
                for f in files:
                    self.names.add(os.path.relpath(os.path.join(root, f), path).replace("\\", "/"))
        else:
            self.zip = zipfile.ZipFile(path)
            self.names = set(self.zip.namelist())

    def read(self, name):
        if self.zip:
            return self.zip.read(name)
        with open(os.path.join(self.path, name), "rb") as f:
            return f.read()


def jar_sources():
    return [Source(j) for j in sorted(glob.glob(os.path.join(INST, "mods", "*.jar")))]


def openloader_dirs(kind):
    base = os.path.join(INST, "config", "openloader", kind)
    return [Source(d) for d in sorted(glob.glob(os.path.join(base, "*"))) if os.path.isdir(d)]


def vanilla_jar():
    for base in [os.path.expandvars(r"%APPDATA%/PrismLauncher"), os.path.join(INST, "..", "..", "..")]:
        p = os.path.join(base, "libraries", "com", "mojang", "minecraft", "1.20.1", "minecraft-1.20.1-client.jar")
        if os.path.exists(p):
            return [Source(p)]
    print("  vanilla client jar not found; vanilla textures will be missing")
    return []


print("indexing jars...")
JARS = vanilla_jar() + jar_sources()
DATA = JARS + openloader_dirs("data")          # later wins
ASSETS = JARS + openloader_dirs("resources")   # later wins


def find(sources, name):
    for s in reversed(sources):
        if name in s.names:
            return s.read(name)
    return None


def load_json(b):
    return json.loads(b.decode("utf-8-sig"), strict=False)  # some pack JSON embeds raw newlines (tree grids)


def registry(folder):
    """All JSON under data/*/<folder>/, keyed by file name, overrides applied."""
    out = {}
    pat = re.compile(r"^data/[^/]+/" + re.escape(folder) + r"/(.+)\.json$")
    for s in DATA:
        for n in s.names:
            m = pat.match(n)
            if m:
                try:
                    out[m.group(1).split("/")[-1]] = load_json(s.read(n))
                except Exception:
                    pass
    return out


# ------------------------------------------------------------------ lang

print("merging lang...")
LANG = {}
for s in ASSETS:
    for n in s.names:
        if re.match(r"^assets/[^/]+/lang/en_us\.json$", n):
            try:
                LANG.update(load_json(s.read(n)))
            except Exception:
                pass


def name(*keys, fallback=None):
    for k in keys:
        if k in LANG:
            txt = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", LANG[k])  # wiki links: [Text](page) -> Text
            return re.sub(r"§.", "", txt).strip()
    return fallback


def pretty(i):
    return re.sub(r"\b\w", lambda m: m.group(0).upper(), i.replace("_", " "))


def item_name(item_id):
    ns, path = item_id.split(":", 1)
    return name(f"item.{ns}.{path.replace('/', '.')}", f"block.{ns}.{path.replace('/', '.')}", fallback=pretty(path.split("/")[-1]))


# ------------------------------------------------------------------ icons

ICONS = {}


FLAT_PARENTS = {"item/generated", "minecraft:item/generated", "item/handheld", "minecraft:item/handheld", "builtin/generated"}


def resolve_model(item_id):
    """Walk the item model's parent chain like Minecraft does."""
    ns, path = item_id.split(":", 1)
    model = f"{ns}:item/{path}"
    out = {"textures": {}, "elements": None, "gui": None, "tex_size": None, "flat": False, "found": False}
    for _ in range(16):
        mns, mpath = model.split(":", 1) if ":" in model else ("minecraft", model)
        b = find(ASSETS, f"assets/{mns}/models/{mpath}.json")
        if b is None:
            break
        out["found"] = True
        m = load_json(b)
        for k, v in (m.get("textures") or {}).items():
            out["textures"].setdefault(k, v)
        if out["elements"] is None and m.get("elements"):
            out["elements"] = m["elements"]
            out["tex_size"] = m.get("texture_size")
        if out["gui"] is None and (m.get("display") or {}).get("gui"):
            out["gui"] = m["display"]["gui"]
        parent = m.get("parent")
        if not parent or parent in FLAT_PARENTS:
            out["flat"] = True
            break
        model = parent
    return out


def tex_ref(textures, ref):
    for _ in range(8):
        if ref and ref.startswith("#"):
            ref = textures.get(ref[1:])
        else:
            break
    return ref


def load_texture(ref):
    if not ref:
        return None
    tns, tpath = ref.split(":", 1) if ":" in ref else ("minecraft", ref)
    b = find(ASSETS, f"assets/{tns}/textures/{tpath}.png")
    if not b:
        return None
    img = Image.open(io.BytesIO(b)).convert("RGBA")
    w, h = img.size
    if h > w and h % w == 0:  # animated strip: keep frame 0
        img = img.crop((0, 0, w, w))
    return img


# --- tiny software renderer for Blockbench-style item models (element cuboids + display.gui)

import math
import numpy as np

FACE_CORNERS = {  # TL, TR, BR, BL as (x,y,z) picks from (f=from, t=to), per Minecraft's face layout
    "north": [("t", "t", "f"), ("f", "t", "f"), ("f", "f", "f"), ("t", "f", "f")],
    "south": [("f", "t", "t"), ("t", "t", "t"), ("t", "f", "t"), ("f", "f", "t")],
    "east":  [("t", "t", "t"), ("t", "t", "f"), ("t", "f", "f"), ("t", "f", "t")],
    "west":  [("f", "t", "f"), ("f", "t", "t"), ("f", "f", "t"), ("f", "f", "f")],
    "up":    [("f", "t", "f"), ("t", "t", "f"), ("t", "t", "t"), ("f", "t", "t")],
    "down":  [("f", "f", "t"), ("t", "f", "t"), ("t", "f", "f"), ("f", "f", "f")],
}


def rot_matrix(axis, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    if axis == "x":
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == "y":
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def default_uv(face, f, t):
    if face in ("north", "south"):
        return [f[0], 16 - t[1], t[0], 16 - f[1]]
    if face in ("east", "west"):
        return [f[2], 16 - t[1], t[2], 16 - f[1]]
    return [f[0], f[2], t[0], t[2]]


def render_model(md, size=64, ss=4):
    S = size * ss
    tex_cache = {}

    gui = md["gui"] or {}
    grot = gui.get("rotation", [0, 0, 0])
    gscale = gui.get("scale", [1, 1, 1])
    gtrans = gui.get("translation", [0, 0, 0])
    # Minecraft: rotationXYZ(rx, ry, rz)
    G = rot_matrix("x", grot[0]) @ rot_matrix("y", grot[1]) @ rot_matrix("z", grot[2])
    color = np.zeros((S, S, 4), dtype=np.float32)
    depth = np.full((S, S), -1e9, dtype=np.float32)
    ys, xs = np.mgrid[0:S, 0:S]
    px = (xs + 0.5) / S * 16.0
    py = 16.0 - (ys + 0.5) / S * 16.0

    def xf(p):
        p = np.array(p, dtype=float) - 8.0
        p = G @ (p * np.array(gscale))
        return p + np.array(gtrans) + 8.0

    for el in md["elements"]:
        f, t = el["from"], el["to"]
        R = None
        if el.get("rotation") and el["rotation"].get("angle"):
            r = el["rotation"]
            R = (rot_matrix(r["axis"], r["angle"]), np.array(r.get("origin", [8, 8, 8]), dtype=float))
        for face, fd in (el.get("faces") or {}).items():
            if face not in FACE_CORNERS:
                continue
            ref = tex_ref(md["textures"], fd.get("texture"))
            if ref not in tex_cache:
                tex_cache[ref] = load_texture(ref)
            img = tex_cache[ref]
            if img is None:
                continue
            arr = np.asarray(img, dtype=np.float32) / 255.0
            iw, ih = img.size
            corners = []
            for pick in FACE_CORNERS[face]:
                p = [(f if c == "f" else t)[i] for i, c in enumerate(pick)]
                p = np.array(p, dtype=float)
                if R is not None:
                    p = R[0] @ (p - R[1]) + R[1]
                corners.append(xf(p))
            corners = np.array(corners)
            n = np.cross(corners[3] - corners[0], corners[1] - corners[0])  # outward normal
            if n[2] <= 1e-6:
                continue  # back-facing
            u1, v1, u2, v2 = fd.get("uv") or default_uv(face, f, t)
            uvs = [(u1, v1), (u2, v1), (u2, v2), (u1, v2)]
            k = int(fd.get("rotation", 0)) // 90 % 4
            uvs = uvs[k:] + uvs[:k]
            uvs = np.array(uvs, dtype=float) / 16.0 * np.array([iw, ih])  # model UVs are always 0-16
            shade = 0.72 + 0.28 * abs(n[2]) / (np.linalg.norm(n) + 1e-9)
            for tri in ((0, 1, 2), (0, 2, 3)):
                a, b, c = corners[list(tri)]
                ua, ub, uc = uvs[list(tri)]
                det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
                if abs(det) < 1e-9:
                    continue
                x0, x1 = max(0, int(min(a[0], b[0], c[0]) / 16 * S) - 1), min(S, int(max(a[0], b[0], c[0]) / 16 * S) + 2)
                y0, y1 = max(0, int((16 - max(a[1], b[1], c[1])) / 16 * S) - 1), min(S, int((16 - min(a[1], b[1], c[1])) / 16 * S) + 2)
                if x0 >= x1 or y0 >= y1:
                    continue
                X, Y = px[y0:y1, x0:x1], py[y0:y1, x0:x1]
                l1 = ((b[1] - c[1]) * (X - c[0]) + (c[0] - b[0]) * (Y - c[1])) / det
                l2 = ((c[1] - a[1]) * (X - c[0]) + (a[0] - c[0]) * (Y - c[1])) / det
                l3 = 1 - l1 - l2
                inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
                if not inside.any():
                    continue
                z = l1 * a[2] + l2 * b[2] + l3 * c[2]
                u = l1 * ua[0] + l2 * ub[0] + l3 * uc[0]
                v = l1 * ua[1] + l2 * ub[1] + l3 * uc[1]
                ui = np.clip(np.floor(u).astype(int), 0, iw - 1)
                vi = np.clip(np.floor(v).astype(int), 0, ih - 1)
                col = arr[vi, ui]
                dz = depth[y0:y1, x0:x1]
                ok = inside & (col[..., 3] > 0.1) & (z > dz)
                if not ok.any():
                    continue
                dz[ok] = z[ok]
                cc = color[y0:y1, x0:x1]
                cc[ok, :3] = col[ok, :3] * shade
                cc[ok, 3] = 1.0
    out = Image.fromarray((color * 255).astype(np.uint8), "RGBA")
    return out.resize((size, size), Image.BOX)


def flat_icon(md):
    layers = sorted(k for k in md["textures"] if re.fullmatch(r"layer\d+", k))
    base = None
    for k in layers:
        img = load_texture(tex_ref(md["textures"], md["textures"][k]))
        if img is None:
            continue
        if base is None:
            base = img
        else:
            base = Image.alpha_composite(base, img.resize(base.size, Image.NEAREST))
    return base


def icon(item_id, texture=None):
    """Save the item's inventory look into icons/ and return its relative path (or None)."""
    key = item_id + "|" + (texture or "")
    if key in ICONS:
        return ICONS[key]
    img = None
    if texture:
        img = load_texture(texture)
    else:
        md = resolve_model(item_id)
        if md["elements"]:
            img = render_model(md)
        if img is None:
            img = flat_icon(md)
        if img is None:  # builtin/entity models etc.: fall back to particle / any texture
            img = load_texture(tex_ref(md["textures"], md["textures"].get("particle")))
    rel = None
    if img is not None and img.getbbox():
        ns, path = item_id.split(":", 1)
        rel = f"icons/{ns}/{path}.png"
        dst = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        img.save(dst)
    else:
        print("  no icon for", item_id)
    ICONS[key] = rel
    return rel


# ------------------------------------------------------------------ pools

print("reading registries...")
res = {}

ext = {k: (v.get("drop_req") or {}).get("league") for k, v in registry("mmorpg_orb_extension").items()}
res["currency"] = []
for k, v in registry("library_of_exile_currency").items():
    if v.get("weight", 1000) <= 0:
        continue
    iid = v.get("item_id") or f"mmorpg:currency/{k}"
    res["currency"].append({"id": k, "w": v.get("weight", 1000), "rar": v.get("rar"), "league": ext.get(k),
                            "name": item_name(iid), "icon": icon(iid)})

# GemItem.GemRank: (id, rarity) by tier
GEM_RANKS = [("cracked", "common"), ("chipped", "common"), ("flawed", "uncommon"), ("regular", "rare"), ("grand", "epic"),
             ("glorious", "legendary"), ("divine", "mythic"), ("pinnacle", "mythic")]
res["gems"] = []
for k, v in registry("mmorpg_gems").items():
    iid = v.get("item_id") or f"mmorpg:gems/{v.get('gem_type')}/{v.get('tier')}"
    rank = GEM_RANKS[v.get("tier", 0)]
    gem_name = LANG.get("mmorpg.formatter.gem_item_name", "%1$s %2$s").replace("%1$s", name(f"mmorpg.gem_rank.{rank[0]}", fallback=pretty(rank[0])))         .replace("%2$s", name(f"mmorpg.gem_type.{v.get('gem_type')}", fallback=pretty(v.get("gem_type", ""))))
    res["gems"].append({"id": k, "w": v.get("weight", 0), "tier": v.get("tier"), "lvl": v.get("min_lvl_multi", 0), "type": v.get("gem_type"),
                        "rar": rank[1], "name": gem_name, "icon": icon(iid)})

res["runes"] = []
for k, v in registry("mmorpg_runes").items():
    iid = v.get("item_id") or f"mmorpg:runes/{k}"
    res["runes"].append({"id": k, "w": v.get("weight", 0), "lvl": v.get("min_lvl_multi", 0), "name": item_name(iid), "icon": icon(iid)})

res["omens"] = [{"id": k, "w": v.get("weight", 0), "lvl": v.get("lvl_req", 0),
                 "name": name(f"mmorpg.omen.{k}", fallback=pretty(k))} for k, v in registry("mmorpg_omen").items()]

res["uniques"] = []
for k, v in registry("mmorpg_unique_gears").items():
    gid = v.get("guid", k)
    res["uniques"].append({"id": gid, "w": v.get("weight", 1000), "rar": v.get("rarity"), "tier": v.get("min_tier", 0), "lvl": v.get("min_drop_lvl", 0),
                           "base": v.get("base_gear"), "league": v.get("league") or None, "force": v.get("force_item_id") or None,
                           "name": name(f"mmorpg.unique_gear.{gid}.name", fallback=pretty(gid))})

res["slots"] = [{"id": k, "w": v.get("weight", 1000), "name": name(f"mmorpg.gearslot.{k}", fallback=pretty(k))}
                for k, v in registry("mmorpg_gear_slot").items()]

res["gearTypes"] = []
for k, v in registry("mmorpg_base_gear_types").items():
    items = [{"id": p["item_id"], "min": p.get("min_rar", "common"), "w": p.get("weight", 1),
              "name": item_name(p["item_id"]), "icon": icon(p["item_id"])} for p in v.get("possible_items", [])]
    res["gearTypes"].append({"id": v.get("guid", k), "slot": v.get("gear_slot"), "w": v.get("weight", 1000),
                             "name": name(f"mmorpg.gear_type.{v.get('guid', k)}", fallback=pretty(k)), "items": items})

for u in res["uniques"]:
    if u["force"]:
        u["forceName"] = item_name(u["force"])
        u["forceIcon"] = icon(u["force"])

res["supports"] = [{"id": k, "lvl": v.get("min_lvl", 0), "w": v.get("weight", 1000), "style": (v.get("style") or "STR").lower(),
                    "name": name(f"mmorpg.support_gem.{k}", fallback=pretty(k))} for k, v in registry("mmorpg_support_gem").items()]
res["auras"] = [{"id": k, "lvl": v.get("min_lvl", 0), "w": v.get("weight", 1000), "style": (v.get("style") or "STR").lower(),
                 "name": name(f"mmorpg.aura.{k}", fallback=pretty(k))} for k, v in registry("mmorpg_aura").items()]

rar_names = {r: name(f"mmorpg.rarity.{r}", f"mmorpg.gear_rarity.{r}", fallback=pretty(r))
             for r in ["common", "uncommon", "rare", "epic", "legendary", "mythic", "unique", "runeword"]}
mob_names = {r: name(f"mmorpg.mob_rarity.{r}", fallback=pretty(r))
             for r in ["common", "uncommon", "rare", "epic", "legendary", "mythic", "boss", "uber", "pinnacle", "summon"]}

# fixed items, one per drop type
res["items"] = {
    "soul": {"name": item_name("mmorpg:stat_soul"), "icon": icon("mmorpg:stat_soul")},
    "souls": {s["id"]: icon(f"mmorpg:stat_soul/{s['id']}", f"mmorpg:item/stat_soul/{s['id']}") for s in res["slots"]},
    "aura": {st: icon(f"mmorpg:skill_gems/aura/{st}") for st in ("str", "dex", "int")},
    "support": {st: icon(f"mmorpg:skill_gems/support/{st}") for st in ("str", "dex", "int")},
    "jewel": {st: {"name": item_name(f"mmorpg:jewel/{st}"), "icon": icon(f"mmorpg:jewel/{st}")} for st in ("str", "dex", "int")},
    "watcher": {"name": item_name("mmorpg:jewel/watcher_eye"), "icon": icon("mmorpg:jewel/watcher_eye")},
    "map": {"name": item_name("dungeon_realm:dungeon_map"), "icon": icon("dungeon_realm:dungeon_map")},
    "coin": {"name": item_name("mmorpg:coin/prophecy"), "icon": icon("mmorpg:coin/prophecy")},
    "omen": {"name": item_name("mmorpg:omen"), "icon": icon("mmorpg:omen")},
    "chest": {r: icon(f"mmorpg:chest/{r}_gear") for r in ["common", "uncommon", "rare", "epic", "legendary", "mythic"]},
    "chestName": item_name("mmorpg:chest/common_gear"),
    "uberFrag": {"name": item_name("dungeon_realm:uber_fragment"), "icon": icon("dungeon_realm:uber_fragment")},
    "pinnacleFrag": {"name": item_name("dungeon_realm:pinnacle_fragment"), "icon": icon("dungeon_realm:pinnacle_fragment")},
    "relic": {"name": item_name("dungeon_realm:general_relic"), "icon": icon("dungeon_realm:general_relic")},
}
# RelicGenerator: weighted relic rarity (base_data.weight) and weighted relic type
res["relicRarities"] = [{"id": k, "w": (v.get("base_data") or {}).get("weight", 0), "affixes": v.get("affixes", 0)}
                        for k, v in registry("library_of_exile_relic_rarity").items()]
res["relicTypes"] = [{"id": k, "w": v.get("weight", 1000), "name": name(f"library_of_exile.relic_type.{k}", fallback=item_name(v["item_id"])), "icon": icon(v["item_id"])}
                     for k, v in registry("library_of_exile_relic_type").items() if v.get("item_id")]

# ------------------------------------------------------------------ chests: map finish rarities + vanilla loot tables

res["finishRarities"] = sorted([{"id": k, "pct": v.get("perc_to_unlock", 0), "table": v.get("loot_table"), "chests": v.get("reward_chests", 0),
                                 "multi": v.get("mns_loot_multi", 1), "tier": v.get("tier", 0)}
                                for k, v in registry("library_of_exile_map_finish_rar").items()], key=lambda x: x["tier"])

CHEST_ROOTS = [f"dungeon_realm:chests/tier_{i}_dungeon" for i in range(1, 6)] + [r["table"] for r in res["finishRarities"] if r["table"]]
res["lootTables"] = {}
loot_items = {}


def walk_entry(e, todo):
    t = e.get("type", "")
    if t == "minecraft:loot_table":
        todo.append(e["name"])
    elif t == "minecraft:item":
        loot_items.setdefault(e["name"], None)
    for c in e.get("children", []):
        walk_entry(c, todo)


todo = list(CHEST_ROOTS)
while todo:
    tid = todo.pop()
    if tid in res["lootTables"]:
        continue
    ns, path = tid.split(":", 1)
    b = find(DATA, f"data/{ns}/loot_tables/{path}.json")
    if b is None:
        print("  loot table missing:", tid)
        res["lootTables"][tid] = None
        continue
    table = load_json(b)
    res["lootTables"][tid] = table
    for pool in table.get("pools", []):
        for e in pool.get("entries", []):
            walk_entry(e, todo)
res["lootItems"] = {iid: {"name": item_name(iid), "icon": icon(iid)} for iid in loot_items}
print(f"chests: {len(res['finishRarities'])} finish rarities, {len(res['lootTables'])} loot tables, {len(res['lootItems'])} items")

rar_json = registry("mmorpg_gear_rarity")
res["rarityTier"] = {r: rar_json.get(r, {}).get("item_tier", 0) for r in rar_names}
res["labels"] = {
    "aura": item_name("mmorpg:skill_gems/aura/str"), "support": item_name("mmorpg:skill_gems/support/str"),
    "omen": item_name("mmorpg:omen"), "watcher": item_name("mmorpg:jewel/watcher_eye"),
}
res["names"] = {"rarity": rar_names, "mob": mob_names,
                "gemType": {g["type"]: name(f"mmorpg.gem_type.{g['type']}", fallback=pretty(g["type"])) for g in res["gems"]}}

# ------------------------------------------------------------------ rarities (so the "CTE2 pack" preset is read, not typed in)

res["gearRarityData"] = {r: {"w": v.get("weight", 0), "min": v.get("min_lvl", 0), "higher": v.get("higher_rar") or "",
                             "tiers": [v.get("map_tiers", {}).get("min", 0), v.get("map_tiers", {}).get("max", 0)],
                             "type": v.get("type", "NORMAL"), "favor": v.get("favor_loot_multi", 1)}
                         for r, v in rar_json.items() if r in rar_names}
res["mobRarityData"] = {r: {"loot": v.get("loot_multi", 1), "hp": v.get("force_custom_hp", -1), "min": v.get("min_lvl", 0)}
                        for r, v in registry("mmorpg_mob_rarity").items()}
balance = registry("mmorpg_game_balance").get("original_balance", {})
res["maxLevel"] = balance.get("MAX_LEVEL", 100)


# ------------------------------------------------------------------ server config (defaultconfigs/mine_and_slash-server.toml)

import tomllib

CONFIG_KEYS = {  # toml key -> simulator setting
    "gear_drop_rate": "rates.gear", "soul_drop_rate": "rates.soul", "aura_gem_drop_rate": "rates.aura",
    "support_gem_drop_rate": "rates.support", "jewel_drop_rate": "rates.jewel", "currency_drop_rate": "rates.currency",
    "MAP_DROPRATE": "rates.map", "gem_drop_rate": "rates.gem", "rune_drop_rate": "rates.rune",
    "loot_chest_drop_rate": "rates.chest", "PROPHECY_COIN_DROPRATE": "rates.coin", "OMEN_DROPRATE": "rates.omen",
    "WATCHER_EYE_DROPRATE": "rates.watcher", "PINNACLE_GEM_DROPRATE": "rates.pinnacle",
    "LEVEL_DISTANCE_PENALTY_LEEWAY": "server.leeway", "lvl_distance_loot_penalty_per_level": "server.perLvl",
    "min_loot_chance": "server.minMulti", "PARTY_DROP_BONUS": "server.party", "min_level_map_drops": "server.minLvlMaps",
    "MAP_TIER_DROP_FALLOFF": "server.mapFalloff", "MAP_TIER_DROP_RISE": "server.mapRise",
    "MAP_BOSS_TIER_FALLOFF": "server.bossFalloff", "MAP_BOSS_TIER_RISE": "server.bossRise",
}


def flatten(d, out):
    for k, v in d.items():
        if isinstance(v, dict):
            flatten(v, out)
        else:
            out[k] = v
    return out


DUNGEON_KEYS = {"UBER_FRAG_DROP_RATE": "rates.uberFrag", "MAP_ITEM_FROM_BOSS_BASE_CHANCE": "rates.bossMap"}

cfg_path = os.path.join(INST, "defaultconfigs", "mine_and_slash-server.toml")
res["config"] = {"source": "defaultconfigs/mine_and_slash-server.toml", "values": {}}
if os.path.exists(cfg_path):
    with open(cfg_path, "rb") as f:
        flat = flatten(tomllib.load(f), {})
    for key, target in CONFIG_KEYS.items():
        if key in flat:
            res["config"]["values"][target] = flat[key]
        else:
            print("  config key missing:", key)
else:
    print("  no server config found at", cfg_path)

dcfg_path = os.path.join(INST, "defaultconfigs", "dungeon_realm-server.toml")
if os.path.exists(dcfg_path):
    with open(dcfg_path, "rb") as f:
        flat = flatten(tomllib.load(f), {})
    for key, target in DUNGEON_KEYS.items():
        if key in flat:
            res["config"]["values"][target] = flat[key]
        else:
            print("  dungeon config key missing:", key)
    res["config"]["source"] += " + defaultconfigs/dungeon_realm-server.toml"


# ------------------------------------------------------------------ atlas passive tree

def texture_icon(ref, key):
    """Icon from a full texture path like 'mmorpg:textures/gui/x.png'."""
    if not ref:
        return None
    ns, path = ref.split(":", 1) if ":" in ref else ("minecraft", ref)
    b = find(ASSETS, f"assets/{ns}/{path}")
    if not b:
        return None
    img = Image.open(io.BytesIO(b)).convert("RGBA")
    rel = f"icons/{key}.png"
    dst = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    img.save(dst)
    return rel


def parse_tree(text):
    """Port of TalentGrid: cells, perks, center and connections (connector letters, no diagonal through a perk)."""
    rows = [line.split(",") for line in text.replace("\r", "").split("\n")]
    cell = {}
    for y, row in enumerate(rows):
        for x, s in enumerate(row):
            cell[(x, y)] = s.strip().lower()

    def kind(p):
        s = cell.get(p, "")
        if len(s) == 1:
            return "conn"
        if s == "[center]":
            return "center"
        if len(s) > 2:
            return "perk"
        return None

    perks = [p for p in cell if kind(p) == "perk"]
    center = next((p for p in cell if kind(p) == "center"), None)

    def around(p, conn):
        out = []
        x, y = p
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                q = (x + dx, y + dy)
                if dx and dy and (kind((x + dx, y)) == "perk" or kind((x, y + dy)) == "perk"):
                    continue
                k = kind(q)
                if k == "perk" or (k == "conn" and cell[q] == conn):
                    out.append(q)
        return out

    def conn_types(p):
        return {cell[(p[0] + dx, p[1] + dy)] for dx in (-1, 0, 1) for dy in (-1, 0, 1) if kind((p[0] + dx, p[1] + dy)) == "conn"}

    # BFS from each perk once per connector type; every perk reached is connected (same as pairwise hasPath)
    links = {p: set() for p in perks}
    for a in perks:
        for c in conn_types(a):
            seen, queue = {a}, [a]
            while queue:
                cur = queue.pop()
                for q in around(cur, c):
                    if q in seen:
                        continue
                    seen.add(q)
                    if kind(q) == "perk":
                        if abs(q[0] - a[0]) < 12 and abs(q[1] - a[1]) < 12:
                            links[a].add(q)
                            links[q].add(a)
                    else:
                        queue.append(q)
    return perks, center, links, cell


trees = registry("mmorpg_talent_tree")
atlas_tree = next((t for t in trees.values() if t.get("school_type") == "ATLAS"), None)
perk_db = {}
for k, v in registry("mmorpg_perk").items():
    perk_db[(v.get("id") or k).lower()] = v

LOOT_STATS = {"uber_fragment_find", "relic_find", "duplicate_map_chance", "magic_find", "increased_quantity", "currency_find", "map_find", "gem_find", "rune_find", "jewel_find", "skill_gem_find",
              "omen_find", "watcher_eye_find", "prophecy_coin_find", "map_rarity_bias", "boss_loot_quantity", "extra_drop_from_mythics"}
res["atlas"] = None
if atlas_tree:
    perks, center, links, cell = parse_tree(atlas_tree["perks"])
    used = sorted({cell[p] for p in perks})
    pinfo = {}
    for pid in used:
        pv = perk_db.get(pid)
        if not pv:
            print("  atlas perk missing:", pid)
            continue
        stats = [{"stat": s["stat"], "v": s.get("v1", 0), "type": s.get("type", "FLAT"),
                  "name": name(f"mmorpg.stat.{s['stat']}", fallback=pretty(s["stat"]))} for s in pv.get("stats", [])]
        pinfo[pid] = {"name": name(f"mmorpg.talent.{pid}", f"mmorpg.perk.{pid}", fallback=None) or (stats[0]["name"] if stats else pretty(pid)),
                      "type": pv.get("type", "STAT"), "entry": bool(pv.get("is_entry")), "one_kind": pv.get("one_kind") or None,
                      "icon": texture_icon(pv.get("icon"), f"perk/{pid}"), "stats": stats,
                      "loot": any(s["stat"] in LOOT_STATS for s in stats)}
    idx = {p: i for i, p in enumerate(perks)}
    nodes = [{"x": p[0], "y": p[1], "perk": cell[p], "links": sorted(idx[q] for q in links[p])} for p in perks]
    # max points: every atlas-map node pays atlas_points_reward (default 1) once
    layout = registry("mmorpg_atlas_layout").get("atlas_map", {})
    anodes = {(v.get("id") or k): v for k, v in registry("dungeon_realm_atlas_node").items()}
    placed = [s.strip() for line in layout.get("nodes", "").split("\n") for s in line.split(",") if len(s.strip()) > 2 and s.strip() != "[CENTER]"]
    max_points = sum(anodes[n].get("atlas_points_reward", 1) for n in placed if n in anodes)
    res["atlas"] = {"nodes": nodes, "perks": pinfo, "center": list(center) if center else None, "maxPoints": max_points,
                    "treeIcon": texture_icon(atlas_tree.get("icon"), "perk/_atlas")}
    print(f"atlas: {len(nodes)} nodes, {len(pinfo)} perks, {sum(1 for p in pinfo.values() if p['loot'])} with loot stats, max points {max_points}")

with open(os.path.join(OUT, "pools.js"), "w", encoding="utf-8") as f:
    f.write("// Generated by tools/extract.py from the installed CTE2 instance. Do not edit by hand.\n")
    f.write("window.POOLS = " + json.dumps(res, ensure_ascii=False, separators=(",", ":")) + ";\n")

n_icons = len([v for v in ICONS.values() if v])
print(f"done: {len(res['currency'])} currencies, {len(res['gems'])} gems, {len(res['runes'])} runes, {len(res['uniques'])} uniques, "
      f"{len(res['gearTypes'])} gear types, {n_icons} icons")
print("rarity names:", rar_names)
print("mob names:", mob_names)
print("labels:", res["labels"], res["rarityTier"])
print("gems:", [g["name"] for g in res["gems"]][:5])
