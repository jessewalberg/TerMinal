import type { AgentRun } from '../../lib/types'

type Outputs = Record<string, string>

export function seedRunOutput(outputs: Outputs, run: Pick<AgentRun, 'id' | 'output'>): Outputs {
  if (outputs[run.id] !== undefined) return outputs
  return { ...outputs, [run.id]: run.output }
}

export function seedRunOutputs(outputs: Outputs, runs: Array<Pick<AgentRun, 'id' | 'output'>>): Outputs {
  let next = outputs
  for (const run of runs) next = seedRunOutput(next, run)
  return next
}
