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
  if (typeof result.body === 'string') result.body = result.body.replaceAll('{{event}}', '{{nodes.trigger.output.event}}')
  if (result.headers && typeof result.headers === 'object' && Object.keys(result.headers).length) {
    result.headers = {}
    result.legacyHeaderMigrationRequired = true
  }
  return result
}

interface ReferenceNode { id: string; type: string; config: Record<string, unknown> }
interface ReferenceEdge { source: string; target: string }
type Descriptor = string | { readonly [key: string]: Descriptor }
interface ReferenceCatalog {
  events: readonly { type: string; output: Descriptor }[]
  nodes: readonly { type: string; outputs: Descriptor }[]
}

export function upstreamReferenceErrors(graph: { nodes: ReferenceNode[]; edges: ReferenceEdge[] }, catalog?: ReferenceCatalog): string[] {
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
  const eventOutput = catalog?.events.find((event) => event.type === trigger.config.event)?.output
  const outputById = new Map(graph.nodes.map((node) => [node.id, node.type === 'trigger'
    ? { event: eventOutput ?? {} }
    : catalog?.nodes.find((entry) => entry.type === node.type)?.outputs]))
  const validPath = (descriptor: Descriptor | undefined, path: string): boolean => {
    const parts = path ? path.split('.') : []
    if (parts.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) return false
    for (const part of parts) {
      if (descriptor === 'record' || descriptor === 'unknown') return true
      if (typeof descriptor === 'string') {
        if (!descriptor.endsWith('[]') || !/^(0|[1-9][0-9]*)$/.test(part)) return false
        descriptor = descriptor.slice(0, -2)
      } else {
        if (!descriptor || !Object.hasOwn(descriptor, part)) return false
        descriptor = descriptor[part]
      }
    }
    return descriptor !== undefined
  }
  for (const consumer of graph.nodes) {
    const references = [...JSON.stringify(consumer.config).matchAll(nodeReferencePattern)].map((match) => ({ producer: match[1]!, path: match[2] ?? '' }))
    const eventPaths = [...JSON.stringify(consumer.config).matchAll(/\{\{event\.([A-Za-z0-9_.]+)\}\}/g)].map((match) => match[1]!)
    if (consumer.type === 'condition' || consumer.type === 'switch') {
      const path = String(consumer.config.path ?? ''), match = path.match(nodePathPattern)
      if (match) references.push({ producer: match[1]!, path: match[2] ?? '' })
      else eventPaths.push(path.startsWith('event.') ? path.slice(6) : path)
    }
    for (const { producer, path } of references) {
      if (!ids.has(producer)) errors.push(`Node ${consumer.id} references unknown node ${producer}`)
      else if (!dominators.get(consumer.id)?.has(producer) || producer === consumer.id) errors.push(`Node ${consumer.id} references node ${producer}, which is not guaranteed upstream`)
      else if (catalog && !validPath(outputById.get(producer), path)) errors.push(`Node ${consumer.id} references invalid output path on node ${producer}: ${path}`)
    }
    if (catalog) for (const path of eventPaths) if (!validPath(eventOutput, path)) errors.push(`Node ${consumer.id} references invalid event path: ${path}`)
  }
  return [...new Set(errors)]
}
