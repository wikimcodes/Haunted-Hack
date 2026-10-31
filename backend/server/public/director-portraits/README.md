# Director character portraits

These are isolated renders of the existing Sprout, Pebble, Momo and Witch GLB character exports used by The Spy Monster. The camera frames the original face and upper body; the Witch framing also retains the complete hat. The meshes, eye geometry, cloth shapes, textures and material parameters remain unchanged.

The uncompressed exports in the separate `the-spy-monster-cinematic/exports` source bundle are the inputs. The corresponding game delivery files under `frontend-game/public/assets/library/` use Meshopt and WebP compression; the asset pipeline retains their geometry, materials and animation channels. `provenance.json` records source SHA-256 hashes, bounds, framing, Blender version and image dimensions.

Each PNG is 384 × 384 RGB, rendered at animation frame 1 in Blender Cycles with 40 samples, denoising, a charcoal world, soft blue light and a restrained warm rim. These are portrait-stage renders of the game models; the library lighting is configured separately in the live game.

Regenerate in a separate Blender background process:

```sh
Blender --background --factory-startup \
  --python backend/server/scripts/render-director-portraits.py -- \
  --source-dir /absolute/path/to/the-spy-monster-cinematic/exports \
  --output-dir /absolute/path/to/Haunted-Hack/backend/server/public/director-portraits
```

The generator refuses interactive execution and never saves a `.blend` file. The user's currently open Blender scene is not involved.
