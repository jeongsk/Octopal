/**
 * SmartObserver — Layer 1 of the 3-Layer Hybrid Routing Architecture
 *
 * Wraps the rule-based ConversationObserver and adds LLM-powered
 * conversation state tracking. The LLM (Sonnet via Claude CLI) is called
 * periodically in the background to maintain an accurate, rich summary
 * of the conversation — but it NEVER makes routing decisions.
 *
 * Trigger strategy (hybrid):
 *   - Every 3 messages: background refresh
 *   - 5+ min inactivity then resume: immediate refresh
 *   - forceRefresh(): called by Layer 2 when RuleRouter confidence < 0.8
 *
 * The LLM context is stored per-folder (like ConversationObserver).
 */

import os from 'os'
import { spawn } from 'child_process'
import { ConversationObserver, ObserverContext } from './observer'
import { sanitizedEnv, sanitizeError } from './security'

// ── Types ────────────────────────────────────────────────────

export interface AgentLLMContext {
  /** What the agent is working on right now */
  workingOn: string
  /** Last contribution summary */
  lastContribution: string
}

export interface LLMContext {
  /** 1-3 sentence conversation summary */
  conversationSummary: string
  /** Current topic — e.g., "MCP server security review" */
  currentTopic: string
  /** Recent topic transitions */
  topicHistory: string[]
  /** Estimated conversation phase */
  conversationPhase: string
  /** Per-agent context */
  agentContext: Record<string, AgentLLMContext>
  /** What the user likely wants right now */
  userIntent: string
  /** Unresolved discussion threads */
  openThreads: string[]
  /** When this LLM context was last refreshed */
  updatedAt: number
}

export interface SmartObserverContext {
  /** Always-current rule-based fields (cost: $0) */
  rule: ObserverContext
  /** Periodically-updated LLM-generated fields */
  llm: LLMContext | null
}

/** Message format accepted by SmartObserver.onMessage() */
export interface ObserverMessage {
  agentName: string
  text: string
  ts: number
  mentions?: string[]
}

// ── Constants ────────────────────────────────────────────────

/** How many pending messages before triggering an LLM refresh */
const REFRESH_MESSAGE_THRESHOLD = 3
/** Inactivity duration (ms) that triggers a refresh on resume */
const INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000
/** Timeout for the CLI call (ms) */
const CLI_TIMEOUT_MS = 15_000
/** Max messages to send to the LLM (to keep token usage low) */
const MAX_MESSAGES_FOR_LLM = 10

// ── Observer system prompt ───────────────────────────────────

const OBSERVER_SYSTEM_PROMPT = `You are a conversation state tracker in a group chat of AI agents.
Your ONLY job is to maintain an accurate, concise summary of what's happening.
You do NOT decide who should respond. You just track context.

Given the previous summary (if any) and new messages, produce an updated context JSON.

Output format — reply with ONLY a JSON object, nothing else:
{
  "conversationSummary": "1-3 sentence summary of the overall conversation",
  "currentTopic": "the main topic being discussed right now",
  "topicHistory": ["previous topics in order, max 5"],
  "conversationPhase": "one of: idle, planning, implementation, review, discussion, debugging",
  "agentContext": {
    "agentName": {
      "workingOn": "what this agent is currently doing",
      "lastContribution": "brief summary of their last contribution"
    }
  },
  "userIntent": "what the user seems to want right now",
  "openThreads": ["unresolved topics or pending tasks, max 5"]
}

Rules:
- Be concise. Each field should be 1-2 sentences max.
- Track topic changes accurately.
- Note when tasks are completed vs still pending.
- If an agent was asked to do something and hasn't responded, note it in openThreads.
- conversationPhase should reflect what's actually happening, not what was discussed.`

// ── SmartObserver class ──────────────────────────────────────

export class SmartObserver {
  /** The underlying rule-based observer (always sync, cost $0) */
  private ruleObserver: ConversationObserver
  /** LLM-generated context per folder */
  private llmContexts = new Map<string, LLMContext>()
  /** Messages queued for the next LLM refresh, per folder */
  private pendingMessages = new Map<string, ObserverMessage[]>()
  /** Whether a refresh is currently in-flight for a folder */
  private refreshInFlight = new Set<string>()
  /** Whether the observer is enabled (can be disabled for testing or cost control) */
  private _enabled: boolean = true

  constructor(ruleObserver?: ConversationObserver) {
    this.ruleObserver = ruleObserver || new ConversationObserver()
  }

