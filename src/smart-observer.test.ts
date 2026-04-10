import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SmartObserver, LLMContext, ObserverMessage } from './smart-observer'
import { ConversationObserver } from './observer'

// Mock child_process.spawn to avoid real CLI calls in tests
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}))

// We'll control spawn behavior per-test
import { spawn } from 'child_process'
const mockSpawn = vi.mocked(spawn)

function createMockProcess(stdout: string, exitCode = 0) {
  const stdoutCallbacks: Array<(data: Buffer) => void> = []
  const stderrCallbacks: Array<(data: Buffer) => void> = []
  const closeCallbacks: Array<(code: number) => void> = []

  const proc = {
    stdout: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutCallbacks.push(cb)
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stderrCallbacks.push(cb)
      }),
    },
    on: vi.fn((event: string, cb: any) => {
      if (event === 'close') closeCallbacks.push(cb)
    }),
    kill: vi.fn(),
  }

  // Schedule data emission + close
  setTimeout(() => {
    for (const cb of stdoutCallbacks) cb(Buffer.from(stdout))
    for (const cb of closeCallbacks) cb(exitCode)
  }, 10)

  return proc as any
}

function msg(agentName: string, text: string, ts?: number): ObserverMessage {
  return { agentName, text, ts: ts ?? Date.now() }
}

const sampleLLMOutput: LLMContext = {
  conversationSummary: 'Discussing token tracking implementation',
  currentTopic: 'token usage',
  topicHistory: ['project setup', 'token usage'],
  conversationPhase: 'implementation',
  agentContext: {
    developer: {
      workingOn: 'implementing token badges',
      lastContribution: 'added TokenUsageBadge component',
    },
  },
  userIntent: 'wants token tracking feature',
  openThreads: ['cost estimation accuracy'],
  updatedAt: 0,
}

