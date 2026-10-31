import { MONSTERS, nameOf, clockOf, liveModel, completedModel, linkedEvidence, activityBins } from './director-model.mjs'

const prefix = location.pathname.replace(/\/director\/?$/, '').replace(/\/$/, '')
const API = location.origin + prefix
const PORTRAIT_IDS = new Set(['sprout', 'pebble', 'momo', 'witch'])
const portraitUrl = id => PORTRAIT_IDS.has(id) ? `${API}/director-portraits/${id}.png` : null
const root = document.getElementById('root'), picker = document.getElementById('picker')
const refresh = document.getElementById('refresh'), connection = document.getElementById('connection')
let current = new URLSearchParams(location.search).get('game')
let generation = 0, controller = null, polling = null, ticking = null, fingerprint = '', selectedClue = null, messageFilter = 'all'
let cachedLive = { game: null, rows: [], since: null }
let renderedModel = null
let board = { panel: null, at: 0 }
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value
    else if (key === 'on') Object.entries(value).forEach(([event, fn]) => node.addEventListener(event, fn))
    else if (value !== undefined && value !== null) node.setAttribute(key, value)
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  return node
}
const NS = 'http://www.w3.org/2000/svg'
function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  for (const child of children.flat()) if (child) node.append(child)
  return node
}
function text(x, y, value, attributes = {}) {
  const node = svg('text', { x, y, fill: '#d6d6da', 'font-family': 'inherit', 'font-size': 12, ...attributes })
  node.textContent = String(value); return node
}
function icon(kind, size = 18) {
  const paths = {
    lock: ['M7 10V7a5 5 0 0 1 10 0v3', 'M5 10h14v11H5z', 'M12 14v3'],
    pulse: ['M2 12h5l3-7 4 14 3-7h5'],
    arrow: ['M4 12h16', 'm14 6 6 6-6 6'],
    check: ['m5 12 4 4L19 6'],
    eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'],
    clock: ['M12 8v5l3 2', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20']
  }
  return svg('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true }, (paths[kind] || paths.pulse).map(d => svg('path', { d })))
}
const badge = (label, className = '') => el('span', { class: `badge ${className}` }, label)
function panelHeader(title, subtitle, extra) {
  return el('div', { class: 'panel-header' }, el('div', {}, el('h2', { class: 'panel-title' }, title), el('p', { class: 'panel-subtitle' }, subtitle)), extra ? el('div', { class: 'panel-actions' }, extra) : null)
}
function empty(title, description, kind = 'lock') {
  return el('div', { class: 'empty-state' }, icon(kind, 24), el('strong', {}, title), el('p', {}, description))
}
function status(label, state) {
  if (!connection) return
  connection.replaceChildren(el('span', { class: 'status-dot', 'aria-hidden': true }), label)
  connection.dataset.state = state
}
async function getJSON(path, signal) {
  const response = await fetch(API + path, { signal })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status})`); error.status = response.status; throw error }
  return data
}
function loading() {
  root.replaceChildren(el('div', { class: 'dashboard skeleton', 'aria-busy': true, 'aria-label': 'Loading investigation' },
    el('div', { class: 'metrics-grid' }, Array.from({ length: 4 }, () => el('div', { class: 'metric-card' }, el('div', { class: 'skeleton-line' }), el('div', { class: 'skeleton-number' })))),
    el('div', { class: 'panel loading-indicator' }, icon('pulse', 24), el('p', {}, 'Opening the investigation…'))))
}
function updateClock() {
  const model = renderedModel
  if (!model?.locked) return
  const remaining = model.pub.deadlineAt === null ? null : Math.max(0, model.pub.deadlineAt - Date.now())
  root.querySelector('[data-clock]')?.replaceChildren(clockOf(remaining))
  const description = root.querySelector('[data-clock-label]')
  if (description) description.textContent = remaining === 0 ? 'Investigation window ended · awaiting outcome' : 'Until the library sees dawn'
  const result = root.querySelector('[data-result]')
  if (result) result.textContent = remaining === 0 ? 'Awaiting outcome' : 'In progress'
  const bar = root.querySelector('[data-time-progress]')
  const duration = model.pub.deadlineAt - model.pub.startedAt
  if (bar && duration > 0) bar.style.width = `${Math.max(0, Math.min(100, (1 - remaining / duration) * 100))}%`
}
function stopTimers() { clearTimeout(polling); clearInterval(ticking) }
async function loadPicker(signal) {
  const games = await getJSON('/api/games/recent', signal)
  if (!Array.isArray(games)) throw new Error('Recent investigations are unavailable')
  picker.replaceChildren(...games.map(game => el('option', { value: game.sessionId }, `${game.sessionId.replace(/^game_/, '#')} · ${new Date(game.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${game.phase === 'playing' ? 'Live' : game.phase}`)))
  if (!current && games.length) current = games[0].sessionId
  if (current && !games.some(game => game.sessionId === current)) picker.prepend(el('option', { value: current }, current))
  picker.value = current || ''; picker.disabled = games.length === 0 && !current
}
async function show({ initial = false } = {}) {
  stopTimers(); controller?.abort()
  const token = ++generation, session = current
  controller = new AbortController()
  const signal = controller.signal
  const valid = () => token === generation && session === current && !signal.aborted
  if (initial) { fingerprint = ''; loading() }
  if (!session) { renderedModel = null; root.replaceChildren(el('section', { class: 'panel' }, empty('No investigations yet', 'Begin an investigation in the library. Its activity will appear here.', 'pulse'))); status('No session', 'idle'); return }
  const url = new URL(location.href); url.searchParams.set('game', session); history.replaceState(null, '', url.pathname + url.search + url.hash)
  try {
    let view = null
    try { view = await getJSON(`/api/game/${encodeURIComponent(session)}/director`, signal) }
    catch (error) { if (error.status !== 403) throw error }
    if (!valid()) return
    let model, nextFingerprint
    if (view && view.public?.phase !== 'playing') {
      model = completedModel(view); nextFingerprint = JSON.stringify(view)
      status('Evidence unlocked', 'complete')
    } else {
      const state = await getJSON(`/api/game/${encodeURIComponent(session)}`, signal)
      if (!valid()) return
      if (cachedLive.game !== session) cachedLive = { game: session, rows: [], since: null }
      let relayAvailable = true
      try {
        const query = cachedLive.since === null ? '' : `?since=${encodeURIComponent(cachedLive.since)}`
        const data = await getJSON(`/api/game/${encodeURIComponent(session)}/relay-live${query}`, signal)
        if (!valid()) return
        const dedup = new Map(cachedLive.rows.map(row => [row.relayMessageId, row]))
        for (const row of Array.isArray(data.events) ? data.events : []) dedup.set(row.relayMessageId, row)
        cachedLive = { game: session, rows: [...dedup.values()], since: Number.isFinite(data.nextSince) ? data.nextSince : cachedLive.since }
      } catch (error) { if (error.name === 'AbortError') return; relayAvailable = false }
      model = liveModel(state, cachedLive.rows, Date.now(), relayAvailable)
      nextFingerprint = JSON.stringify([state, model.messages, relayAvailable])
      status(relayAvailable ? 'Live observation' : 'Relay reconnecting', relayAvailable ? 'live' : 'error')
    }
    if (!valid()) return
    if (nextFingerprint !== fingerprint) { render(model); fingerprint = nextFingerprint }
    else renderedModel = model
    updateClock()
    if (model.locked) { ticking = setInterval(updateClock, 500); polling = setTimeout(() => show(), 2500) }
  } catch (error) {
    if (!valid() || error.name === 'AbortError') return
    renderedModel = null; fingerprint = ''; status('Connection unavailable', 'error')
    root.replaceChildren(el('section', { class: 'panel error-state', role: 'alert' }, empty('Could not open this investigation', error.status === 404 ? 'This session is unavailable. Choose another investigation or refresh.' : 'The game server could not return its records. Try again when the connection is restored.', 'pulse'), el('button', { class: 'button button-primary', type: 'button', on: { click: () => show({ initial: true }) } }, 'Try again')))
  }
}

function metric(label, value, foot, extra, className = '') {
  return el('section', { class: `metric-card ${className}` }, el('div', { class: 'metric-label' }, label), el('div', { class: 'metric-value' }, value), extra, el('div', { class: 'metric-foot' }, foot))
}
function donut(value, label, segments, { locked = false } = {}) {
  const radius = 52, circumference = 2 * Math.PI * radius
  const chart = svg('svg', { viewBox: '0 0 140 140', role: 'img', 'aria-label': `${value ?? 'Unavailable'} ${label}${locked ? ', private records locked' : ''}` })
  chart.append(svg('circle', { cx: 70, cy: 70, r: radius, fill: 'none', stroke: '#252527', 'stroke-width': 13 }))
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  let offset = 0
  if (total > 0) for (const segment of segments) {
    const length = segment.value / total * circumference
    if (length) chart.append(svg('circle', { cx: 70, cy: 70, r: radius, fill: 'none', stroke: segment.color, 'stroke-width': 13, 'stroke-dasharray': `${Math.max(0, length - 3)} ${circumference}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 70 70)' }))
    offset += length
  }
  return el('div', { class: 'donut-wrap' }, chart, el('div', { class: 'donut-center' }, el('div', { class: 'donut-value' }, value ?? '-'), el('div', { class: 'donut-label' }, label)))
}
function breakdown(rows) { return el('div', { class: 'metric-breakdown' }, rows.map(row => el('div', { class: 'breakdown-item' }, el('span', {}, el('i', { style: `background:${row.color}`, 'aria-hidden': true }), row.label), el('strong', {}, row.value)))) }
function sparkline(model) {
  const start = model.pub.startedAt, end = model.locked ? Math.max(Date.now(), model.pub.deadlineAt || 0) : start + model.elapsed
  const bins = activityBins(model.messages, start, end)
  const chart = svg('svg', { viewBox: '0 0 240 50', class: 'sparkline', role: 'img', 'aria-label': `${model.messages.length} observed messages distributed over the investigation` })
  const max = Math.max(1, ...bins)
  chart.append(svg('path', { d: 'M0 47H240', fill: 'none', stroke: '#303034', 'stroke-width': 1 }))
  bins.forEach((value, index) => chart.append(svg('rect', { x: 3 + index * 15, y: 46 - value / max * 36, width: 7, height: Math.max(1, value / max * 36), rx: 2, fill: value ? '#8e8e94' : '#333338' })))
  return chart
}
function metricGrid(model) {
  const live = model.locked, pub = model.pub
  const clock = el('span', { 'data-clock': live ? '' : null, class: 'metric-clock' }, clockOf(live ? model.remaining : model.elapsed))
  const small = el('div', { class: 'metric-stack' },
    metric('Current round', pub.round ?? '—', `${pub.clues.length} published ${pub.clues.length === 1 ? 'clue' : 'clues'}`, icon('pulse'), 'compact'),
    metric(live ? 'Investigation' : 'Outcome', el('span', { 'data-result': live ? '' : null, class: 'metric-result' }, model.result), live ? 'Identity remains private' : `Spy: ${nameOf(model.spyId)}`, icon(live ? 'lock' : 'check'), 'compact'))
  const time = metric(live ? 'Time remaining' : 'Session duration', clock,
    el('span', { 'data-clock-label': live ? '' : null }, live ? 'Until the library sees dawn' : `Accused: ${model.accusation ? nameOf(model.accusation.monsterId) : 'No accusation'}`),
    [sparkline(model), el('div', { class: 'metric-progress', 'aria-hidden': true }, el('span', { 'data-time-progress': live ? '' : null, style: 'width:100%' }))], 'time-card')
  const relay = el('section', { class: 'metric-card' }, el('div', { class: 'metric-label' }, 'Agent Relay'), donut(model.relayTotal, live ? 'live' : 'messages', model.relayAvailable ? model.breakdown : []), breakdown(model.breakdown), !model.relayAvailable ? el('div', { class: 'metric-foot err' }, 'Live feed unavailable · retrying') : null)
  const linked = live ? null : model.pub.clues.filter(clue => model.evidence.some(e => e.clueId === clue.id && e.relayMessageIds?.length)).length
  const segments = live ? [] : [{ label: 'Linked to Relay', value: linked, color: '#d8d8dc' }, { label: 'Other omens', value: pub.clues.length - linked, color: '#55555b' }]
  const clues = el('section', { class: 'metric-card' }, el('div', { class: 'metric-label' }, 'Witch revelations'), donut(pub.clues.length, 'clues', segments, { locked: live }), live ? el('div', { class: 'metric-breakdown' }, el('div', { class: 'breakdown-item' }, el('span', {}, 'Evidence links'), badge('Locked')), el('div', { class: 'metric-foot' }, 'Source reports unlock after the ending')) : breakdown(segments))
  return el('div', { class: 'metrics-grid' }, small, time, relay, clues)
}

