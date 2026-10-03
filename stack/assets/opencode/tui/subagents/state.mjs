export function subagentState(status, outcome, blocked = false) {
  if (blocked) return "blocked"
  if (status === "running") return "running"
  if (outcome === "succeeded") return "done"
  if (outcome === "failed") return "failed"
  if (outcome === "interrupted") return "stopped"
  return "idle"
}

export function isActiveSubagent(state) {
  return state === "running" || state === "blocked"
}

export function activeElapsed(state, startedAt, now) {
  if (!isActiveSubagent(state) || !Number.isFinite(startedAt)) return undefined
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60) % 60
  const parts = [minutes, seconds % 60].map((value) => String(value).padStart(2, "0"))
  if (seconds >= 3600) parts.unshift(String(Math.floor(seconds / 3600)).padStart(2, "0"))
  return parts.join(":")
}

export function formatTokens(tokens) {
  if (!tokens) return undefined
  const buckets = [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write]
  if (buckets.some((value) => !Number.isFinite(value) || value < 0)) return undefined
  const total = buckets.reduce((sum, value) => sum + value, 0)
  if (total >= 1000000) return `${(total / 1000000).toFixed(1)}m tok`
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k tok`
  return `${Math.round(total)} tok`
}

export function formatModel(model) {
  if (!model?.providerID || !model?.id) return undefined
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}
