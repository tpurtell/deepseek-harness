import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { childSessionMeta, resolveChildAgentOptions, resolveChildDepth } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits a detached remote workspace identity and parent ownership', () => {
    const base = parentAgent()
    const workspace = { kind: 'cuteafd-ssh' as const, host: 'rhea', path: '/workspace' }
    const parent = { ...base, ctx: new Context(), session: Session.create(base.id, [], { version: SESSION_FORMAT_VERSION, id: base.id, createdAt: 1, isSeeded: false, cwd: workspace.path, cuteafd_workspace: workspace }) } as Agent
    const meta = childSessionMeta(parent, 1, false)
    expect(meta).toMatchObject({ cwd: '/workspace', cuteafd_workspace: workspace, parentSession: parent.id, origin: 'subagent' })
    expect(meta.cuteafd_workspace).not.toBe(parent.session.header.cuteafd_workspace)
  })
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('delegation depth limits', () => {
  it.each([-1, -0, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid runtime depth %s', (depth) => {
    const parent = parentAgent()
    parent.options.subagentDepth = depth
    expect(() => resolveChildDepth(parent, undefined)).toThrow('agent subagentDepth must be a non-negative safe integer')
  })

  it('rejects a child depth beyond the exact integer range', () => {
    const parent = parentAgent()
    parent.options.subagentDepth = Number.MAX_SAFE_INTEGER
    expect(() => resolveChildDepth(parent, undefined)).toThrow('subagent child depth exceeds the safe-integer range')
  })
})