const positions = { player: [36, 145], sprout: [318, 64], pebble: [318, 151], momo: [318, 238], witch: [684, 151], clues: [928, 151] }
const nodeWidth = 162, nodeHeight = 66
function flowGraph(model) {
  const chart = svg('svg', { viewBox: '0 0 1100 330', role: 'img', 'aria-label': model.locked ? 'Participant topology only. Actual message routes are hidden until the game ends.' : 'Recorded information flow between player, monsters, witch, and clues' })
  const edges = svg('g', { class: 'flow-edges' }), nodes = svg('g')
  chart.append(edges, nodes)
  const colors = { told: '#747479', gossip: '#aaa0c0', report: '#b5a383', rejected: '#af7f83', reveal: '#a3b5a9', locked: '#3d3d43' }
  function edge(from, to, count, kind, ids = []) {
    if (!positions[from] || !positions[to] || (!model.locked && !count)) return
    const [x1, y1] = positions[from], [x2, y2] = positions[to]
    let path
    if (x1 === x2) {
      const side = y2 > y1 ? 1 : -1, x = x1 + nodeWidth
      path = `M${x} ${y1 + 40} C${x + 70 + side * 20} ${y1 + 40} ${x + 70 + side * 20} ${y2 + 20} ${x} ${y2 + 20}`
    } else {
      const sx = x1 + nodeWidth, ex = x2, sy = y1 + nodeHeight / 2, ey = y2 + nodeHeight / 2
      path = `M${sx} ${sy} C${sx + (ex - sx) * .5} ${sy} ${sx + (ex - sx) * .5} ${ey} ${ex} ${ey}`
    }
    const group = svg('g', { class: `flow-edge ${kind}`, 'data-message-ids': JSON.stringify(ids) })
    const line = svg('path', { d: path, fill: 'none', stroke: colors[kind], 'stroke-width': model.locked ? 1.4 : Math.min(1.5 + Math.log2(count + 1) * .6, 3.5), 'stroke-linecap': 'round', ...(model.locked || kind === 'rejected' ? { 'stroke-dasharray': '4 5' } : {}) })
    group.append(line)
    if (!model.locked && x1 !== x2) {
      const lx = (x1 + nodeWidth + x2) / 2, ly = (y1 + y2) / 2 + 21
      group.append(svg('rect', { x: lx - 13, y: ly - 12, width: 26, height: 20, rx: 6, fill: '#141416', stroke: '#303034' }), text(lx, ly + 2, count, { 'text-anchor': 'middle', 'font-size': 11 }))
    }
    const title = svg('title'); title.textContent = model.locked ? 'Topology only; route hidden' : `${nameOf(from)} → ${nameOf(to)}: ${count} ${kind}`; group.append(title); edges.append(group)
  }
  if (model.locked) {
    for (const id of Object.keys(MONSTERS)) { edge('player', id, null, 'locked'); edge(id, 'witch', null, 'locked') }
    edge('witch', 'clues', null, 'locked')
  } else {
    for (const id of Object.keys(MONSTERS)) edge('player', id, model.facts.filter(f => f.toldTo === id).length, 'told')
    const counts = new Map()
    for (const message of model.messages) {
      const key = `${message.from}|${message.to}|${message.kind}`
      if (!counts.has(key)) counts.set(key, [])
      counts.get(key).push(message.id)
    }
    for (const [key, ids] of counts) { const [from, to, kind] = key.split('|'); edge(from, to, ids.length, kind, ids) }
    edge('witch', 'clues', model.pub.clues.length, 'reveal')
  }
  const headings = [[36, '01 / SOURCE'], [318, '02 / MONSTERS'], [684, '03 / THE WITCH'], [928, '04 / REVEAL']]
  headings.forEach(([x, title]) => chart.append(text(x, 25, title, { fill: '#85858e', 'font-size': 10, 'letter-spacing': '1.2', class: 'flow-column-label' })))
  for (const [id, [x, y]] of Object.entries(positions)) {
    const isSpy = !model.locked && id === model.spyId
    const portrait = portraitUrl(id)
    const title = id === 'clues' ? 'Published clues' : nameOf(id)
    const subtitle = id === 'player' ? 'Private conversations' : id === 'witch' ? 'Secret keeper' : id === 'clues' ? `${model.pub.clues.length} public omens` : isSpy ? 'Hidden spy' : model.locked ? 'Hidden role' : 'Monster agent'
    const group = svg('g', { class: `flow-node ${portrait ? 'has-portrait' : ''} ${isSpy ? 'is-spy' : ''}`, role: 'img', 'aria-label': `${title}: ${subtitle}` })
    const accessibleTitle = svg('title'); accessibleTitle.textContent = `${title}: ${subtitle}`
    group.append(accessibleTitle, svg('rect', { x, y, width: nodeWidth, height: nodeHeight, rx: 10, fill: '#19191c', stroke: isSpy ? '#77656d' : '#35353a', 'stroke-width': 1 }))
    if (portrait) {
      const clipId = `director-portrait-${id}`
      const clipping = svg('clipPath', { id: clipId }, svg('rect', { x: x + 8, y: y + 8, width: 50, height: 50, rx: 8 }))
      group.append(svg('defs', {}, clipping), svg('rect', { class: 'flow-portrait-well', x: x + 8, y: y + 8, width: 50, height: 50, rx: 8, fill: '#232327', stroke: '#37373d' }), text(x + 33, y + 39, title[0], { class: 'flow-portrait-fallback', 'font-size': 20, 'text-anchor': 'middle', fill: '#aaaab4', 'aria-hidden': true }))
      const image = svg('image', { class: 'flow-portrait', x: x + 8, y: y + 8, width: 50, height: 50, href: portrait, 'clip-path': `url(#${clipId})`, preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': true })
      image.addEventListener('load', () => { group.querySelector('.flow-portrait-fallback')?.setAttribute('display', 'none') })
      image.addEventListener('error', () => { image.setAttribute('display', 'none'); group.querySelector('.flow-portrait-fallback')?.removeAttribute('display') })
      group.append(image)
    } else group.append(svg('rect', { x: x + 12, y: y + 20, width: 3, height: 26, rx: 1.5, fill: '#6c6c76' }))
    const labelX = x + (portrait ? 68 : 27)
    group.append(text(labelX, y + 27, title, { class: 'flow-node-title', fill: '#ebebee', 'font-size': 13, 'font-weight': 550 }), text(labelX, y + 47, subtitle, { class: 'flow-node-subtitle', fill: '#95959e', 'font-size': 10 }))
    nodes.append(group)
  }
  return chart
}


// Canonical record IDs select portraits only after private evidence has unlocked.
function actorIdentity(id, label = nameOf(id)) {
  const url = portraitUrl(id)
  const image = url ? el('img', { class: 'actor-avatar', src: url, alt: '', width: 26, height: 26, loading: 'lazy', decoding: 'async', on: { error: event => { event.currentTarget.hidden = true } } }) : null
  return el('span', { class: 'route-actor' }, image, el('span', {}, label))
}

// Postmortem: every security-relevant event of the game, labelled like an incident report.
// The spy is a compromised agent, the witch an outside party, gossip is agent-to-agent traffic.
function securityPanel(model) {
  if (model.locked || !model.security) return null
  const { summary, incidents } = model.security
  const stat = (label, value, tone = '') => el('div', { class: `sec-stat ${tone}` }, el('span', {}, label), el('strong', {}, String(value)))
  const stats = el('div', { class: 'sec-stats' },
    stat('Data leaks', summary.leaks, summary.leaks ? 'high' : ''),
    stat('Made public', summary.leaksMadePublic),
    stat('Injections contained', summary.injections, summary.injections ? 'medium' : ''),
    stat('Attacks blocked', summary.blocked, summary.blocked ? 'ok' : ''),
    stat('Traced to source', summary.leaks ? (summary.tracedToSource ? 'Yes' : 'Partly') : '-'))
  const list = incidents.length ? el('ol', { class: 'incident-list' }, incidents.map(i => el('li', { class: `incident sev-${i.severity}` },
    el('div', { class: 'incident-head' },
      el('span', { class: `sev-chip sev-${i.severity}` }, i.severity === 'info' ? 'Info' : `${i.severity[0].toUpperCase()}${i.severity.slice(1)}`),
      el('span', { class: 'incident-label' }, i.label),
      el('span', { class: `incident-outcome out-${i.outcome.toLowerCase()}` }, i.outcome),
      i.at === null ? null : el('span', { class: 'incident-time' }, `+${clockOf(i.at)}`)),
    el('p', { class: 'incident-title' }, i.title),
    el('p', { class: 'incident-detail' }, i.detail),
    i.relayMessageId ? el('p', { class: 'incident-evidence' }, `Evidence: Agent Relay message ${i.relayMessageId}`) : null)))
    : empty('No incidents', 'Nothing security-relevant happened in this game.', 'pulse')
  return el('section', { class: 'panel security-panel', id: 'security' },
    panelHeader('Security report', 'Every leak, attack and spread in this game, labelled for the postmortem.', badge(`${incidents.length} incidents`)),
    stats, list)
}

function render(model) {
  renderedModel = model
  const flow = el('section', { class: 'panel flow-panel', id: 'flow' },
    panelHeader('Investigation flow', model.locked ? 'The participants are visible. Their private routes are not.' : 'Follow the secrets from the player to the witch.', badge(model.locked ? 'Routes locked' : 'Evidence unlocked', model.locked ? '' : 'positive')),
    el('div', { class: 'flow-canvas' }, flowGraph(model)),
    el('div', { class: 'flow-legend' }, model.locked ? [el('span', { class: 'legend-item' }, el('i', { style: '--legend-color:#626269' }), 'Dashed connections show topology only'), el('span', {}, 'Private activity unlocks after the ending')] : [['Player told', '#747479'], ['Gossip', '#aaa0c0'], ['Spy report', '#b5a383'], ['Rejected', '#af7f83'], ['Witch reveal', '#a3b5a9']].map(([label, color]) => el('span', { class: 'legend-item' }, el('i', { style: `--legend-color:${color}` }), label))))
  const privacy = el('div', { class: `privacy-note ${model.locked ? '' : 'unlocked'}` }, el('span', { class: 'privacy-icon' }, icon(model.locked ? 'lock' : 'eye', 16)), el('div', { class: 'privacy-copy' }, model.locked ? 'Live observation · Private identities, message contents and evidence links stay hidden until this investigation ends.' : `Investigation complete · ${nameOf(model.spyId)} was the spy. ${model.accusation ? `The player accused ${nameOf(model.accusation.monsterId)}.` : 'No accusation was made.'}`))
  const msgNodes = new Map(), eventNodes = new Map(), clueNodes = new Map()
  const messageList = el('div', { class: 'message-list' })
  const filters = el('div', { class: 'filter-row', 'aria-label': 'Filter messages' })
  function populateMessages() {
    msgNodes.clear()
    const messages = model.messages.filter(message => messageFilter === 'all' || (messageFilter === 'reports' ? message.kind === 'report' || message.kind === 'rejected' : message.kind === 'gossip'))
    messageList.replaceChildren(...(messages.length ? messages.slice().reverse().map(message => {
      const masked = model.locked
      const route = masked
        ? el('span', {}, message.kind === 'handoff' ? 'Game master handoff' : 'A monster whispered')
        : el('span', { class: 'route-label' }, actorIdentity(message.from, nameOf(message.verifiedFrom || message.from)), el('span', { class: 'route-arrow', 'aria-hidden': true }, '→'), actorIdentity(message.to))
      const node = el('article', { class: `msg ${message.kind}` },
        el('div', { class: 'route' }, route, el('span', { class: 'message-time' }, `+${clockOf(message.at - model.pub.startedAt)}`)),
        masked ? el('div', { class: 'redacted-line', 'aria-label': 'Message content hidden' }, el('span'), el('span')) : el('p', { class: 'message-body' }, message.text ?? 'Message text unavailable from Agent Relay.'),
        el('div', { class: 'message-meta' }, badge(masked ? 'Protected' : message.kind === 'report' ? 'Spy report' : message.kind === 'rejected' ? message.reason === 'game_over' ? 'Rejected · game ended' : 'Rejected · not the spy' : 'Gossip'), message.readFailed ? el('span', { class: 'err' }, 'Relay read unavailable') : null),
        el('details', { class: 'record-details' }, el('summary', {}, 'Message record'), el('code', { class: 'ids' }, message.id)))
      msgNodes.set(message.id, node); return node
    }) : [empty(messageFilter === 'all' ? 'No messages observed' : 'No matching messages', model.locked ? 'Private Relay activity will appear here as it arrives.' : 'This investigation has no records in this category.', 'pulse')]))
    filters.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === messageFilter)))
    applySelection(false)
  }
  if (!model.locked) for (const [value, label] of [['all', 'All messages'], ['gossip', 'Gossip'], ['reports', 'Reports']]) filters.append(el('button', { class: 'filter-button', 'data-filter': value, type: 'button', 'aria-pressed': String(messageFilter === value), on: { click: () => { messageFilter = value; populateMessages() } } }, label))
  const messagesPanel = el('section', { class: 'panel messages-panel', id: 'messages' }, panelHeader('Agent Relay', model.locked ? 'Anonymous live activity from this investigation.' : 'Actual messages re-read from Agent Relay.', badge(model.relayAvailable ? `${model.relayTotal} recorded` : 'Reconnecting')), filters, !model.relayAvailable ? el('p', { class: 'inline-error', role: 'status' }, 'The live feed is temporarily unavailable. Previously observed records are shown below.') : null, messageList)
  const timelineList = el('ol', { class: 'timeline' })
  for (const event of model.events) {
    const extras = Object.entries(event.detail).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ')
    const li = el('li', {}, el('span', { class: 'seq' }, `#${event.seq}`), el('span', { class: 't' }, `+${clockOf(event.at - model.pub.startedAt)}`), el('div', { class: 'event-content' }, el('strong', { class: 'type' }, event.type.replaceAll('_', ' ').toLowerCase()), extras ? el('p', {}, extras) : null))
    eventNodes.set(event.seq, li); timelineList.append(li)
  }
  const timelinePanel = el('section', { class: 'panel timeline-panel', id: 'timeline' }, panelHeader('Event timeline', 'The durable record, kept by Terse.', badge(model.locked ? 'After the ending' : `${model.events.length} events`)), model.locked ? empty('The full story is still unfolding', 'Private actor events unlock when the investigation ends.') : model.events.length ? timelineList : empty('No recorded events', 'This investigation returned no timeline records.', 'clock'))
  const cluesPanel = el('section', { class: 'panel clues-panel', id: 'clues' }, panelHeader('The witch’s clues', model.locked ? 'Published omens, without their private sources.' : 'Select a clue to trace the message behind it.', badge(`${model.pub.clues.length} omens`)))
  for (const clue of model.pub.clues) {
    const linked = !model.locked && model.evidence.some(e => e.clueId === clue.id && e.relayMessageIds?.length)
    const node = el(model.locked ? 'article' : 'button', { class: 'clue', type: model.locked ? null : 'button', 'aria-pressed': model.locked ? null : String(selectedClue === clue.id), on: model.locked ? {} : { click: () => { selectedClue = selectedClue === clue.id ? null : clue.id; if (messageFilter !== 'all') { messageFilter = 'all'; populateMessages() }; applySelection(true) } } }, el('div', { class: 'clue-meta' }, el('span', {}, `Round ${clue.round}`), el('span', {}, `+${clockOf(clue.revealedAt - model.pub.startedAt)}`)), el('p', {}, clue.content), el('span', { class: 'clue-source' }, model.locked ? 'Source protected' : linked ? 'Trace the Relay report ↗' : `${clue.kind} omen`))
    clueNodes.set(clue.id, node); cluesPanel.append(node)
  }
  if (!model.pub.clues.length) cluesPanel.append(empty('No omen yet', model.locked ? 'The witch will publish her clues as the investigation unfolds.' : 'No clues were published in this investigation.', 'eye'))
  function applySelection(scroll) {
    const linked = linkedEvidence(model, selectedClue)
    clueNodes.forEach((node, id) => { node.classList.toggle('active', id === selectedClue); if (!model.locked) node.setAttribute('aria-pressed', String(id === selectedClue)) })
    msgNodes.forEach((node, id) => node.classList.toggle('hl', linked.messages.has(id)))
    eventNodes.forEach((node, id) => node.classList.toggle('hl', linked.events.has(id)))
    flow.querySelectorAll('.flow-edge').forEach(node => node.classList.toggle('hl', JSON.parse(node.dataset.messageIds || '[]').some(id => linked.messages.has(id))))
    if (scroll && linked.messages.size) [...msgNodes].find(([id]) => linked.messages.has(id))?.[1].scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' })
  }
  populateMessages()
  const footer = el('div', { class: 'footer' }, el('span', {}, el('i', { class: 'footer-dot' }), 'Agent Relay carries the whispers. Terse keeps the record.'), el('span', {}, model.pub.sessionId))
  const dashboard = el('div', { class: 'dashboard', id: 'overview' }, metricGrid(model), privacy, securityPanel(model), flow, el('div', { class: 'lower-grid' }, messagesPanel, cluesPanel, timelinePanel), footer)
  root.replaceChildren(dashboard)
  void leaderboardPanel().then(panel => { if (panel && dashboard.isConnected) dashboard.insertBefore(panel.cloneNode(true), footer) })
  if (selectedClue && !clueNodes.has(selectedClue)) selectedClue = null
  applySelection(false)
}

