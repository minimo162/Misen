export interface PrepareRuntimeOptions {
  output: string
  sourceSha: string
  packagingSha: string
}

export function prepareRuntime(options: PrepareRuntimeOptions): Promise<{
  target: string
  manifest: Record<string, unknown>
}>
