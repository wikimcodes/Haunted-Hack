import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveModel, completedModel, linkedEvidence, activityBins } from './director-model.mjs'

const pub = { sessionId: 'test', phase: 'playing', startedAt: 1000, deadlineAt: 181000, round: 1, spyId: 'momo', clues: [{ id: 'clue', round: 1, kind: 'echo', content: 'A public omen', revealedAt: 5000 }] }
test('live projection never carries private sender, text, spy, or evidence even if API provides them', () => {
  const model = liveModel({ ...pub, reports: [{ text: 'private' }] }, [{ relayMessageId: 'one', kind: 'whisper', from: 'momo', text: 'secret', at: 2000, length: 6 }], 182000)
  assert.equal(model.result, 'Awaiting outcome')
  assert.equal(model.relayTotal, 1)
  assert.equal(model.spyId, null)
  assert.ok(!JSON.stringify(model).includes('secret'))
  assert.ok(!JSON.stringify(model).includes('momo'))
  assert.equal(model.messages[0].from, undefined)
})
test('live polling deduplicates message IDs and reports missing data honestly', () => {
  const row = { relayMessageId: 'one', kind: 'whisper', at: 2000 }
  assert.equal(liveModel(pub, [row, row]).relayTotal, 1)
  assert.equal(liveModel(pub, [], 2000, false).relayTotal, null)
})
test('completed evidence refuses playing state and never substitutes stored gossip for missing Relay text', () => {
  assert.throws(() => completedModel({ public: pub }))
  const model = completedModel({ public: { ...pub, phase: 'expired' }, gossip: [{ relayMessageId: 'one', text: 'do not substitute', from: 'sprout', to: 'momo', createdAt: 2000 }], relay: { messages: [{ id: 'one', error: 'offline' }] } })
  assert.equal(model.messages[0].text, null)
  assert.equal(model.messages[0].readFailed, true)
})
test('a clue links its actual report, upstream shared facts, and matching events only', () => {
  const model = completedModel({ public: { ...pub, phase: 'won' }, spyId: 'momo', gossip: [
    { relayMessageId: 'upstream', from: 'sprout', to: 'momo', factIds: ['fact'], createdAt: 2000 },
    { relayMessageId: 'unrelated', from: 'pebble', to: 'momo', factIds: ['other'], createdAt: 3000 }
  ], reports: [{ relayMessageId: 'report', sourceMonsterId: 'momo', factIds: ['fact'], receivedAt: 4000 }], evidence: [{ clueId: 'clue', relayMessageIds: ['report'] }], events: [{ seq: 1, type: 'REPORT', at: 4000, detail: '{"relayMessageId":"report"}' }, { seq: 2, type: 'OTHER', detail: '{}' }] })
  const linked = linkedEvidence(model, 'clue')
  assert.deepEqual([...linked.messages].sort(), ['report', 'upstream'])
  assert.deepEqual([...linked.events], [1])
})
test('activity histogram counts only observed timestamps and keeps empty data empty', () => {
  assert.deepEqual(activityBins([], 0, 100, 4), [0, 0, 0, 0])
  assert.deepEqual(activityBins([{ at: 0 }, { at: 28 }, { at: 100 }, { at: 101 }], 0, 100, 4), [1, 1, 0, 1])
})
