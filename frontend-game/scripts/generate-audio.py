#!/usr/bin/env python3
"""Rebuild the library's two original sound-design assets (Python stdlib + ffmpeg)."""
from __future__ import annotations

import argparse
from array import array
import json
import math
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
import wave

RATE = 44100
TAU = math.tau


def ease(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def colored_cycle(seconds: int, seed: int) -> tuple[array, array]:
    """Band-limited periodic noise; a warm-up lap makes the filter seam continuous."""
    rng = random.Random(seed)
    count = seconds * RATE
    white = array('f', (rng.uniform(-1, 1) for _ in range(count)))
    low, mid = array('f', [0.0]) * count, array('f', [0.0]) * count
    alphas = [1.0 - math.exp(-TAU * hz / RATE) for hz in (28, 280, 750, 1900)]
    states = [0.0] * 4
    for lap in range(2):
        for i, value in enumerate(white):
            for k in range(4):
                states[k] += alphas[k] * (value - states[k])
            if lap:
                low[i] = states[1] - states[0]
                mid[i] = states[3] - states[2]
    return low, mid


def room() -> tuple[array, array]:
    seconds = 24
    low, air = colored_cycle(seconds, 71109)
    count = len(low)
    left, right = array('f', [0.0]) * count, array('f', [0.0]) * count
    offset = count // 7
    for i in range(count):
        t = i / RATE
        # Quiet pockets alternate with slowly breathing, detuned cavity resonances.
        # All base frequencies and envelopes complete exact cycles at the loop seam.
        gust = .29 + .10 * math.sin(TAU * t / seconds - .8) + .07 * math.sin(TAU * 3 * t / seconds + .7)
        shift = (i + offset) % count
        shared = .67 * low[i] + .045 * air[i]
        breadth = .22 * low[shift] + .035 * air[shift]
        pan = .42 * math.sin(TAU * t / seconds + .2)
        cavity = (.012 * math.sin(TAU * 107.5 * t) + .010 * math.sin(TAU * 109.75 * t + .3)
                  + .008 * math.sin(TAU * 153.25 * t + .7) + .006 * math.sin(TAU * 216.5 * t))
        emergence = (.5 + .5 * math.sin(TAU * 2 * t / seconds - 1.2)) ** 3
        hollow = cavity * (.14 + .86 * emergence)
        left[i] = 1.5 * gust * (shared * (1 + pan) + breadth) + 1.7 * hollow * (1 - .35 * pan)
        right[i] = 1.5 * gust * (shared * (1 - pan) - breadth) + 1.7 * hollow * (1 + .35 * pan)

    # Low, intermittent wood strain: irregular stick/slip modulation and damped modes.
    for start, length, base, side in [(2.6, 2.0, 192, -.62), (12.1, 2.45, 157, .58), (18.1, 1.65, 239, -.25)]:
        phase = 0.0
        first = int(start * RATE)
        for j in range(int(length * RATE)):
            i = first + j
            t = j / RATE
            q = t / length
            envelope = ease(q / .12) * ease((1 - q) / .27)
            strain = .53 + .32 * math.sin(TAU * 11.3 * t + 1.7 * math.sin(TAU * 3.8 * t))
            frequency = base * (1.0 + .075 * math.sin(TAU * 1.1 * t) - .18 * q)
            phase += TAU * frequency / RATE
            modes = math.sin(phase) + .36 * math.sin(phase * 2.61 + .3) + .13 * math.sin(phase * 4.08)
            creak = .057 * envelope * strain * modes
            left[i] += creak * (1 - side)
            right[i] += creak * (1 + side)

    # Uneven, widely separated timber knocks create implication, not a musical beat.
    for start, strength, side in [(6.55, .070, -.62), (14.78, .060, .55), (15.03, .042, .50), (21.95, .064, -.25)]:
        for j in range(int(.7 * RATE)):
            i = int(start * RATE) + j
            t = j / RATE
            knock = strength * ease(t / .008) * sum(
                weight * math.exp(-t / decay) * math.sin(TAU * hz * t)
                for hz, weight, decay in [(173, 1, .11), (317, .47, .080), (613, .25, .054), (1049, .09, .028)]
            )
            knock += .45 * strength * low[i] * math.exp(-t / .035) * ease(t / .003)
            left[i] += knock * (1 - side)
            right[i] += knock * (1 + side)

    # Dry scraping passes once across the room, with silence before the next event.
    for start, length, direction in [(8.8, 1.35, 1), (19.95, 1.30, -1)]:
        for j in range(int(length * RATE)):
            i = int(start * RATE) + j
            t, q = j / RATE, j / (length * RATE)
            envelope = ease(q / .10) * ease((1 - q) / .22)
            grit = .3 + .7 * max(0, math.sin(TAU * 17 * t + 1.5 * math.sin(TAU * 5.3 * t))) ** 2
            scrape = .24 * envelope * grit * (air[i] + .3 * low[i])
            pan = direction * (.86 * (2 * q - 1))
            left[i] += scrape * math.sqrt((1 - pan) / 2)
            right[i] += scrape * math.sqrt((1 + pan) / 2)
    return left, right


def reveal() -> tuple[array, array]:
    seconds = 6
    low, air = colored_cycle(seconds, 52031)
    count = len(low)
    left, right = array('f', [0.0]) * count, array('f', [0.0]) * count
    for i in range(count):
        t = i / RATE
        tail = ease((seconds - t) / 1.4)
        # 0-.65: air is drawn away. .65-.95: reversed air rapidly approaches.
        emptying = .035 * low[i] * ease(t / .06) * ease((.65 - t) / .55)
        approach = ease((t - .65) / .30) ** 2 if t < .95 else 0
        reverse_air = approach * (.48 * air[i] + .25 * low[i])
        reverse_tone = .025 * approach * math.sin(TAU * (210 * t + 110 * (t - .65) ** 2))

        # A .95-second impact combines a wooden crack and a dissonant low-mid cluster.
        # The short rounded attack leaves a strong event without a clipped click.
        hit_time = t - .95
        impact = 0.0
        chord = 0.0
        crack = 0.0
        if hit_time >= 0:
            attack = ease(hit_time / .012)
            impact = attack * sum(gain * math.exp(-hit_time / decay) * math.sin(TAU * hz * hit_time)
                for hz, gain, decay in [(61, .16, .30), (121, .15, .50), (181.7, .085, .42), (349.3, .045, .26)])
            chord = attack * sum(gain * math.exp(-hit_time / decay) * math.sin(TAU * hz * hit_time + phase)
                for hz, gain, decay, phase in [(110.2, .052, 1.95, .2), (116.7, .047, 2.1, .9),
                    (155.4, .043, 1.8, 1.5), (164.8, .037, 1.7, .3), (221.4, .023, 1.4, .7), (313.1, .014, 1.1, .1)])
            crack = .8 * air[i] * ease(hit_time / .003) * math.exp(-hit_time / .047)
            crack += attack * sum(gain * math.exp(-hit_time / decay) * math.sin(TAU * hz * hit_time)
                for hz, gain, decay in [(237, .073, .12), (593, .040, .078), (1057, .015, .038)])

        # 1.2-4.6: uneven aftershocks and breath-like noise with no syllables or words.
        breath_envelope = ease((t - 1.20) / .3) * ease((4.9 - t) / .6)
        breathing = (.18 + .82 * (.5 + .5 * math.sin(TAU * .63 * t + .5 * math.sin(TAU * .29 * t))) ** 2)
        breath = (.68 * low[i] + .52 * air[i]) * breath_envelope * breathing
        aftershock = 0.0
        for at, strength in [(1.64, .070), (2.42, .055), (3.68, .038)]:
            dt = t - at
            if dt > 0:
                aftershock += strength * ease(dt / .025) * math.exp(-dt / .22) * (math.sin(TAU * 139 * dt) + .4 * math.sin(TAU * 207.5 * dt))
        side = .58 * math.sin(TAU * .23 * t + .4)
        offset = (i + 3803) % count
        body = 1 + 2.2 * ease((t - 1.20) / .4)
        center = emptying + reverse_tone + impact + chord * body + aftershock
        left[i] = tail * (center + reverse_air * 1.12 + crack * 1.08 + breath * (1 + side) + .045 * air[offset] * breath_envelope)
        right[i] = tail * (center + reverse_air * .88 + crack * .92 + breath * (1 - side) - .045 * air[offset] * breath_envelope)

    # Sparse cross-channel reflections keep the initial crack dry and the aftermath deep.
    original_left, original_right = array('f', left), array('f', right)
    for delay, gain in [(.113, .14), (.193, .10), (.373, .075), (.537, .04)]:
        shift = int(delay * RATE)
        for i in range(shift, count):
            tail = ease((seconds - i / RATE) / 1.25)
            left[i] += original_right[i - shift] * gain * tail
            right[i] += original_left[i - shift] * gain * tail
    return left, right


def measure(channels: tuple[array, array]) -> dict:
    left, right = channels
    count = len(left) + len(right)
    peak = max(max(map(abs, left)), max(map(abs, right)))
    rms = math.sqrt((sum(v * v for v in left) + sum(v * v for v in right)) / count)
    db = lambda value: round(20 * math.log10(max(value, 1e-12)), 3)
    return {'seconds': len(left) / RATE, 'sampleRate': RATE, 'channels': 2,
            'peakDbFS': db(peak), 'rmsDbFS': db(rms),
            'dcLeft': sum(left) / len(left), 'dcRight': sum(right) / len(right),
            'loopBoundaryStep': max(abs(left[0] - left[-1]), abs(right[0] - right[-1]))}


def normalize(channels: tuple[array, array], target_rms_db: float, max_peak_db: float) -> tuple[array, array]:
    for channel in channels:
        mean = sum(channel) / len(channel)
        for i in range(len(channel)):
            channel[i] -= mean
    stats = measure(channels)
    gain = min(10 ** ((target_rms_db - stats['rmsDbFS']) / 20), 10 ** ((max_peak_db - stats['peakDbFS']) / 20))
    for channel in channels:
        for i in range(len(channel)):
            channel[i] *= gain
    return channels


def save_wav(path: Path, channels: tuple[array, array]) -> None:
    pcm = array('h')
    for left, right in zip(*channels):
        pcm.append(round(max(-.999, min(.999, left)) * 32767))
        pcm.append(round(max(-.999, min(.999, right)) * 32767))
    with wave.open(str(path), 'wb') as output:
        output.setparams((2, 2, RATE, len(channels[0]), 'NONE', 'not compressed'))
        output.writeframes(pcm.tobytes())


def read_wav(path: Path) -> tuple[array, array]:
    with wave.open(str(path), 'rb') as source:
        assert source.getframerate() == RATE and source.getsampwidth() == 2 and source.getnchannels() == 2
        pcm = array('h', source.readframes(source.getnframes()))
    return array('f', (v / 32768 for v in pcm[0::2])), array('f', (v / 32768 for v in pcm[1::2]))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'public' / 'audio')
    parser.add_argument('--preview-dir', type=Path, help='Keep source WAV previews in this directory')
    args = parser.parse_args()
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise SystemExit('ffmpeg is required on PATH (with libmp3lame).')
    args.output.mkdir(parents=True, exist_ok=True)
    if args.preview_dir:
        args.preview_dir.mkdir(parents=True, exist_ok=True)
    results = {}
    with tempfile.TemporaryDirectory(prefix='haunted-audio-') as folder:
        temporary = Path(folder)
        for name, build, rms in [('library-room', room, -25), ('witch-reveal', reveal, -21)]:
            channels = normalize(build(), rms, -7.5)
            source = temporary / f'{name}.wav'
            save_wav(source, channels)
            target = args.output / f'{name}.mp3'
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
                            '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '1', '-map_metadata', '-1', str(target)], check=True)
            decoded = temporary / f'{name}-decoded.wav'
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(target), '-c:a', 'pcm_s16le', str(decoded)], check=True)
            original_stats, decoded_stats = measure(channels), measure(read_wav(decoded))
            assert decoded_stats['seconds'] == (24 if name == 'library-room' else 6), 'Gapless sample count changed'
            assert decoded_stats['peakDbFS'] < -6, 'Encoding exceeded reserved headroom'
            results[name] = {'source': original_stats, 'decodedMP3': decoded_stats, 'bytes': target.stat().st_size}
            if args.preview_dir:
                shutil.copyfile(source, args.preview_dir / source.name)
            print(f'{name}: {decoded_stats["seconds"]:.0f}s, {target.stat().st_size} bytes, peak {decoded_stats["peakDbFS"]} dBFS, RMS {decoded_stats["rmsDbFS"]} dBFS')
    (args.output / 'audio-stats.json').write_text(json.dumps(results, indent=2) + '\n')


if __name__ == '__main__':
    main()
