# Cinematic library assets

`frontend-game/public/assets/library/` contains six editable-scene exports used by the web client: environment, Sprout, Pebble, Momo, the escape door and the cinematic witch. Geometry uses glTF Y-up meters. `asset-manifest.json` records original scene placement; character, witch and door asset roots are normalized.

Each ghost provides Idle, Talk, Think and Accused clips, with deforming cloth and vertex-color alpha. Preserve vertex colors and alpha blending. The door provides Open and a separate lock assembly. The witch uses worn dark cloth, a hooded face recess and restrained eyes, with a gentle eight-second looping Idle cloth morph. Her material response and silhouette are designed for the existing library's moonlight and candlelight. Wool sheen tint is explicitly dark in the source so glTF does not export a white sheen lobe. Runtime cloth uses depth-writing opaque coverage during play; only the winning transition fades it. The hood interior must not use overlapping alpha-blended surfaces. The original five assets have Blender reimport checks in `validation-report.json`; the witch passed its isolated source reimport with actual cloth deformation, recorded in `witch-validation-report.json`.

`presentation-manifest.json` supplies glTF-coordinate camera and light anchors. The three camera modes are the wide entrance view, per-monster framing and the window reveal; monster close-ups are calculated at runtime from the player and character. One room supports introduction, suspicion, reveal and ending presentation through public-state lighting. A public `WITCH_REVEAL` event triggers a six-second camera/light effect. The Explore menu offers the same effect as an explicitly labelled scene preview. Reduced motion suppresses camera travel and candle oscillation. These effects do not use the hidden spy identity or create game evidence.

The poster is a Cycles render of this 3D scene. It is a loading/title image only. The running experience renders the actual GLBs. Blender volumetrics, compositor and area lights must be approximated separately for realtime rendering; lighting-manifest.json supplies source parameters, not directly interchangeable Three.js intensities.

## Credits

The library, ghosts and witch were created for The Spy Monster. Texture sources from Poly Haven are CC0:

- [Mossy Forest](https://polyhaven.com/a/mossy_forest) — Greg Zaal
- [Brown Leather](https://polyhaven.com/a/brown_leather) — Rob Tuytel
- [Wood Cabinet Worn Long](https://polyhaven.com/a/wood_cabinet_worn_long) — Dimitrios Savva / Rico Cilliers
- [Old Wood Floor](https://polyhaven.com/a/old_wood_floor) — Guillaume Monsergent
- [Damaged Plaster](https://polyhaven.com/a/damaged_plaster) — Amal Kumar
- [Worn Mossy Plasterwall](https://polyhaven.com/a/worn_mossy_plasterwall) — Amal Kumar

Book titles and surface atlases are generated artwork. The user's cinematic reference is not included in the repository or used as an in-game room backdrop. The forest HDRI supplies distant scenery and ambient lighting.

## Web delivery

The six source exports total 69,477,436 bytes; runtime GLBs total 12,812,884 bytes (69.48 MB to 12.81 MB). The witch alone is reduced from 625,048 to 203,176 bytes and retains 15,924 triangles and its eight-second deforming Idle clip. The full bundle retains 420,345 triangles. HDRI and poster are additional. The original five exports were first pushed in commit `dd9ccf6`.

Runtime GLBs use WebP quality 90 and Meshopt compression. No polygon simplification was applied. Triangles, clip names/durations/channels, morph primitives and RGBA attributes are checked against the source exports; see `web-validation-report.json` for delivery measurements. Three.js must configure `MeshoptDecoder` on `GLTFLoader`. WebP reduces transfer size; GPU texture memory is still uncompressed.

## Re-exporting the witch

The editable `.blend` and Python scripts are retained in the separate `the-spy-monster-cinematic` source bundle. Open that scene in Blender, use Object mode and execute the standalone exporter through Blender MCP or Blender's Python console:

```python
from pathlib import Path

base = Path("/absolute/path/to/the-spy-monster-cinematic")
script = base / "scripts" / "export_witch.py"
exec(compile(script.read_text(), str(script), "exec"))
witch = export_cinematic_witch(str(base))
```

The source scene must be named `Cinematic_Library` and contain the top-level `Cinematic_Witch` hierarchy with an `Idle` NLA track, including animated cloth shape keys. The exporter writes `exports/witch.glb` and `exports/witch-validation-report.json`. It normalizes the asset root, records its original Y-up placement, preserves source transforms and scene state, checks embedded resources and nonzero morph targets, then reimports into an isolated scene and samples actual `Idle` shape-key changes. Temporary imported data is removed afterward.

The standalone exporter returns an `asset` record and does not modify the shared manifest. Merge that record into `asset-manifest.json`, retain its placement and update aggregate metadata. When rebuilding the whole bundle, the older `export_assets.py` / `validate_assets.py` cover the original five assets; run the witch exporter afterward and retain its separate report. Do not lose the witch record when the original manifest is regenerated.

For web delivery, compress the new GLB with the same WebP/Meshopt pipeline, keep morph targets and animated weights enabled, and compare triangle counts, clip names/durations and morph channels with the source export. Publish the compressed GLB, both relevant validation reports and the updated manifests under `frontend-game/public/assets/library/`. Keep camera/light anchors in `presentation-manifest.json` aligned with any placement change. A static mesh with a clip named `Idle` is insufficient: the reimported cloth must actually deform.

The Director screen opens as a separate tab and consumes real backend evidence; it is not part of the Blender asset bundle. The frontend also includes two sound assets generated with the ElevenLabs Sound Effects API: a 29.5-second room loop and a six-second Witch Reveal cue, totaling 570,181 bytes. Playback follows the cinematic clock, supports persisted mute, and pauses in hidden tabs and the menu. See [audio provenance and regeneration](../frontend-game/public/audio/README.md).

## Walkable escape courtyard

The web client adds a lightweight 3D cloister in `frontend-game/src/world/escapeExterior.ts`, using the library’s existing stone and bark material maps. It has continuous stone paving, side arches, parapets, grass, trees and dawn terrain/sky; it is geometry, not a backdrop image. The six exported GLBs stay unchanged.

The measured masonry opening is centered at z=−2.90, with the outer wall face at x=3.81. The door root at z=−3.65 is the hinge, not the opening center. The floor joins the existing sill at x=3.70, y=0.04. Collision opens only after the door clip reaches its end, then permits passage into the bounded courtyard. `exitJourney.ts` requires an actual outward threshold crossing and x≥9.6 before completing; button clicks and camera jumps cannot finish escape.
