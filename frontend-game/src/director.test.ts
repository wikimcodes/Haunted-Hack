import assert from "node:assert/strict"
import test from "node:test"
import { directorUrl } from "./director"

test("Director entry opens the configured API view and pins the selected game", () => {
    assert.equal(directorUrl(), "http://localhost:3001/director")
    assert.equal(directorUrl("https://api.example.test/", "game_123"), "https://api.example.test/director?game=game_123")
    assert.equal(directorUrl("https://api.example.test", null), "https://api.example.test/director")
})

test("Director preserves deployment prefixes and resolves same-origin API prefixes", () => {
    assert.equal(directorUrl("https://example.test/game-backend///", "g1"), "https://example.test/game-backend/director?game=g1")
    assert.equal(directorUrl("/backend", "g2", "https://game.example.test"), "https://game.example.test/backend/director?game=g2")
})

test("a game identifier stays one query value and stale query/hash state is discarded", () => {
    const game = "game/a?other=b&label=two words#end"
    const url = new URL(directorUrl("https://api.example.test/base/?old=1#section", game)!)
    assert.equal(url.pathname, "/base/director")
    assert.deepEqual([...url.searchParams], [["game", game]])
    assert.equal(url.hash, "")
})

test("untrusted protocols and credential-bearing addresses cannot become Director links", () => {
    for (const base of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/director", "https://user:secret@example.test", "not a URL"]) {
        assert.equal(directorUrl(base), null, base)
    }
})
