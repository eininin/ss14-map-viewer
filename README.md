# SS14 Map Viewer

A web viewer for Space Station 14 map files. Drop in a map `.yml` and the whole
map is drawn from real game sprites: floors, decals, walls (joined up), pipes,
cables, doors and everything placed on it.

**Site:** https://eininin.github.io/ss14-map-viewer/

## What it does

- **Five servers**: Space Wizards, Starlight, Frontier, Hardlight and Aurora
  Song. Each has its own full prototype database and its own sprite set; the
  server badge in the top bar shows which one draws the map, and switches it.
- **Browse maps**: pick a server, then a category (stations, shuttles,
  dungeons, dev, misc, or all), then a list you can
  - search by name or path, and by **items they contain** (several items =
    maps with all of them; the list then shows how many of each)
  - sort by name, official order (shipyard › size › price), floor area,
    bounding box, width, height, entities, entities per tile, file size,
    price, ship size class, station players (max / min), grids, folder, or
    count of the searched item
  - group by shipyard, class (role), size class, engine, folder or category
  - filter by shipyard, class, size and engine
  
  Stations and shuttles show a **preview picture** on their card; hover it
  for a larger one. Previews are drawn on a transparent background, and the
  *Preview* menu lets you put black, stars, a checkerboard, dark grey or
  nothing behind them.

  The official data comes from the servers' own shipyard `vessel` prototypes
  (price, size class Micro/Small/Medium/Large, shipyard group, classes such as
  Salvage, Medical, Expedition, engines) and `gameMap` prototypes (player
  counts).
- **Open a .yml from your computer** (button or drag and drop): you are asked
  which server it is from.
  Links keep the map and view: `?map=frontier:Maps/_NF/Shuttles/vagabond.yml&x=0&y=0&z=1`.
- **Sprite packs, in order.** Every sprite is looked up in the packs from top to
  bottom; the first pack that has it wins. Whatever no pack has is drawn with the
  dev texture (#FF00DC / black checker). The *Map* tab lists everything that fell
  through to the dev texture.
- **Pick a sprite** (pick tool, `V`): shows the object, every sprite layer, which
  pack it came from, and buttons to open its folder on GitHub, copy the path,
  copy the PNG, download the PNG or `meta.json`, and browse all states of the RSI.
- **Area selection** (pick tool): drag to select whole tiles, **Shift+drag**
  adds, **Alt+drag** or **Ctrl+drag** removes, **Esc** clears. The *Area* tab
  lists every object, floor tile and decal inside, with counts, counting only
  layers shown in the *View* tab. Copy the list or download it as `.csv`;
  click a row to highlight those objects. **Show only these kinds, map-wide**
  hides everything except objects, floor tiles and decals of the kinds found in
  the selection, anywhere on the map.
- **Export selection as .yml** (*Area* tab): a new map file with only the
  selected tiles: the map and grid entities, every entity on a selected tile
  (plus anything inside it), floor tiles, decals and tile atmospheres. With
  "only shown layers" on, hidden layers are left out. Coordinates stay as in
  the original map; custom `!type:` tags are kept.
- **Field of view** (*Area* tab): select a room or department and press
  **See from selection**: every tile visible from anywhere in it is coloured
  (colour and fill adjustable), walls in view more lightly. Sight is blocked by
  whatever has the game's `Occluder` component (walls, closed solid doors,
  shutters, bookshelves…); windows, glass airlocks and firelocks let it through.
  Options: all doors open, a range limit. **Select view** selects the tiles in
  view, **Select view +1** grows it by one tile (its walls and one tile
  beyond); optionally including the source area.
- **Zones** (*Area* tab): turn the selection into a named, coloured zone,
  drawn tinted on the map with its name in the top-left corner. A new zone
  touching a zone of the same name joins it and takes its colour. Rename,
  recolour, select, zoom to or delete zones, remove the selection from zones,
  change the fill strength; kept per map in your browser, export/import `.json`.
- **Saved list of kinds** (*Area* tab): add or remove the kinds in the
  selection (or use *Add to list* in Inspect), then **show only the list** to
  see every object of those kinds on any map. It is kept in your browser,
  shared by all maps, and can be exported as `.json` and imported to share.
- **View sheet**: opens the whole PNG of a picked sprite (every frame and
  direction) full-screen. Scroll to zoom, right-drag / middle-drag / Space+drag
  to move, drag to select (snapped to frames or free, pixel by pixel),
  double-click a frame to select it, then copy or download the selection or the
  whole image (`Ctrl+C` copies the selection, or everything if nothing is selected).
- **Download .yml** of the open map (bottom of the *Map* tab).
- **Draw on top**: lines in any colour, an eraser that cuts lines, and text.
  Drawings are kept per map in your browser and can be exported, imported or
  saved into this repo.
- **Layers, each shown or hidden on its own** (*View* tab, foldable groups,
  an "only" button per row):
  - floor tiles · decals
  - pipes, cables and their machines: atmos (pipes; atmos devices), electric
    (HV, MV, LV cables; electric machines), disposal (pipes; units)
  - objects: walls · airlocks and doors · wall-mounted · machines and
    computers (computers and consoles; fabrication and production; vending;
    other machines) · storage · furniture · items · everything else
  - markers and spawners
  
  Pipes and cables are shown **as in game** (hidden under floor tiles; vents,
  scrubbers and other devices keep only their floor part, also on catwalks) or
  **on top of everything**. Also: every sprite layer, tile grid. Background:
  space as in game (nebula plus four generated star layers with parallax) or a
  solid colour.
