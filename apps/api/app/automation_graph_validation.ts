export const nodeReferencePattern = /\{\{nodes\.([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_.-]+))?\}\}/g
export const nodePathPattern = /^nodes\.([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_.-]+))?$/

export function remediateLegacyConfig(config: unknown, nodeIds: string[], types: string[]): Record<string, unknown> {
  const translate = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/\{\{steps\.(\d+)\.output\}\}/g, (original, raw: string) => {
      const index = Number(raw) - 1, id = nodeIds[index]
      if (!id) return original
      const field = types[index] === 'log' ? 'message' : types[index] === 'email' ? 'messageId' : 'body'
      return `{{nodes.${id}.output.${field}}}`
    })
    if (Array.isArray(value)) return value.map(translate)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translate(entry)]))
    return value
  }
  const result = translate(config) as Record<string, unknown>
  if (result.headers && typeof result.headers === 'object' && Object.keys(result.headers).length) {
    result.headers = {}
    result.legacyHeaderMigrationRequired = true
  }
  return result
}

interface ReferenceNode { id: string; type: string; config: Record<string, unknown> }
interface ReferenceEdge { source: string; target: string }

export function upstreamReferenceErrors(graph: { nodes: ReferenceNode[]; edges: ReferenceEdge[] }): string[] {
  const trigger = graph.nodes.find((node) => node.type === 'trigger')
  if (!trigger) return []
  const ids = new Set(graph.nodes.map((node) => node.id)), incoming = new Map<string, ReferenceEdge[]>()
  for (const edge of graph.edges) incoming.set(edge.target, [...incoming.get(edge.target) ?? [], edge])
  const dominators = new Map<string, Set<string>>([[trigger.id, new Set([trigger.id])]])
  const unresolved = new Set([...ids].filter((id) => id !== trigger.id))
  while (unresolved.size) {
    let changed = false
    for (const id of unresolved) {
      const predecessors = (incoming.get(id) ?? []).map((edge) => edge.source)
      if (!predecessors.length || predecessors.some((source) => !dominators.has(source))) continue
      const intersection = new Set(dominators.get(predecessors[0]!)!)
      for (const source of predecessors.slice(1)) for (const candidate of intersection) if (!dominators.get(source)!.has(candidate)) intersection.delete(candidate)
      intersection.add(id); dominators.set(id, intersection); unresolved.delete(id); changed = true
    }
    if (!changed) break
  }
  const errors: string[] = []
  for (const consumer of graph.nodes) {
    const references = [...JSON.stringify(consumer.config).matchAll(nodeReferencePattern)].map((match) => match[1]!)
    if (consumer.type === 'condition' || consumer.type === 'switch') { const match = String(consumer.config.path ?? '').match(nodePathPattern); if (match) references.push(match[1]!) }
    for (const producer of references) {
      if (!ids.has(producer)) errors.push(`Node ${consumer.id} references unknown node ${producer}`)
      else if (!dominators.get(consumer.id)?.has(producer) || producer === consumer.id) errors.push(`Node ${consumer.id} references node ${producer}, which is not guaranteed upstream`)
    }
  }
  return [...new Set(errors)]
}
