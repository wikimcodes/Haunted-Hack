// Terse's generated client times its sessions with performance.now(), which stops while the Mac
// sleeps. After any sleep it then rejects every fresh session as "expired or invalid" until the
// process restarts. Tie performance.now() to the wall clock so sessions keep renewing after sleep.
// Import this first in every process that talks to Terse.
const origin = performance.timeOrigin
performance.now = () => Date.now() - origin
export {}
