import { test as japaTest } from '@japa/runner'

type Cleanup = () => unknown | Promise<unknown>
type TestCallback = (context: TestContext) => unknown | Promise<unknown>

export interface TestContext {
  after(cleanup: Cleanup): void
  test(name: string, callback: TestCallback): Promise<void>
  test(name: string, options: { timeout?: number }, callback: TestCallback): Promise<void>
  diagnostic(message: string): void
  mock: {
    method<T extends object, K extends keyof T>(target: T, key: K, implementation: T[K]): {
      mock: { mockImplementation(next: T[K]): void }
    }
  }
}

const fileCleanups: Cleanup[] = []

async function runCleanups(cleanups: Cleanup[]) {
  let firstError: unknown
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError) throw firstError
}

function createContext(): TestContext {
  const cleanups: Cleanup[] = []
  const subtest: TestContext['test'] = async (_name: string, optionsOrCallback: TestCallback | { timeout?: number }, maybeCallback?: TestCallback) => {
    const callback: TestCallback | undefined = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    if (!callback) throw new TypeError('A subtest callback is required')
    const child = createContext()
    try {
      await callback(child)
    } finally {
      await runCleanups((child as TestContext & { cleanups: Cleanup[] }).cleanups)
    }
  }
  const context: TestContext = {
    after(cleanup) {
      cleanups.push(cleanup)
    },
    test: subtest,
    diagnostic(message) {
      process.stdout.write(`${message}\n`)
    },
    mock: {
      method(target, key, implementation) {
        const original = target[key]
        target[key] = implementation
        cleanups.push(() => { target[key] = original })
        return { mock: { mockImplementation(next) { target[key] = next } } }
      },
    },
  }
  Object.defineProperty(context, 'cleanups', { value: cleanups })
  return context
}

export function test(name: string, callback: TestCallback): ReturnType<typeof japaTest>
export function test(name: string, options: { timeout?: number }, callback: TestCallback): ReturnType<typeof japaTest>
export function test(name: string, optionsOrCallback: TestCallback | { timeout?: number }, maybeCallback?: TestCallback) {
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
  if (!callback) throw new TypeError('A test callback is required')
  const registered = japaTest(name, async () => {
    const context = createContext()
    try {
      await callback(context)
    } finally {
      await runCleanups((context as TestContext & { cleanups: Cleanup[] }).cleanups)
    }
  })
  if (typeof optionsOrCallback !== 'function' && optionsOrCallback.timeout) registered.timeout(optionsOrCallback.timeout)
  return registered
}

export function after(cleanup: Cleanup) {
  fileCleanups.push(cleanup)
}

export async function runFileCleanups() {
  await runCleanups(fileCleanups)
}