describe('SmartObserver', () => {
  let so: SmartObserver
  let ruleObserver: ConversationObserver
  const folder = '/test/project'

  beforeEach(() => {
    vi.useFakeTimers()
    ruleObserver = new ConversationObserver()
    so = new SmartObserver(ruleObserver)
    mockSpawn.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Rule-based tracking (always works, no LLM) ─────────────

  describe('rule-based tracking', () => {
    it('delegates to ConversationObserver for every message', async () => {
      so.enabled = false // no LLM
      await so.onMessage(folder, msg('user', 'hello'))
      await so.onMessage(folder, msg('developer', 'hi there'))

      const ctx = so.getContext(folder)
      expect(ctx.rule.messageCount).toBe(2)
      expect(ctx.rule.lastRespondent).toBe('developer')
      expect(ctx.llm).toBeNull()
    })

    it('getRuleContext returns just the rule context', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'write tests'))

      const rule = so.getRuleContext(folder)
      expect(rule.messageCount).toBe(1)
      expect(rule.currentTopic).toBe('testing')
    })

    it('isolates contexts per folder', async () => {
      so.enabled = false
      await so.onMessage('/folder-a', msg('user', 'hello'))
      await so.onMessage('/folder-a', msg('developer', 'hi'))
      await so.onMessage('/folder-b', msg('user', 'bye'))

      expect(so.getContext('/folder-a').rule.messageCount).toBe(2)
      expect(so.getContext('/folder-b').rule.messageCount).toBe(1)
    })
  })

  // ── LLM refresh trigger conditions ─────────────────────────

  describe('shouldRefreshLLM', () => {
    it('returns false when no pending messages', () => {
      expect(so.shouldRefreshLLM(folder)).toBe(false)
    })

    it('returns false when pending < threshold', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'msg1'))
      await so.onMessage(folder, msg('developer', 'msg2'))
      expect(so.getPendingCount(folder)).toBe(2)
      expect(so.shouldRefreshLLM(folder)).toBe(false)
    })

    it('returns true when pending >= 3 (threshold)', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'msg1'))
      await so.onMessage(folder, msg('developer', 'msg2'))
      await so.onMessage(folder, msg('user', 'msg3'))
      expect(so.shouldRefreshLLM(folder)).toBe(true)
    })

    it('returns true on inactivity gap (>5min) then resume', async () => {
      so.enabled = false

      // Simulate existing LLM context that's old
      const oldContext: LLMContext = {
        ...sampleLLMOutput,
        updatedAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      }
      // Inject via internal map (testing-only hack)
      ;(so as any).llmContexts.set(folder, oldContext)

      // Add just 1 pending message
      await so.onMessage(folder, msg('user', 'hello'))
      expect(so.getPendingCount(folder)).toBe(1)
      expect(so.shouldRefreshLLM(folder)).toBe(true)
    })

    it('returns false when refresh is already in-flight', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'a'))
      await so.onMessage(folder, msg('user', 'b'))
      await so.onMessage(folder, msg('user', 'c'))

      // Simulate in-flight
      ;(so as any).refreshInFlight.add(folder)
      expect(so.shouldRefreshLLM(folder)).toBe(false)
    })
  })

  // ── onMessage LLM trigger ──────────────────────────────────

  describe('onMessage LLM trigger', () => {
    it('does not trigger LLM when disabled', async () => {
      so.enabled = false
      for (let i = 0; i < 5; i++) {
        const triggered = await so.onMessage(folder, msg('user', `msg${i}`))
        expect(triggered).toBe(false)
      }
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('triggers LLM after 3 messages', async () => {
      mockSpawn.mockReturnValue(createMockProcess(JSON.stringify(sampleLLMOutput)))

      const r1 = await so.onMessage(folder, msg('user', 'msg1'))
      const r2 = await so.onMessage(folder, msg('developer', 'msg2'))
      expect(r1).toBe(false)
      expect(r2).toBe(false)

      const r3 = await so.onMessage(folder, msg('user', 'msg3'))
      expect(r3).toBe(true) // triggered!
    })
  })

  // ── LLM context parsing ────────────────────────────────────

  describe('parseLLMOutput', () => {
    it('parses valid JSON output', () => {
      const result = (so as any).parseLLMOutput(JSON.stringify(sampleLLMOutput))
      expect(result).not.toBeNull()
      expect(result!.conversationSummary).toBe('Discussing token tracking implementation')
      expect(result!.currentTopic).toBe('token usage')
      expect(result!.agentContext.developer.workingOn).toBe('implementing token badges')
      expect(result!.updatedAt).toBeGreaterThan(0)
    })

    it('handles JSON wrapped in markdown code block', () => {
      const wrapped = '```json\n' + JSON.stringify(sampleLLMOutput) + '\n```'
      const result = (so as any).parseLLMOutput(wrapped)
      expect(result).not.toBeNull()
      expect(result!.currentTopic).toBe('token usage')
    })

    it('returns null for non-JSON output', () => {
      const result = (so as any).parseLLMOutput('I cannot help with that.')
      expect(result).toBeNull()
    })

    it('handles missing optional fields gracefully', () => {
      const minimal = JSON.stringify({
        conversationSummary: 'minimal',
        currentTopic: 'test',
      })
      const result = (so as any).parseLLMOutput(minimal)
      expect(result).not.toBeNull()
      expect(result!.conversationSummary).toBe('minimal')
      expect(result!.topicHistory).toEqual([])
      expect(result!.openThreads).toEqual([])
      expect(result!.agentContext).toEqual({})
    })

    it('caps topicHistory at 5 items', () => {
      const output = JSON.stringify({
        ...sampleLLMOutput,
        topicHistory: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      })
      const result = (so as any).parseLLMOutput(output)
      expect(result!.topicHistory).toHaveLength(5)
    })
  })

  // ── serialize ──────────────────────────────────────────────

  describe('serialize', () => {
    it('returns rule-only text when no LLM context', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'write tests'))
      await so.onMessage(folder, msg('tester', 'on it'))

      const text = so.serialize(folder)
      expect(text).toContain('testing')
      expect(text).toContain('tester')
      expect(text).not.toContain('Summary:')
    })

    it('returns rich text when LLM context exists', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'write tests'))
      await so.onMessage(folder, msg('tester', 'on it'))

      // Inject LLM context
      ;(so as any).llmContexts.set(folder, sampleLLMOutput)

      const text = so.serialize(folder)
      expect(text).toContain('Summary: Discussing token tracking implementation')
      expect(text).toContain('Current topic: token usage')
      expect(text).toContain('Phase: implementation')
      expect(text).toContain('User intent: wants token tracking feature')
      expect(text).toContain('developer')
      expect(text).toContain('implementing token badges')
      expect(text).toContain('Open threads: cost estimation accuracy')
      expect(text).toContain('Total messages: 2')
    })
  })

  // ── forceRefresh ───────────────────────────────────────────

  describe('forceRefresh', () => {
    it('returns null when disabled', async () => {
      so.enabled = false
      const result = await so.forceRefresh(folder)
      expect(result).toBeNull()
    })

    it('returns existing LLM context when disabled but context exists', async () => {
      ;(so as any).llmContexts.set(folder, sampleLLMOutput)
      so.enabled = false
      const result = await so.forceRefresh(folder)
      expect(result).toBe(sampleLLMOutput)
    })

    it('triggers refresh when there are pending messages', async () => {
      vi.useRealTimers() // need real timers for spawn callback

      const freshRuleObserver = new ConversationObserver()
      const freshSo = new SmartObserver(freshRuleObserver)
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'hello'))
      freshSo.enabled = true

      mockSpawn.mockReturnValue(createMockProcess(JSON.stringify(sampleLLMOutput)))

      const result = await freshSo.forceRefresh(folder)
      expect(result).not.toBeNull()
      expect(result!.currentTopic).toBe('token usage')
      expect(freshSo.getPendingCount(folder)).toBe(0)
    })

    it('skips refresh when no pending messages', async () => {
      so.enabled = true
      const result = await so.forceRefresh(folder)
      expect(result).toBeNull()
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })

  // ── reset ──────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all state for a folder', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'hello'))
      ;(so as any).llmContexts.set(folder, sampleLLMOutput)

      so.reset(folder)

      expect(so.getContext(folder).rule.messageCount).toBe(0)
      expect(so.getContext(folder).llm).toBeNull()
      expect(so.getPendingCount(folder)).toBe(0)
      expect(so.isRefreshing(folder)).toBe(false)
    })
  })

  // ── Concurrency limit ──────────────────────────────────────

  describe('global concurrency limit (MAX_CONCURRENT_CLI = 2)', () => {
    it('shouldRefreshLLM returns false when activeCLICount >= 2', async () => {
      so.enabled = false
      // Queue enough messages to trigger
      await so.onMessage(folder, msg('user', 'a'))
      await so.onMessage(folder, msg('user', 'b'))
      await so.onMessage(folder, msg('user', 'c'))

      // Simulate 2 active CLI processes
      ;(so as any).activeCLICount = 2
      expect(so.shouldRefreshLLM(folder)).toBe(false)
    })

    it('shouldRefreshLLM returns true when activeCLICount < 2', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'a'))
      await so.onMessage(folder, msg('user', 'b'))
      await so.onMessage(folder, msg('user', 'c'))

      ;(so as any).activeCLICount = 1
      expect(so.shouldRefreshLLM(folder)).toBe(true)
    })

    it('activeCLICount increments on refresh start and decrements on success', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      await freshSo.onMessage(folder, msg('user', 'b'))
      await freshSo.onMessage(folder, msg('user', 'c'))
      freshSo.enabled = true

      expect((freshSo as any).activeCLICount).toBe(0)

      mockSpawn.mockReturnValue(createMockProcess(JSON.stringify(sampleLLMOutput)))
      await freshSo.refreshLLMContext(folder)

      // After completion, count should be back to 0
      expect((freshSo as any).activeCLICount).toBe(0)
    })

    it('activeCLICount decrements even on failure', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      freshSo.enabled = true

      mockSpawn.mockReturnValue(createMockProcess('', 1)) // exit code 1 = failure

      await expect(freshSo.refreshLLMContext(folder)).rejects.toThrow()
      expect((freshSo as any).activeCLICount).toBe(0)
    })

    it('blocks third concurrent refresh across different folders', async () => {
      so.enabled = false
      const folders = ['/folder-a', '/folder-b', '/folder-c']
      for (const f of folders) {
        await so.onMessage(f, msg('user', 'a'))
        await so.onMessage(f, msg('user', 'b'))
        await so.onMessage(f, msg('user', 'c'))
      }

      // Simulate 2 in-flight
      ;(so as any).activeCLICount = 2

      // Third folder should be blocked by concurrency, not by in-flight
      expect(so.shouldRefreshLLM('/folder-c')).toBe(false)
    })
  })

  // ── Exponential backoff ───────────────────────────────────

  describe('exponential backoff', () => {
    it('sets 30s cooldown after first failure', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      freshSo.enabled = true

      mockSpawn.mockReturnValue(createMockProcess('', 1))

      const before = Date.now()
      await expect(freshSo.refreshLLMContext(folder)).rejects.toThrow()

      const cooldown = (freshSo as any).cooldownUntil.get(folder)
      expect(cooldown).toBeDefined()
      // 30s backoff (BACKOFF_BASE_MS * 2^0 = 30000)
      expect(cooldown).toBeGreaterThanOrEqual(before + 29_000)
      expect(cooldown).toBeLessThanOrEqual(before + 31_000)
      expect((freshSo as any).failCounts.get(folder)).toBe(1)
    })

    it('sets 60s cooldown after second failure', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      freshSo.enabled = true

      // Pre-set 1 previous failure
      ;(freshSo as any).failCounts.set(folder, 1)
      ;(freshSo as any).cooldownUntil.set(folder, 0) // expired cooldown

      mockSpawn.mockReturnValue(createMockProcess('', 1))

      const before = Date.now()
      await expect(freshSo.refreshLLMContext(folder)).rejects.toThrow()

      const cooldown = (freshSo as any).cooldownUntil.get(folder)
      // 60s backoff (BACKOFF_BASE_MS * 2^1 = 60000)
      expect(cooldown).toBeGreaterThanOrEqual(before + 59_000)
      expect(cooldown).toBeLessThanOrEqual(before + 61_000)
      expect((freshSo as any).failCounts.get(folder)).toBe(2)
    })

    it('shouldRefreshLLM returns false during cooldown period', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'a'))
      await so.onMessage(folder, msg('user', 'b'))
      await so.onMessage(folder, msg('user', 'c'))

      // Set a cooldown that hasn't expired yet
      ;(so as any).cooldownUntil.set(folder, Date.now() + 60_000)

      expect(so.shouldRefreshLLM(folder)).toBe(false)
    })

    it('shouldRefreshLLM returns true after cooldown expires', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'a'))
      await so.onMessage(folder, msg('user', 'b'))
      await so.onMessage(folder, msg('user', 'c'))

      // Set a cooldown that already expired
      ;(so as any).cooldownUntil.set(folder, Date.now() - 1000)

      expect(so.shouldRefreshLLM(folder)).toBe(true)
    })
  })

  // ── Circuit breaker ───────────────────────────────────────

  describe('circuit breaker (3 consecutive failures → 5min cooldown)', () => {
    it('trips after 3 consecutive failures with 5-minute cooldown', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      freshSo.enabled = true

      // Pre-set 2 previous failures (next will be #3 = threshold)
      ;(freshSo as any).failCounts.set(folder, 2)
      ;(freshSo as any).cooldownUntil.set(folder, 0)

      mockSpawn.mockReturnValue(createMockProcess('', 1))

      const before = Date.now()
      await expect(freshSo.refreshLLMContext(folder)).rejects.toThrow()

      const cooldown = (freshSo as any).cooldownUntil.get(folder)
      // Circuit breaker: 5-minute cooldown (300_000ms)
      expect(cooldown).toBeGreaterThanOrEqual(before + 299_000)
      expect(cooldown).toBeLessThanOrEqual(before + 301_000)
      expect((freshSo as any).failCounts.get(folder)).toBe(3)
    })

    it('blocks refresh for full 5-minute circuit breaker duration', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'a'))
      await so.onMessage(folder, msg('user', 'b'))
      await so.onMessage(folder, msg('user', 'c'))

      // Simulate circuit breaker tripped — 5min cooldown from now
      ;(so as any).cooldownUntil.set(folder, Date.now() + 5 * 60 * 1000)
      ;(so as any).failCounts.set(folder, 3)

      expect(so.shouldRefreshLLM(folder)).toBe(false)

      // Advance time past the cooldown
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
      expect(so.shouldRefreshLLM(folder)).toBe(true)
    })

    it('resets failure tracking on success', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      freshSo.enabled = true

      // Pre-set some failures
      ;(freshSo as any).failCounts.set(folder, 2)
      ;(freshSo as any).cooldownUntil.set(folder, 0)

      mockSpawn.mockReturnValue(createMockProcess(JSON.stringify(sampleLLMOutput)))
      await freshSo.refreshLLMContext(folder)

      // Success should clear failure tracking
      expect((freshSo as any).failCounts.has(folder)).toBe(false)
      expect((freshSo as any).cooldownUntil.has(folder)).toBe(false)
    })

    it('does not trip at 2 failures (below threshold)', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      freshSo.enabled = true

      // Pre-set 1 previous failure
      ;(freshSo as any).failCounts.set(folder, 1)
      ;(freshSo as any).cooldownUntil.set(folder, 0)

      mockSpawn.mockReturnValue(createMockProcess('', 1))

      const before = Date.now()
      await expect(freshSo.refreshLLMContext(folder)).rejects.toThrow()

      const cooldown = (freshSo as any).cooldownUntil.get(folder)
      // Should be 60s backoff, NOT 5-minute circuit breaker
      expect(cooldown).toBeLessThan(before + 120_000)
      expect((freshSo as any).failCounts.get(folder)).toBe(2)
    })

    it('isolates failure tracking per folder', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage('/folder-a', msg('user', 'a'))
      await freshSo.onMessage('/folder-b', msg('user', 'a'))
      freshSo.enabled = true

      // Trip circuit breaker for folder-a only
      ;(freshSo as any).failCounts.set('/folder-a', 3)
      ;(freshSo as any).cooldownUntil.set('/folder-a', Date.now() + 300_000)

      // folder-b should be unaffected
      expect((freshSo as any).failCounts.has('/folder-b')).toBe(false)
      expect((freshSo as any).cooldownUntil.has('/folder-b')).toBe(false)
    })
  })

  // ── Reset clears backoff/circuit breaker state ────────────

  describe('reset clears backoff and circuit breaker state', () => {
    it('clears failCounts and cooldownUntil on reset', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', 'hello'))
      ;(so as any).llmContexts.set(folder, sampleLLMOutput)
      ;(so as any).failCounts.set(folder, 3)
      ;(so as any).cooldownUntil.set(folder, Date.now() + 300_000)

      so.reset(folder)

      expect((so as any).failCounts.has(folder)).toBe(false)
      expect((so as any).cooldownUntil.has(folder)).toBe(false)
      expect(so.getContext(folder).rule.messageCount).toBe(0)
      expect(so.getContext(folder).llm).toBeNull()
    })

    it('reset for one folder does not affect another', async () => {
      so.enabled = false
      await so.onMessage('/folder-a', msg('user', 'a'))
      await so.onMessage('/folder-b', msg('user', 'b'))
      ;(so as any).failCounts.set('/folder-a', 2)
      ;(so as any).failCounts.set('/folder-b', 1)
      ;(so as any).cooldownUntil.set('/folder-a', Date.now() + 60_000)
      ;(so as any).cooldownUntil.set('/folder-b', Date.now() + 30_000)

      so.reset('/folder-a')

      expect((so as any).failCounts.has('/folder-a')).toBe(false)
      expect((so as any).failCounts.get('/folder-b')).toBe(1)
      expect((so as any).cooldownUntil.has('/folder-a')).toBe(false)
      expect((so as any).cooldownUntil.has('/folder-b')).toBe(true)
    })
  })

  // ── Timeout ───────────────────────────────────────────────

  describe('CLI timeout (25s)', () => {
    it('kills process and rejects on timeout', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      freshSo.enabled = true

      // Create a process that never completes (no setTimeout callback)
      const hangingProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      }
      mockSpawn.mockReturnValue(hangingProc as any)

      const promise = freshSo.refreshLLMContext(folder)
      await expect(promise).rejects.toThrow(/timeout/i)
      expect(hangingProc.kill).toHaveBeenCalledWith('SIGTERM')
    }, 30_000)

    it('timeout error message includes active CLI count', async () => {
      vi.useRealTimers()
      const freshSo = new SmartObserver(new ConversationObserver())
      freshSo.enabled = false
      await freshSo.onMessage(folder, msg('user', 'a'))
      freshSo.enabled = true

      const hangingProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      }
      mockSpawn.mockReturnValue(hangingProc as any)

      try {
        await freshSo.refreshLLMContext(folder)
      } catch (err: any) {
        expect(err.message).toContain('active:')
        expect(err.message).toContain('/2')
      }
    }, 30_000)
  })

  // ── Edge cases ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty messages gracefully', async () => {
      so.enabled = false
      await so.onMessage(folder, msg('user', ''))
      expect(so.getContext(folder).rule.messageCount).toBe(1)
    })

    it('parseAgentContext handles invalid input', () => {
      expect((so as any).parseAgentContext(null)).toEqual({})
      expect((so as any).parseAgentContext('string')).toEqual({})
      expect((so as any).parseAgentContext(42)).toEqual({})
    })

    it('parseAgentContext handles nested invalid values', () => {
      const result = (so as any).parseAgentContext({
        agent1: { workingOn: 'stuff' },
        agent2: 'not an object',
        agent3: null,
      })
      expect(result.agent1.workingOn).toBe('stuff')
      expect(result.agent2).toBeUndefined()
      expect(result.agent3).toBeUndefined()
    })
  })
})