- **Area selection** (pick tool): drag to select whole tiles, **Shift+drag**
  adds, **Alt+drag** or **Ctrl+drag** removes, **Esc** clears. The *Area* tab
  lists every object, floor tile and decal inside, with counts, counting only
  layers shown in the *View* tab. Copy the list or download it as `.csv`;
  click a row to highlight those objects. **Show only these kinds, map-wide**
  hides everything except objects, floor tiles and decals of the kinds found in
  the selection, anywhere on the map.
- **Export selection as .yml** (*Area* tab): a new map file with only the
  selected tiles: the map and grid entities, every entity on a selected tile
  (plus anything inside it), floor tiles, decals and tile atmospheres. With
  "only shown layers" on, hidden layers are left out. Coordinates stay as in
  the original map; custom `!type:` tags are kept.
- **Zones** (*Area* tab): turn the selection into a named, coloured zone,
  drawn tinted on the map with its name in the top-left corner. A new zone
  touching a zone of the same name joins it and takes its colour. Rename,
  recolour, select, zoom to or delete zones, remove the selection from zones,
  change the fill strength; kept per map in your browser, export/import `.json`.
- **Saved list of kinds** (*Area* tab): add or remove the kinds in the
  selection (or use *Add to list* in Inspect), then **show only the list** to
  see every object of those kinds on any map. It is kept in your browser,
  shared by all maps, and can be exported as `.json` and imported to share.
- **View sheet**: opens the whole PNG of a picked sprite (every frame and
  direction) full-screen. Scroll to zoom, right-drag / middle-drag / Space+drag
  to move, drag to select (snapped to frames or free, pixel by pixel),
  double-click a frame to select it, then copy or download the selection or the
  whole image (`Ctrl+C` copies the selection, or everything if nothing is selected).
- **Download .yml** of the open map (bottom of the *Map* tab).
- **Draw on top**: lines in any colour, an eraser that cuts lines, and text.
  Drawings are kept per map in your browser and can be exported, imported or
  saved into this repo.
- **Layers, each shown or hidden on its own** (*View* tab, with an "only"
  button per row): floor tiles · decals · pipes and cables (atmos; electric
  HV / MV / LV; disposal) · objects (walls incl. windows and grilles; airlocks
  and doors; wall-mounted; machines and computers; storage; furniture; items;
  everything else) · markers and spawners. Groups fold open with ▸. Options: hide
  pipes and cables under floor tiles as in game (only while floors are shown),
  every sprite layer, tile grid. Background: space as in game (the Default
  parallax: nebula image plus the four generated star layers, each drifting at
  its own speed) or a solid colour.

Keys: drag to pan · scroll / double-click to zoom · `WASD` / arrows to move ·
`F` fit · `H` pan · `V` pick (drag: area) · `B` pen · `E` eraser · `T` text · `G` grid ·
`Ctrl+Z` / `Ctrl+Shift+Z` undo / redo · `Esc` clear selection.

## How it works

| Path | What |
| --- | --- |
| `index.html`, `css/`, `js/` | the site (plain HTML/JS, no build step) |
| `sources.json` | the five servers: repo, host, branch, colour; Aurora's pack and map mirror |
| `db/sprites-<server>.json` | sprite database per server: prototype id → sprite, layers, draw depth, smoothing, group, pipes, renames |
| `db/maps-<server>.json` | every map of a server: name, category, size, tiles, entities, official ship / station data |
| `db/items-<server>.json` | which maps contain which prototypes (item search) |
| `db/commits.json` | the commit each server's data was built from (sprites are read at that commit) |
| `packs.json` | extra packs placed above every server's own sprites (`packs/custom`) |
| `packs/aurora/` | Aurora Song's sprites that differ from Space Wizards / Frontier (Codeberg can't be read by browsers) |
| `mirror/aurora/` | copy of Aurora Song's maps, for the same reason |
| `maps/` | maps saved into the repo (`maps/index.json` lists them) |
| `annotations/` | drawings saved into the repo, one file per map |
| `thumbs/<server>/` | station and shuttle previews (`.webp` small, `.lg.webp` large, `index.json`) |
| `thumbs.html`, `js/thumbs.js` | render-only page used to draw the previews |
| `tools/render_thumbs.py` | draws the previews in headless Chromium; only maps whose file (or the drawing code) changed are drawn again |
| `tools/build_db.py` | builds a server's database from its `Resources/Prototypes` |
| `tools/map_index.py` | builds a server's map list and item index from its `Resources/Maps` |
| `tools/packtool.py` | builds "fork minus base" packs and pack indexes |
| `.github/workflows/update-db.yml` | rebuilds everything every Monday, on demand (Actions tab), or when tools / sources change |

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

### Rebuilding by hand

```
pip install pyyaml
python3 tools/build_db.py <fork>/Resources db/sprites-<server>.json --repo <owner/name> --commit <sha>
python3 tools/map_index.py <fork>/Resources <server> <owner/name> <sha> db
# previews (needs: pip install playwright; python3 -m playwright install chromium)
python3 tools/render_thumbs.py --src <folder with one <server>/Resources/Maps per server>
```

## Licences

Sprites are loaded at view time from the forks they belong to and keep their
original licences (see each RSI's `meta.json`). Packs copied into `packs/`
must keep their `meta.json` licence and copyright fields.
`js/vendor/js-yaml.min.js` is MIT (see `js/vendor/js-yaml.LICENSE`).
