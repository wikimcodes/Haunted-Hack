# Cinematic library assets

`frontend-game/public/assets/library/` contains the editable-scene exports used by the web client: environment, Sprout, Pebble, Momo and the escape door. Geometry uses glTF Y-up meters. `asset-manifest.json` records original scene placement; character and door asset roots are normalized.

Each ghost provides Idle, Talk, Think and Accused clips, with deforming cloth and vertex-color alpha. Preserve vertex colors and alpha blending. The door provides Open and a separate lock assembly. All five assets were reimported into Blender and checked; see validation-report.json.

The poster is a Cycles render of this 3D scene. It is a loading/title image only. The running experience renders the actual GLBs. Blender volumetrics, compositor and area lights must be approximated separately for realtime rendering; lighting-manifest.json supplies source parameters, not directly interchangeable Three.js intensities.

## Credits

The library and ghosts were created for The Spy Monster. Texture sources from Poly Haven are CC0:

- [Mossy Forest](https://polyhaven.com/a/mossy_forest) — Greg Zaal
- [Brown Leather](https://polyhaven.com/a/brown_leather) — Rob Tuytel
- [Wood Cabinet Worn Long](https://polyhaven.com/a/wood_cabinet_worn_long) — Dimitrios Savva / Rico Cilliers
- [Old Wood Floor](https://polyhaven.com/a/old_wood_floor) — Guillaume Monsergent
- [Damaged Plaster](https://polyhaven.com/a/damaged_plaster) — Amal Kumar
- [Worn Mossy Plasterwall](https://polyhaven.com/a/worn_mossy_plasterwall) — Amal Kumar

Book titles and surface atlases are generated artwork. The user's cinematic reference is not included in the repository or used as an in-game room backdrop. The forest HDRI supplies distant scenery and ambient lighting.