// ---------- all games (Supabase; the endpoint reports disabled without keys) ----------
async function leaderboardPanel() {
  if (Date.now() - board.at < 15000) return board.panel
  board.at = Date.now()
  const lb = await getJSON('/api/leaderboard').catch(() => null)
  if (!lb || lb.disabled || !lb.totals) return board.panel = null
  const t = lb.totals, top = lb.monsters?.[0]
  const stat = (label, value) => el('div', { class: 'board-stat' }, el('span', {}, label), el('strong', {}, value))
  return board.panel = el('section', { class: 'panel board-panel', id: 'all-games' },
    panelHeader('All games', 'Every finished game is archived to Supabase Postgres; live games stay in Terse actors.', badge(`${t.games} played`)),
    el('div', { class: 'board-stats' },
      stat('Players escaped', t.escape_rate_pct === null ? '—' : `${t.escape_rate_pct}%`),
      stat('Fastest catch', t.fastest_catch_seconds === null ? '—' : clockOf(t.fastest_catch_seconds * 1000)),
      stat('Most deceptive', top ? `${nameOf(top.monster)} · ${top.got_away_pct ?? 0}%` : '—'),
      stat('Whispers sent', String(t.total_whispers)),
      stat('Fakes blocked', String(t.total_fakes_blocked))))
}

