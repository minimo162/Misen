export interface PrepareRuntimeOptions {
  output: string
  nodeRuntime: string
}

export function prepareRuntime(options: PrepareRuntimeOptions): Promise<{
  target: string
  manifest: Record<string, unknown>
}>