  /** Enable/disable LLM calls (rule-based tracking always runs) */
  get enabled(): boolean { return this._enabled }
  set enabled(val: boolean) { this._enabled = val }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Process a new message. Rule-based update is always synchronous.
   * LLM refresh is triggered conditionally and runs in the background.
   *
   * Returns true if an LLM refresh was triggered.
   */
  async onMessage(folderPath: string, msg: ObserverMessage): Promise<boolean> {
    // 1. Rule-based update (always, sync, free)
    this.ruleObserver.update(folderPath, msg)

    // 2. Queue for LLM
    const queue = this.pendingMessages.get(folderPath) || []
    queue.push(msg)
    this.pendingMessages.set(folderPath, queue)

    // 3. Check if LLM refresh needed
    if (this._enabled && this.shouldRefreshLLM(folderPath)) {
      // Fire-and-forget (background), but return true so caller knows
      this.refreshLLMContext(folderPath).catch((err) => {
        console.error(`[SmartObserver] LLM refresh failed for ${folderPath}:`, err)
      })
      return true
    }

    return false
  }

  /**
   * Get the combined context (rule + LLM) for a folder.
   */
  getContext(folderPath: string): SmartObserverContext {
    return {
      rule: this.ruleObserver.getContext(folderPath),
      llm: this.llmContexts.get(folderPath) || null,
    }
  }

  /**
   * Get only the rule-based context (for backward compatibility).
   */
  getRuleContext(folderPath: string): ObserverContext {
    return this.ruleObserver.getContext(folderPath)
  }

  /**
   * Force an immediate LLM refresh. Called by Layer 2 (Router)
   * when RuleRouter confidence is too low.
   *
   * Returns the updated LLM context, or null if refresh fails/disabled.
   */
  async forceRefresh(folderPath: string): Promise<LLMContext | null> {
    if (!this._enabled) return this.llmContexts.get(folderPath) || null

    // Wait for any in-flight refresh to complete (must exceed CLI_TIMEOUT_MS)
    if (this.refreshInFlight.has(folderPath)) {
      // Poll — max 35 attempts × 500ms = 17.5s (> CLI_TIMEOUT_MS of 15s)
      for (let i = 0; i < 35; i++) {
        await sleep(500)
        if (!this.refreshInFlight.has(folderPath)) break
      }
    }

    // If there are pending messages, refresh now
    const pending = this.pendingMessages.get(folderPath) || []
    if (pending.length > 0) {
      await this.refreshLLMContext(folderPath)
    }

    return this.llmContexts.get(folderPath) || null
  }

  /**
   * Serialize the combined context to text for injection into Router prompt.
   * This replaces the raw observer.serialize() with a richer summary.
   */
  serialize(folderPath: string): string {
    const ruleText = this.ruleObserver.serialize(folderPath)
    const llm = this.llmContexts.get(folderPath)

    if (!llm) return ruleText

    const parts: string[] = []

    // LLM summary (richer, more accurate)
    parts.push(`Summary: ${llm.conversationSummary}`)
    parts.push(`Current topic: ${llm.currentTopic}`)
    if (llm.topicHistory.length > 0) {
      parts.push(`Topic history: ${llm.topicHistory.join(' → ')}`)
    }
    parts.push(`Phase: ${llm.conversationPhase}`)
    parts.push(`User intent: ${llm.userIntent}`)

    // Agent context
    const agentParts: string[] = []
    for (const [name, ctx] of Object.entries(llm.agentContext)) {
      agentParts.push(`  - ${name}: working on "${ctx.workingOn}", last: "${ctx.lastContribution}"`)
    }
    if (agentParts.length > 0) {
      parts.push(`Agent context:\n${agentParts.join('\n')}`)
    }

    // Open threads
    if (llm.openThreads.length > 0) {
      parts.push(`Open threads: ${llm.openThreads.join('; ')}`)
    }

    // Append rule-based stats (complementary)
    const ruleCtx = this.ruleObserver.getContext(folderPath)
    if (ruleCtx.lastRespondent) {
      parts.push(`Last respondent: ${ruleCtx.lastRespondent}`)
    }
    if (ruleCtx.pendingMentions.length > 0) {
      parts.push(`Pending mentions: ${ruleCtx.pendingMentions.join(', ')}`)
    }
    parts.push(`Total messages: ${ruleCtx.messageCount}`)

    return parts.join('\n')
  }

  /** Reset everything for a folder */
  reset(folderPath: string): void {
    this.ruleObserver.reset(folderPath)
    this.llmContexts.delete(folderPath)
    this.pendingMessages.delete(folderPath)
    this.refreshInFlight.delete(folderPath)
  }

