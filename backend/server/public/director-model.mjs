export const MONSTERS = Object.freeze({ sprout: 'Sprout', pebble: 'Pebble', momo: 'Momo' })
export const nameOf = id => MONSTERS[id] || ({ player: 'Player', witch: 'Witch', gamemaster: 'Game master' }[id]) || id || 'Unknown'
const list = value => Array.isArray(value) ? value : []
const number = value => Number.isFinite(value) ? value : null
export function clockOf(ms) {
  if (!Number.isFinite(ms)) return '—'
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
export function publicProjection(state = {}) {
  return {
    sessionId: String(state.sessionId || ''), phase: state.phase || 'playing',
    startedAt: number(state.startedAt), deadlineAt: number(state.deadlineAt), nextRevealAt: number(state.nextRevealAt),
    round: number(state.round),
    clues: list(state.clues).filter(c => c.kind !== 'ending').map(c => ({ id: c.id, round: c.round, kind: c.kind, content: c.content, revealedAt: c.revealedAt }))
  }
}
/** Deliberately whitelist live fields: even an unexpectedly unmasked response cannot populate private UI. */
export function liveModel(state, rows = [], now = Date.now(), relayAvailable = true) {
  const pub = publicProjection(state)
  const seen = new Set()
  const messages = list(rows).filter(r => r.relayMessageId && !seen.has(r.relayMessageId) && seen.add(r.relayMessageId))
    .map(r => ({ id: String(r.relayMessageId), kind: r.kind === 'handoff' ? 'handoff' : 'whisper', at: number(r.at), length: number(r.length) ?? 0 }))
    .sort((a, b) => a.at - b.at)
  const remaining = pub.deadlineAt === null ? null : Math.max(0, pub.deadlineAt - now)
  return { locked: true, pub, messages, spyId: null, facts: [], evidence: [], events: [],
    relayAvailable, relayTotal: relayAvailable ? messages.length : null,
    breakdown: [{ label: 'Whispers', value: messages.filter(m => m.kind === 'whisper').length, color: '#dddddf' }, { label: 'Handoffs', value: messages.filter(m => m.kind === 'handoff').length, color: '#59595e' }],
    remaining, elapsed: pub.startedAt === null ? null : Math.max(0, now - pub.startedAt),
    result: remaining === 0 ? 'Awaiting outcome' : 'In progress' }
}
export function completedModel(view) {
  if (!view?.public || view.public.phase === 'playing') throw new Error('Private evidence is not available while playing')
  const pub = publicProjection(view.public)
  const relayById = new Map(list(view.relay?.messages).map(m => [m.id, m]))
  const messages = [], seen = new Set()
  const add = message => {
    if (!message.id || seen.has(`${message.kind}:${message.id}`)) return
    seen.add(`${message.kind}:${message.id}`)
    const actual = relayById.get(message.id)
    messages.push({ ...message, factIds: list(message.factIds), text: typeof actual?.text === 'string' ? actual.text : null,
      verifiedFrom: typeof actual?.from === 'string' ? actual.from : null, readFailed: Boolean(actual?.error) })
  }
  for (const g of list(view.gossip)) add({ kind: 'gossip', id: g.relayMessageId, from: g.from, to: g.to, at: g.createdAt, factIds: g.factIds })
  for (const r of list(view.reports)) add({ kind: 'report', id: r.relayMessageId, from: r.sourceMonsterId, to: 'witch', at: r.receivedAt, factIds: r.factIds, reportId: r.id })
  for (const r of list(view.rejectedReports)) add({ kind: 'rejected', id: r.relayMessageId, from: r.from, to: 'witch', at: r.at, reason: r.reason || 'not_spy' })
  messages.sort((a, b) => a.at - b.at)
  const endedAt = list(view.public.clues).find(c => c.kind === 'ending')?.revealedAt ?? view.public.accusation?.at ?? pub.deadlineAt
  const events = list(view.events).map(e => {
    let detail = {}
    try { const parsed = JSON.parse(e.detail || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed } catch {}
    return { seq: e.seq, type: String(e.type || 'Event'), at: number(e.at), detail }
  })
  return { locked: false, pub, messages, spyId: view.spyId, facts: list(view.facts), evidence: list(view.evidence), events, security: view.security || null,
    accusation: view.public.accusation, workspace: view.relay?.workspace || null, relayAvailable: true,
    relayTotal: new Set(messages.map(m => m.id)).size,
    breakdown: [{ label: 'Gossip', value: messages.filter(m => m.kind === 'gossip').length, color: '#dddddf' }, { label: 'Reports', value: messages.filter(m => m.kind === 'report').length, color: '#9c99ad' }, { label: 'Rejected', value: messages.filter(m => m.kind === 'rejected').length, color: '#5c5b61' }],
    elapsed: pub.startedAt === null || endedAt === null ? null : Math.max(0, endedAt - pub.startedAt), remaining: 0,
    result: ({ won: 'Player escaped', lost: 'Wrong ghost accused', expired: 'Dawn came' }[pub.phase]) || 'Completed' }
}
export function linkedEvidence(model, clueId) {
  if (model.locked) return { messages: new Set(), events: new Set() }
  const direct = new Set(model.evidence.find(e => e.clueId === clueId)?.relayMessageIds || [])
  const reports = model.messages.filter(m => direct.has(m.id))
  const facts = new Set(reports.flatMap(m => m.factIds))
  const senders = new Set(reports.map(m => m.from))
  const messages = new Set(model.messages.filter(m => direct.has(m.id) || (m.kind === 'gossip' && senders.has(m.to) && m.factIds.some(id => facts.has(id)))).map(m => m.id))
  const events = new Set(model.events.filter(e => e.detail.clueId === clueId || direct.has(e.detail.relayMessageId)).map(e => e.seq))
  return { messages, events }
}
/** Observed activity, not a synthetic trend. Exact empty bins remain empty. */
export function activityBins(messages, start, end, count = 16) {
  const bins = Array(count).fill(0)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return bins
  for (const message of messages) {
    if (!Number.isFinite(message.at) || message.at < start || message.at > end) continue
    bins[Math.min(count - 1, Math.floor((message.at - start) / (end - start) * count))]++
  }
  return bins
}
