// Shared types for multi-source comparison analytics.

export interface SourceBreakdown {
  source: string
  inputTokens: number
  outputTokens: number
  cost: number
  requestCount: number
}

export interface SourceTrendPoint {
  date: string
  [key: string]: string | number // date + dynamic source fields like claude_inputTokens, codex_cost, etc.
}

export interface UserSourceUsage {
  userId: string
  userName: string
  [key: string]: string | number // userId, userName + dynamic source fields
}