  /** Get the number of pending messages (for testing / monitoring) */
  getPendingCount(folderPath: string): number {
    return (this.pendingMessages.get(folderPath) || []).length
  }

  /** Check if a refresh is currently in-flight */
  isRefreshing(folderPath: string): boolean {
    return this.refreshInFlight.has(folderPath)
  }

  // ── Internal logic ─────────────────────────────────────────

  /** Determine if an LLM refresh should be triggered */
  shouldRefreshLLM(folderPath: string): boolean {
    if (this.refreshInFlight.has(folderPath)) return false

    const pending = this.pendingMessages.get(folderPath) || []

    // Condition 1: Enough pending messages
    if (pending.length >= REFRESH_MESSAGE_THRESHOLD) return true

    // Condition 2: Inactivity gap then resume
    const llm = this.llmContexts.get(folderPath)
    if (llm && pending.length > 0) {
      const gap = Date.now() - llm.updatedAt
      if (gap > INACTIVITY_THRESHOLD_MS) return true
    }

    // Condition 3: First-ever message (no LLM context yet) and enough data
    if (!llm && pending.length >= REFRESH_MESSAGE_THRESHOLD) return true

    return false
  }

  /** Call Claude CLI to generate updated LLM context */
  async refreshLLMContext(folderPath: string): Promise<void> {
    if (this.refreshInFlight.has(folderPath)) return

    const pending = this.pendingMessages.get(folderPath) || []
    if (pending.length === 0) return

    this.refreshInFlight.add(folderPath)
    try {
      const currentLLM = this.llmContexts.get(folderPath) ?? null
      const updated = await this.callLLM(currentLLM, pending.slice(-MAX_MESSAGES_FOR_LLM))
      if (updated) {
        this.llmContexts.set(folderPath, updated)
      }
      this.pendingMessages.set(folderPath, [])
    } finally {
      this.refreshInFlight.delete(folderPath)
    }
  }

  /** Call Claude CLI (sonnet) to produce updated context */
  private async callLLM(
    previousContext: LLMContext | null,
    messages: ObserverMessage[]
  ): Promise<LLMContext | null> {
    const previousSection = previousContext
      ? `Previous context summary:\n${JSON.stringify(previousContext, null, 2)}\n\n`
      : ''

    const messageLines = messages
      .map((m) => `[${m.agentName}]: ${m.text.slice(0, 500)}`)
      .join('\n')

    const userPrompt = `${previousSection}New messages:\n${messageLines}\n\nProduce the updated context JSON.`

    const claudeArgs = [
      '-p',
      '--print',
      '--mcp-config', '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--system-prompt', OBSERVER_SYSTEM_PROMPT,
      '--', userPrompt,
    ]

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', claudeArgs, {
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedEnv(),
      })

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('SmartObserver CLI timeout'))
      }, CLI_TIMEOUT_MS)

      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(stderr || `exited with ${code}`))
        else resolve(stdout.trim())
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    return this.parseLLMOutput(output)
  }

  /** Parse the LLM JSON output into LLMContext, with fallback */
  private parseLLMOutput(output: string): LLMContext | null {
    const jsonMatch = output.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    try {
      const parsed = JSON.parse(jsonMatch[0])

      return {
        conversationSummary: String(parsed.conversationSummary || ''),
        currentTopic: String(parsed.currentTopic || ''),
        topicHistory: Array.isArray(parsed.topicHistory)
          ? parsed.topicHistory.map(String).slice(0, 5)
          : [],
        conversationPhase: String(parsed.conversationPhase || 'discussion'),
        agentContext: this.parseAgentContext(parsed.agentContext),
        userIntent: String(parsed.userIntent || ''),
        openThreads: Array.isArray(parsed.openThreads)
          ? parsed.openThreads.map(String).slice(0, 5)
          : [],
        updatedAt: Date.now(),
      }
    } catch {
      console.error('[SmartObserver] Failed to parse LLM output:', output.slice(0, 200))
      return null
    }
  }

  /** Safely parse agentContext from LLM output */
  private parseAgentContext(raw: unknown): Record<string, AgentLLMContext> {
    if (!raw || typeof raw !== 'object') return {}

    const result: Record<string, AgentLLMContext> = {}
    for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val && typeof val === 'object') {
        const v = val as Record<string, unknown>
        result[name] = {
          workingOn: String(v.workingOn || ''),
          lastContribution: String(v.lastContribution || ''),
        }
      }
    }
    return result
  }
}

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Singleton instance */
export const smartObserver = new SmartObserver()
