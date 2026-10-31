#!/usr/bin/env node
// Rebuild the library's two sound assets with the ElevenLabs Sound Effects API, then level them with ffmpeg.
// The key is only used here, at build time; it never reaches the browser bundle.
//
// Usage (from frontend-game/):
//   npm run audio:elevenlabs                         replace both files in public/audio/
//   npm run audio:elevenlabs -- --only reveal        regenerate one (room | reveal)
//   npm run audio:elevenlabs -- --preview DIR -n 3   write 3 candidates of each to DIR and keep public/audio/ as is
//   npm run audio:elevenlabs -- --only room --text "..." --preview DIR --label dread
//                                                    try another prompt; --label names the preview file
//
// Key: ELEVENLABS_API_KEY from the environment, else from backend/server/.env.

import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const AUDIO_DIR = join(ROOT, "public/audio")
const MODEL = process.env.ELEVENLABS_SFX_MODEL ?? "eleven_text_to_sound_v2"

// LibraryAudio ducks the room and syncs the reveal to the 6-second camera shot,
// with the impact landing just under one second in. The prompts ask for that shape.
const SOUNDS = {
    room: {
        file: "library-room.mp3",
        seconds: 30,
        loop: true,
        promptInfluence: 0.6,
        text: "Unsettling paranormal horror ambience. Reversed ghostly whispers, a faint child humming far away, nails scraping slowly on wood, "
            + "low metallic groans, irregular creaks very close, a dark pulsing drone that rises and falls, sudden quiet moments then a distant heavy thud. "
            + "Eerie, cursed and deeply uncomfortable. No melody."
    },
    reveal: {
        file: "witch-reveal.mp3",
        seconds: 6,
        loop: false,
        promptInfluence: 0.6,
        text: "Horror movie witch reveal sting. Half a second of sudden held-breath silence, a fast reversed whoosh rushing in, then at about one second "
            + "a massive deep cinematic boom with a dissonant screeching string stab and shattering glass, followed by a raspy distorted witch cackle "
            + "echoing through a stone hall and a long eerie reverb tail fading to silence."
    }
}

const PEAK_DB = -8 // headroom matching the previous assets; LibraryAudio applies its own mix gains
const MAX_MEAN_DB = -20 // keeps a dense generation from being louder on average than the old mix
const FADE_OUT = 1.2
const LOOP_CROSSFADE = 0.5 // seconds of the tail blended into the head, so the loop point never clicks

const { values: args } = parseArgs({
    options: {
        only: { type: "string" },
        preview: { type: "string" },
        n: { type: "string", default: "1" },
        text: { type: "string" },
        label: { type: "string" }
    }
})
if (args.only && !(args.only in SOUNDS)) fail(`--only must be one of: ${Object.keys(SOUNDS).join(", ")}`)
if (args.text) {
    if (!args.only) fail("--text needs --only, since each sound has its own prompt")
    SOUNDS[args.only].text = args.text
}
const variants = Math.max(1, Math.min(5, Number(args.n) || 1))
if (variants > 1 && !args.preview) fail("-n needs --preview DIR, so candidates do not overwrite each other in public/audio/")

const key = process.env.ELEVENLABS_API_KEY || keyFromBackendEnv()
if (!key) fail("No ELEVENLABS_API_KEY. Add it to backend/server/.env (see ENV.md).")
for (const tool of ["ffmpeg", "ffprobe"]) {
    try { execFileSync(tool, ["-version"], { stdio: "ignore" }) } catch { fail(`${tool} is required on PATH (brew install ffmpeg).`) }
}

