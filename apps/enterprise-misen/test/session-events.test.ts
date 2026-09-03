import test from 'node:test'
import { strict as assert } from 'node:assert'
import { eventAppliesToActiveSession, sessionIdForEvent, type SessionEventShape } from '../src/web/session-events.js'

type ProjectedState = {
  status: 'idle' | 'running' | 'COMPLETED'
  sessionId?: string
  artifacts: string[]
}

function applyState(current: ProjectedState, activeSessionId: string | undefined, event: SessionEventShape): ProjectedState {
  if (!eventAppliesToActiveSession(event, activeSessionId) || event.type !== 'state' || !event.state) return current
  const state = event.state as ProjectedState
  return { status: state.status, sessionId: state.sessionId, artifacts: state.artifacts }
}

test('canonical session identity covers top-level and nested state event shapes', () => {
  assert.equal(sessionIdForEvent({ type: 'assistant', sessionId: 'session-a' }), 'session-a')
  assert.equal(sessionIdForEvent({ type: 'state', state: { sessionId: 'session-b' } }), 'session-b')
  assert.equal(sessionIdForEvent({ type: 'state', state: {} }), undefined)
})

test('foreign and reconnect state cannot contaminate the active session projection', () => {
  const active = 'session-b'
  const sessionAState = { type: 'state', state: { status: 'running', sessionId: 'session-a', artifacts: ['artifact-a'] } }
  const sessionBState = { type: 'state', state: { status: 'COMPLETED', sessionId: 'session-b', artifacts: ['artifact-b'] } }
  const reconnectAState = { type: 'state', state: { status: 'COMPLETED', sessionId: 'session-a', artifacts: ['stale-artifact-a'] } }
  let projected: ProjectedState = { status: 'idle', sessionId: active, artifacts: [] }

  projected = applyState(projected, active, sessionAState)
  assert.deepEqual(projected, { status: 'idle', sessionId: active, artifacts: [] })

  projected = applyState(projected, active, sessionBState)
  assert.deepEqual(projected, { status: 'COMPLETED', sessionId: active, artifacts: ['artifact-b'] })

  projected = applyState(projected, active, reconnectAState)
  assert.deepEqual(projected, { status: 'COMPLETED', sessionId: active, artifacts: ['artifact-b'] })
  assert.equal(eventAppliesToActiveSession({ type: 'assistant', sessionId: 'session-a' }, active), false)
  assert.equal(eventAppliesToActiveSession({ type: 'assistant', sessionId: active }, active), true)
})

test('sessionless events are startup-global and fail closed once a session is active', () => {
  const globalState = { type: 'state', state: { status: 'idle', artifacts: [] } }
  assert.equal(eventAppliesToActiveSession(globalState, undefined), true)
  assert.equal(eventAppliesToActiveSession(globalState, 'session-b'), false)
})
