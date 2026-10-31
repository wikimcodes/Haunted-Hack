// Records the player's spoken question. Browsers only allow the microphone on HTTPS (or localhost).

const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]

export interface Recording {
    /** Stops recording and resolves to the audio. */
    stop: () => Promise<Blob>
    /** Stops recording and throws the audio away. */
    cancel: () => void
}

export const canRecord = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"

/** Starts recording the microphone. Throws if the player blocks microphone access. */
export async function startRecording(): Promise<Recording> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    const mimeType = RECORDING_TYPES.find(type => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    const release = () => stream.getTracks().forEach(track => track.stop())
    recorder.start()
    return {
        stop: () => new Promise<Blob>(resolve => {
            const done = () => { release(); resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" })) }
            if (recorder.state === "inactive") return done()
            recorder.onstop = done
            recorder.stop()
        }),
        cancel: () => { recorder.onstop = release; if (recorder.state !== "inactive") recorder.stop(); else release() }
    }
}
