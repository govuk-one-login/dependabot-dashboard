import { describe, it, expect } from 'vitest'
import { createActionState } from './dependabot'

describe('createActionState', () => {
  it('returns a fresh action state with all default values', () => {
    const state = createActionState()

    expect(state.approving).toBe(false)
    expect(state.approved).toBe(false)
    expect(state.merging).toBe(false)
    expect(state.merged).toBe(false)
    expect(state.mergeError).toBeNull()
    expect(state.fixing).toBe(false)
    expect(state.fixed).toBe(false)
    expect(state.fixLog).toEqual([])
    expect(state.fixSummary).toBe('')
    expect(state.pendingJobId).toBeNull()
    expect(state.fixDiff).toBe('')
    expect(state.pushing).toBe(false)
    expect(state.discarded).toBe(false)
    expect(state.deleting).toBe(false)
    expect(state.deleted).toBe(false)
    expect(state.recreating).toBe(false)
    expect(state.recreated).toBe(false)
    expect(state.slackCopied).toBe(false)
    expect(state.extraInstructions).toBe('')
    expect(state.showInstructionsInput).toBe(false)
  })

  it('returns independent instances', () => {
    const state1 = createActionState()
    const state2 = createActionState()
    state1.fixing = true
    expect(state2.fixing).toBe(false)
  })
})
