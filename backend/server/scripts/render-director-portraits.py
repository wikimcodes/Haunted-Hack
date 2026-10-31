"""Render Director portraits from the game's existing, uncompressed GLB exports.

Run in a separate Blender process, not inside an edited user scene:
  Blender --background --factory-startup --python render-director-portraits.py -- \
    --source-dir /path/to/the-spy-monster-cinematic/exports --output-dir /path/to/director-portraits

The delivery GLBs use Meshopt/WebP; source GLBs have identical exported geometry,
materials and animation channels before those web-only compression steps.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--size', type=int, default=384)
    return parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def area(name, location, energy, color, size, target):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.color = color
    data.shape = 'DISK'
    data.size = size
    light = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(light)
    light.location = location
    aim(light, target)


def render(ident, source, out, size):
    # This script is deliberately run in its own factory-startup background process.
    # No source .blend is opened or saved, and the user's active Blender is untouched.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    bpy.ops.import_scene.gltf(filepath=str(source))
    scene.frame_set(1)
    bpy.context.view_layer.update()
    objects = list(scene.objects)
    geometry = [o for o in objects if o.type == 'MESH']
    bounds = [o.matrix_world @ Vector(c) for o in geometry for c in o.bound_box]
    low = Vector(tuple(min(v[i] for v in bounds) for i in range(3)))
    high = Vector(tuple(max(v[i] for v in bounds) for i in range(3)))

    face_objects = [o for o in geometry if 'Recess' in o.name or 'Eyes' in o.name]
    face_points = [o.matrix_world @ Vector(c) for o in face_objects for c in o.bound_box]
    face_z = sum(v.z for v in face_points) / len(face_points)
    face_x = sum(v.x for v in face_points) / len(face_points)
    # Frame the actual face and shoulders. Preserve the full hat in the Witch portrait.
    scale = 1.60 if ident == 'witch' else 1.34
    center_z = face_z + (.03 if ident == 'witch' else -.25)
    target = Vector((face_x, 0, center_z))
    camera_data = bpy.data.cameras.new('Director Portrait Camera')
    camera = bpy.data.objects.new('Director Portrait Camera', camera_data)
    scene.collection.objects.link(camera)
    camera.location = (face_x + .10, -4.0, center_z + .08)
    aim(camera, target)
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = scale
    camera_data.clip_start = .01
    camera_data.clip_end = 30
    scene.camera = camera

    world = bpy.data.worlds.new('Charcoal Portrait World')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (.023, .026, .032, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = .32
    scene.world = world
    area('Moon softbox', (-2.0, -3.0, 4.5), 130, (.67, .79, 1.0), 3.0, target)
    area('Front soft fill', (1.8, -2.8, 2.4), 65, (.90, .93, 1.0), 2.5, target)
    area('Warm library edge', (1.8, 1.0, 3.5), 100, (1.0, .72, .47), 2.0, target)
    if ident == 'witch':
        area('Hood contour', (-.7, -1.6, 3.2), 75, (.65, .67, 1.0), 1.8, (0, 0, 2.25))

    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.color_depth = '8'
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.view_settings.exposure = .25
    scene.render.filepath = str(out)
    bpy.ops.render.render(write_still=True)
    return {
        'id': ident, 'file': out.name, 'pixels': [size, size],
        'source': source.name, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'boundsBlenderZUp': {'min': list(low), 'max': list(high)},
        'frame': 1, 'materialsAltered': False, 'camera': list(camera.location),
        'target': list(target), 'orthographicScale': scale,
        'blenderVersion': bpy.app.version_string,
        'bytes': out.stat().st_size
    }


def main():
    if not bpy.app.background:
        raise RuntimeError('Run this generator in a separate Blender --background process.')
    options = args()
    options.output_dir.mkdir(parents=True, exist_ok=True)
    report = {'description': 'Real existing game GLB model portraits, rendered in an isolated Blender process. No AI-generated or substituted character artwork.', 'assets': []}
    for ident in ['sprout', 'pebble', 'momo', 'witch']:
        source = options.source_dir / f'{ident}.glb'
        if not source.is_file():
            raise FileNotFoundError(source)
        report['assets'].append(render(ident, source, options.output_dir / f'{ident}.png', options.size))
    (options.output_dir / 'provenance.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
