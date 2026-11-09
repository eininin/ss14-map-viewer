# SS14 Map Viewer

A web viewer for Space Station 14 map files. Drop in a map `.yml` and the whole
map is drawn from real game sprites: floors, decals, walls (joined up), pipes,
cables, doors and everything placed on it.

**Site:** https://eininin.github.io/ss14-map-viewer/

## What it does

- **Open maps** from your computer (button or drag and drop), from Starlight's
  own map list (*Browse maps*), or from the `maps/` folder of this repo.
  Links keep the map and view: `?map=starlight:Maps/_Starlight/Stations/Manor.yml&x=0&y=0&z=1`
  (or `hardlight:Maps/...`).
- **Sprite packs, in order.** Every sprite is looked up in the packs from top to
  bottom; the first pack that has it wins. Whatever no pack has is drawn with the
  dev texture (#FF00DC / black checker). The *Map* tab lists everything that fell
  through to the dev texture.
- **Pick a sprite** (pick tool, `V`): shows the object, every sprite layer, which
  pack it came from, and buttons to open its folder on GitHub, copy the path,
  copy the PNG, download the PNG or `meta.json`, and browse all states of the RSI.
- **View sheet**: opens the whole PNG of a picked sprite (every frame and
  direction) full-screen. Scroll to zoom, right-drag / middle-drag / Space+drag
  to move, drag to select (snapped to frames or free, pixel by pixel),
  double-click a frame to select it, then copy or download the selection or the
  whole image (`Ctrl+C` copies the selection, or everything if nothing is selected).
- **Download .yml** of the open map (top bar or *Map* tab).
- **Draw on top**: lines in any colour, an eraser that cuts lines, and text.
  Drawings are kept per map in your browser and can be exported, imported or
  saved into this repo.
- **Layers, each shown or hidden on its own** (*View* tab, with an "only"
  button per row): floor tiles · decals · pipes and cables (atmos; electric
  HV / MV / LV; disposal) · objects (walls incl. windows and grilles; airlocks
  and doors; furniture; everything else) · markers and spawners. Options: hide
  pipes and cables under floor tiles as in game (only while floors are shown),
  every sprite layer, tile grid.

Keys: drag to pan · scroll / double-click to zoom · `WASD` / arrows to move ·
`F` fit · `H` pan · `V` pick · `B` pen · `E` eraser · `T` text · `G` grid ·
`Ctrl+Z` / `Ctrl+Shift+Z` undo / redo · `Esc` clear selection.

## How it works

| Path | What |
| --- | --- |
| `index.html`, `css/`, `js/` | the site (plain HTML/JS, no build step) |
| `db/sprites.json` | sprite database: prototype id → sprite, layers, draw depth, smoothing, tiles, decals, renames. Starlight first, then what only Hardlight has |
| `db/maps-<fork>.json` | each fork's map list for *Browse maps* |
| `packs.json` | default pack order shown to new visitors |
| `packs/hardlight/` | every Hardlight sprite that Starlight doesn't have (lobby art and parallax backgrounds left out) |
| `packs/<name>/` | packs stored in this repo, laid out like `Resources/Textures` (`Structures/Walls/solid.rsi/…`) with an `index.json` |
| `maps/` | maps saved into the repo (`maps/index.json` lists them) |
| `annotations/` | drawings saved into the repo, one file per map |
| `sources.json` | forks the database is built from; the first wins, later ones only add prototypes it lacks |
| `tools/build_db.py` | builds the database from a fork's `Resources/Prototypes` |
| `tools/packtool.py` | builds "fork minus base" packs and pack indexes |
| `.github/workflows/update-db.yml` | rebuilds the database every Monday, on demand, or when tools/packs change |

### Pack types

- **GitHub repo**: read straight from a fork's `Resources/Textures`
  (e.g. Starlight, pinned to the commit the database was built from).
- **This repo**: a folder under `packs/`.
- **Local folder**: pick `Resources/Textures` (or any folder of `.rsi`
  folders) on your computer. It lasts until the page is reloaded, and can be
  uploaded into `packs/` from the *Packs* tab.

### A pack with only what Starlight lacks

```
python3 tools/packtool.py diff <other fork>/Resources/Textures packs/<name> \
    --base <starlight>/Resources/Textures
```

This keeps whole RSIs Starlight doesn't have, single states missing from RSIs
it does have (with a trimmed `meta.json`), and plain textures. Add the folder
to `packs.json` under Starlight. For forks listed in `sources.json` with a
`pack` entry (Hardlight), the weekly workflow does this for you.

### Writing to the repo from the site

The *Repo* tab takes a fine-grained GitHub token with **Contents: read and
write** on this repository only. With it the site can upload a local folder as
a pack, save the pack order, save the open map into `maps/` and save drawings.
The token is stored only in your browser.

### Rebuilding the database by hand

```
pip install pyyaml
python3 tools/build_db.py <starlight>/Resources db/sprites.json \
    --repo ss14Starlight/space-station-14 --commit <sha> \
    --extra <hardlight>/Resources Vontens/HardLight-new <sha>
```

## Licences

Sprites are loaded at view time from the forks they belong to and keep their
original licences (see each RSI's `meta.json`). Packs copied into `packs/`
must keep their `meta.json` licence and copyright fields.
`js/vendor/js-yaml.min.js` is MIT (see `js/vendor/js-yaml.LICENSE`).
