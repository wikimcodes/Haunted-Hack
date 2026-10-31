import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExitJourney, nextExitWaypoint, outdoorBlend } from './exitJourney'

test('finishing requires crossing the real doorway and walking well outside', () => {
    const journey = new ExitJourney()
    assert.equal(journey.step({x:3.9,z:-2.9},{x:4.08,z:-2.9},true), false)
    assert.equal(journey.step({x:6.9,z:-2.9},{x:7,z:-2.9},true), false)
    assert.equal(journey.step({x:9.5,z:-2.9},{x:9.7,z:-2.9},true), true)
    assert.equal(journey.step({x:9.7,z:-2.9},{x:10,z:-2.9},true), false)
})
test('closed doors, another wall, starting outside or a camera jump cannot count as escaping', () => {
    assert.equal(new ExitJourney().step({x:3,z:-2.9},{x:10,z:-2.9},true), false)
    assert.equal(new ExitJourney().step({x:3,z:-2.9},{x:10,z:-2.9},false), false)
    assert.equal(new ExitJourney().step({x:3,z:0},{x:10,z:0},true), false)
    assert.equal(new ExitJourney().step({x:8,z:-2.9},{x:10,z:-2.9},true), false)
})
test('returning inside clears the crossing and restart permits exactly one fresh completion', () => {
    const journey = new ExitJourney()
    journey.step({x:3.9,z:-2.9},{x:4.08,z:-2.9},true)
    journey.step({x:4.08,z:-2.9},{x:2.9,z:-2.9},true)
    assert.equal(journey.step({x:9.5,z:-2.9},{x:9.7,z:-2.9},true),false)
    journey.step({x:3.9,z:-2.9},{x:4.08,z:-2.9},true)
    assert.equal(journey.step({x:9.5,z:-2.9},{x:9.7,z:-2.9},true),true)
    journey.reset()
    journey.step({x:3.9,z:-2.9},{x:4.08,z:-2.9},true)
    assert.equal(journey.step({x:9.5,z:-2.9},{x:9.7,z:-2.9},true),true)
})
test('guidance routes around the front of the desk before facing the door', () => {
    assert.deepEqual(nextExitWaypoint({x:-.7,z:4.35}),{x:2.85,z:2.05})
    assert.deepEqual(nextExitWaypoint({x:2.85,z:2.05}),{x:2.85,z:-2.9})
    assert.deepEqual(nextExitWaypoint({x:2.85,z:-2.9}),{x:11,z:-2.9})
    assert.equal(outdoorBlend({x:0,z:0}),0)
    assert.equal(outdoorBlend({x:8,z:0}),1)
})
