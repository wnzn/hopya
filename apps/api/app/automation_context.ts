import { AsyncLocalStorage } from 'node:async_hooks'

export interface AutomationCausation { depth: number; automationIds: string[] }
export const automationContext = new AsyncLocalStorage<AutomationCausation>()
