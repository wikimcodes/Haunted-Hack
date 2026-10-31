# Library sound design

Both files were generated with the ElevenLabs Sound Effects API (`eleven_text_to_sound_v2`, prompt influence 0.6), then levelled with ffmpeg by `scripts/generate-audio-elevenlabs.mjs`. They contain no intelligible speech. The exact prompts and measurements are in `audio-stats.json`.

| File | Intended use | Duration | Download size | Peak / mean |
| --- | --- | --- | --- | --- |
| `library-room.mp3` | Reversed ghostly whispers, a child humming far away, nails scraping on wood, metallic groans, close creaks and a pulsing drone, with sudden quiet moments and a distant thud; stereo loop | 29.5 s | 473,172 bytes | −8.4 / −25.5 dBFS |
| `witch-reveal.mp3` | Witch arrival sting; play once per reveal | 6.0 s | 97,009 bytes | −5.4 / −23.9 dBFS |

Both are stereo 44.1 kHz MP3 at 128 kbit/s, 570,181 bytes in total.

## Processing

- **Level:** linear gain only, no compressor. Each file is raised or lowered until its peak is −8 dBFS, or its mean is −20 dBFS, whichever needs less gain. MP3 encoding can overshoot that peak on sharp transients, which is why the reveal measures −5.4 dBFS. That is still clear of clipping.
- **Room loop:** ElevenLabs is asked for a seamless 30-second loop. The script then blends the last 0.5 s into the start with an equal-power crossfade. That leaves 29.5 s and removes the click a raw generation can have at the loop point.
- **Reveal:** padded or trimmed to exactly 6 s, with a 1.2 s fade-out.

The reveal was chosen by ear from several generations. Its loudest hit is around 0.35 s and further impacts land around 2.2–2.9 s, so it does not follow the old procedural timeline, where the impact landed at 0.95 s. `LibraryAudio` still ducks the room to 4% for the first 0.72 s and returns it gradually by 6 s.

## Integration

- **Mix:** master gain `0.8`, room gain `0.62` (effective `0.496`), reveal gain `0.9` (effective `0.72`).
- **Clock:** follow the existing cinematic clock. A delayed unlock or unmute should seek to the current reveal time rather than restart it.
- **Scope:** ambient playback belongs to the active room. Stop or suspend it on the title screen, in a hidden tab and in the paused room, and honor the player's mute choice.
- **No game data:** these files only provide sound design. They do not encode dialogue, clues, agent messages or a hidden spy identity.
- **Cache:** after replacing the files, bump `SOUND_REVISION` in `src/audio/LibraryAudio.ts` so browsers fetch them again.

## Regenerate

Needs `ELEVENLABS_API_KEY` in `backend/server/.env` (see `ENV.md`) and FFmpeg with `libmp3lame` on PATH. Every generation uses ElevenLabs credits. From `frontend-game/`:

```sh
npm run audio:elevenlabs                                   # replace both files
npm run audio:elevenlabs -- --preview /tmp/sfx -n 3        # 3 candidates of each, public/audio/ untouched
npm run audio:elevenlabs -- --only room --text "..." --preview /tmp/sfx --label idea
```

Generations differ every run, so preview candidates and copy the one you like into `public/audio/`.

The older procedural generator, `python3 scripts/generate-audio.py`, needs no API key. It rebuilds the original synthesized room loop and reveal.
