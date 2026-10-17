import assert from 'node:assert/strict'
import test from 'node:test'
import { mockGoal, mockRun } from '../src/mock/run.ts'

test('events are ordered and compile results refer to the current sketch', () => {
  for (const [index, event] of mockRun.entries()) {
    assert.ok(Number.isInteger(event.attempt) && event.attempt >= 1)
    assert.ok(Number.isFinite(event.timestamp))
    if (index > 0) {
      assert.ok(event.timestamp > mockRun[index - 1].timestamp)
      const advance = event.attempt - mockRun[index - 1].attempt
      assert.ok(advance === 0 || advance === 1)
    }
    if (event.agent === 'compile' && event.type !== 'started') {
      const sketch = mockRun.slice(0, index).findLast(
        (candidate) => candidate.agent === 'coder' && candidate.type === 'output',
      )
      assert.ok(sketch)
      assert.equal(event.attempt, sketch.attempt)
      assert.deepEqual(event.content.sketch, {
        version: sketch.content.version,
        revision: sketch.content.revision,
      })
      if (event.type === 'failed') {
        for (const diagnostic of event.content.diagnostics) {
          const line = sketch.content.code.split('\n')[diagnostic.line - 1]
          assert.ok(line.slice(diagnostic.column - 1).startsWith('BUTTON_PIN'))
        }
      }
    }
  }
})

test('the repeated compiler diagnostic leads to replanning on the next attempt', () => {
  const failures = mockRun.filter((event) => event.agent === 'compile' && event.type === 'failed')
  assert.equal(failures.length, 2)
  assert.equal(failures[0].content.diagnostics[0].message, failures[1].content.diagnostics[0].message)
  assert.equal(failures[0].content.diagnostics[0].fingerprint, failures[1].content.diagnostics[0].fingerprint)
  const decision = mockRun.find((event) => event.agent === 'supervisor' && event.type === 'decision')
  assert.ok(decision)
  assert.equal(decision.content.decision, 'replan')
  assert.equal(decision.content.reason, 'same compile error twice')
  assert.deepEqual(decision.content.failedAttempts, failures.map((event) => event.attempt))
  assert.equal(decision.content.diagnosticFingerprint, failures[0].content.diagnostics[0].fingerprint)
  assert.ok(decision.timestamp > failures[1].timestamp)
  assert.equal(decision.content.nextAttempt, failures[1].attempt + 1)
})

test('simulation and final verdict cover all planned criteria and expected serial output', () => {
  const plan = mockRun.find((event) => event.agent === 'planner' && event.type === 'output')
  const scenario = mockRun.find((event) => event.agent === 'verifier' && event.type === 'output')
  const compiled = mockRun.find((event) => event.agent === 'compile' && event.type === 'passed')
  const simulation = mockRun.find((event) => event.agent === 'sim' && event.type === 'passed')
  const verdict = mockRun.at(-1)
  assert.ok(plan && scenario && compiled && simulation)
  assert.ok(verdict?.agent === 'supervisor' && verdict.type === 'passed')
  assert.equal(plan.content.goal, mockGoal)
  const criteria = plan.content.acceptanceCriteria.map((criterion) => criterion.id)
  assert.equal(new Set(criteria).size, 3)
  assert.deepEqual(scenario.content.criteria, criteria)
  assert.deepEqual(simulation.content.criteria.map((result) => result.criterionId), criteria)
  assert.ok(simulation.content.criteria.every((result) => result.status === 'passed'))
  assert.equal(simulation.content.scenario, scenario.content.name)
  assert.deepEqual(simulation.content.serialOutput, scenario.content.expectedSerialOutput)
  assert.deepEqual(simulation.content.sketch, compiled.content.sketch)
  assert.deepEqual(verdict.content.sketch, compiled.content.sketch)
  assert.deepEqual(verdict.content.criteria, criteria)
  assert.equal(verdict.content.evidence, 'mock-simulation')
  assert.ok(compiled.timestamp < simulation.timestamp && simulation.timestamp < verdict.timestamp)
})