picker.addEventListener('change', () => {
  current = picker.value; selectedClue = null; messageFilter = 'all'; cachedLive = { game: null, rows: [], since: null }; show({ initial: true })
})
refresh.addEventListener('click', async () => {
  refresh.disabled = true
  const session = current
  try { await loadPicker(); if (current === session || !session) await show({ initial: true }) }
  catch { status('Could not refresh sessions', 'error') }
  finally { refresh.disabled = false }
})
function syncNavigation() {
  const view = location.hash === '#messages' ? 'messages' : location.hash === '#timeline' ? 'timeline' : 'overview'
  for (const item of document.querySelectorAll('.topnav a[data-view]')) {
    const active = item.dataset.view === view
    item.classList.toggle('active', active)
    item.setAttribute('aria-current', active ? 'page' : 'false')
  }
}
window.addEventListener('hashchange', syncNavigation)
syncNavigation()
window.addEventListener('pagehide', () => { stopTimers(); controller?.abort() })
window.addEventListener('pageshow', event => {
  syncNavigation()
  if (event.persisted) void show({ initial: true })
})
loading()
loadPicker().then(() => show({ initial: true })).catch(() => {
  if (current) { picker.replaceChildren(el('option', { value: current }, current)); picker.value = current; void show({ initial: true }); return }
  status('Server unavailable', 'error'); root.replaceChildren(el('section', { class: 'panel error-state', role: 'alert' }, empty('The director is offline', 'Refresh to reconnect to the game server.', 'pulse')))
})