const work = mkdtempSync(join(tmpdir(), "elevenlabs-audio-"))
const stats = {}
try {
    for (const [name, sound] of Object.entries(SOUNDS)) {
        if (args.only && args.only !== name) continue
        for (let i = 1; i <= variants; i++) {
            const label = variants > 1 ? `${name} ${i}/${variants}` : name
            process.stdout.write(`Generating ${label} (${sound.seconds}s${sound.loop ? ", loop" : ""})... `)
            const raw = join(work, `${name}-${i}.raw.mp3`)
            writeFileSync(raw, await generate(sound))
            const out = args.preview
                ? join(ensureDir(resolve(args.preview)), sound.file.replace(".mp3", `${args.label ? `-${args.label}` : ""}${variants > 1 ? `-${i}` : ""}.mp3`))
                : join(AUDIO_DIR, sound.file)
            const measured = level(raw, out, sound)
            console.log(`${out} (${measured.seconds.toFixed(2)}s, peak ${measured.peakDbFS} dBFS, mean ${measured.meanDbFS} dBFS)`)
            if (!args.preview) stats[sound.file.replace(".mp3", "")] = { source: "elevenlabs", model: MODEL, prompt: sound.text, loop: sound.loop, decodedMP3: measured, bytes: statSync(out).size }
        }
    }
} finally {
    rmSync(work, { recursive: true, force: true })
}

if (!args.preview) {
    const statsPath = join(AUDIO_DIR, "audio-stats.json")
    let previous = {}
    try { previous = JSON.parse(readFileSync(statsPath, "utf8")) } catch { /* first run */ }
    writeFileSync(statsPath, JSON.stringify({ ...previous, ...stats }, null, 2) + "\n")
    console.log("Done. Bump SOUND_REVISION in src/audio/LibraryAudio.ts so browsers fetch the new files.")
}

async function generate(sound) {
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
            text: sound.text,
            duration_seconds: sound.seconds,
            prompt_influence: sound.promptInfluence,
            loop: sound.loop,
            model_id: MODEL
        })
    })
    if (!res.ok) fail(`ElevenLabs returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return Buffer.from(await res.arrayBuffer())
}

/**
 * Linear gain only (no compressor). The reveal is cut to exactly 6 s with a fade. The loop's last
 * LOOP_CROSSFADE seconds are blended into its start (equal power), so the end flows back into the start.
 */
function level(input, output, sound) {
    const before = volume(input)
    const gain = `volume=${Math.min(PEAK_DB - before.max, MAX_MEAN_DB - before.mean).toFixed(2)}dB`
    const encode = ["-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", output]
    if (sound.loop) {
        const length = duration(input), c = LOOP_CROSSFADE, body = length - c
        const graph = `[0]aformat=sample_rates=44100:channel_layouts=stereo,asplit=3[a][b][c];`
            + `[a]atrim=0:${c},asetpts=PTS-STARTPTS,afade=t=in:d=${c}:curve=qsin[head];`
            + `[b]atrim=${body}:${length},asetpts=PTS-STARTPTS,afade=t=out:d=${c}:curve=qsin[tail];`
            + `[head][tail]amix=inputs=2:normalize=0[seam];`
            + `[c]atrim=${c}:${body},asetpts=PTS-STARTPTS[rest];`
            + `[seam][rest]concat=n=2:v=0:a=1,${gain}[out]`
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-filter_complex", graph, "-map", "[out]", ...encode])
    } else {
        const filters = [gain, `apad=whole_dur=${sound.seconds}`, `atrim=0:${sound.seconds}`, `afade=t=out:st=${sound.seconds - FADE_OUT}:d=${FADE_OUT}`]
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-af", filters.join(","), ...encode])
    }
    const after = volume(output)
    return { seconds: duration(output), peakDbFS: after.max, meanDbFS: after.mean }
}

function duration(file) {
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString())
}

function volume(file) {
    // volumedetect reports on stderr.
    const log = spawnSync("ffmpeg", ["-v", "info", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr
    const read = name => Number(log.match(new RegExp(`${name}_volume: (-?[\\d.]+) dB`))?.[1])
    return { max: read("max"), mean: read("mean") }
}

function keyFromBackendEnv() {
    try {
        const env = readFileSync(join(ROOT, "../backend/server/.env"), "utf8")
        return env.match(/^ELEVENLABS_API_KEY=(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "") || null
    } catch {
        return null
    }
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true })
    return dir
}

function fail(message) {
    console.error(message)
    process.exit(1)
}
