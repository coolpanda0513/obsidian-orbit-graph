# Orbit Graph

Your vault as a long-exposure photograph of a black hole. The note you have open
is the black hole at the center. Notes it links to orbit closest, notes two links
away orbit further out, and so on. Notes with no path to the center drift on a
faint outer ring.

![Orbit Graph](docs/screenshot.jpg)

Open a different note and it falls into the center while everything else swings to its new orbit:

![Recentering](docs/screenshot-transition.jpg)

![Close-up](docs/screenshot-closeup.jpg)

## Look

- **One color.** Near-black space and a single light color (changeable in settings), with a little warmth in the accretion disk.
- **The center** is a black hole: a shadow, a thin photon ring, an accretion disk that passes in front of and behind it, and light bent over the top.
- **Long exposure.** Every note trails a fading streak of its own orbit. Inner orbits turn faster than outer ones.
- **Depth.** The orbit plane is tilted with perspective. Far notes are dimmer, and the scene leans slightly toward your mouse.
- **Texture.** Lens bloom, diffraction spikes on your most-linked notes, dust on the orbits, a faint Milky Way, and film grain.
- **Hover** a note to see its links, with a star-chart style annotation.

## Controls

| Action | What it does |
| --- | --- |
| Click a note | Open it (it falls into the center if "Center" is set to the open note) |
| Ctrl/Cmd-click | Open in a new tab |
| Ctrl/Cmd-hover | Page preview |
| Hover | Show the note's links |
| Right-click | Open, open in new tab, move to center |
| Drag | Pan |
| Shift-drag (or middle-drag) | Tilt |
| Scroll | Zoom toward the cursor |
| Double-click empty space | Fit to view |
| Search + Enter | Highlight matches; Enter moves the best match to the center |

Commands: **Open orbit graph** and **Open orbit graph in sidebar**, plus a ribbon icon.

Works best in a split pane or the sidebar next to your editor: click notes and watch the orbits rearrange.

## Settings

Center (open note or most-linked note), number of orbits, unlinked notes,
excluded folders, orbit speed (0 = still), tilt, orbit paths, links, link
brightness, drifting light along links, color, glow, background stars, the
size at which names appear, and each effect (trails, dust, bloom, film grain,
mouse parallax) on its own toggle.

Bloom turns itself off if your machine can't keep the view smooth.

## Installation

1. Build it (below), or download `main.js`, `manifest.json` and `styles.css` from a GitHub release.
2. Copy the three files into `<your vault>/.obsidian/plugins/orbit-graph/`.
3. In Obsidian: **Settings → Community plugins**, reload, and enable **Orbit Graph**.

Pushing a version tag (e.g. `1.0.0`) runs the release workflow, which attaches the three files to a GitHub release. That also makes it installable through BRAT.

## Development

```bash
npm install
npm run dev     # rebuild main.js on change
npm run build   # type-check and build a minified main.js
npm run demo    # standalone browser demo with a fake vault
```

After `npm run demo`, open `demo/index.html` in a browser (add `?n=800` for a bigger fake vault).

- `src/graph.ts`: link graph and orbit assignment (no Obsidian dependency)
- `src/renderer.ts`: canvas renderer: black hole, trails, bloom, camera, animation, hit-testing (no Obsidian dependency)
- `src/view.ts`: the Obsidian view: vault data, search, opening notes
- `src/settings.ts`, `src/types.ts`: settings tab and defaults
