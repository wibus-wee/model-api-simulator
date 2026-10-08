import grammar from '../../protocol/openai/chat-stream-grammar.json'
import type { ProtocolTrace } from '../anthropic/state-machine'
import type { JsonObject, JsonValue, StreamStep } from '../contract'
import { isJsonObject } from '../contract'
import { OpenAiProtocolError } from './state-machine'

/** Core text/function-tool profile. Wire schemas are validated independently. */
export function validateChatCompletionStream(steps: readonly StreamStep[]): ProtocolTrace {
  let terminal = false
  let identity: string | undefined
  let usageSeen = false
  const finished = new Map<number, boolean>()
  const calls = new Map<string, string>()
  const transitions = new Set<string>()
  const correlations = new Set<string>()
  const take = (id: string) => {
    if (!grammar.transitions.some(item => item.id === id)) {
      throw new OpenAiProtocolError(`Unregistered chat transition ${id}`)
    }
    transitions.add(`openai:chat:transition:${id}`)
  }
  for (const step of steps) {
    if (step.kind === 'gate' || step.kind === 'yield') { continue }
    if (step.kind === 'close') {
      if (!terminal) { throw new OpenAiProtocolError('Chat stream closed without [DONE]; use disconnect for interruption') }
      continue
    }
    if (terminal) { throw new OpenAiProtocolError('Chat event follows terminal frame') }
    if (step.kind === 'disconnect') {
      take('disconnect')
      terminal = true
    }
    else if (step.event === '[DONE]') {
      if ([...finished.values()].some(value => !value)) {
        throw new OpenAiProtocolError('[DONE] precedes choice finish_reason')
      }
      take('done')
      terminal = true
    }
    else {
      const event = record(step.event)
      if ('error' in event) {
        take('error')
        terminal = true
      }
      else {
        const current = JSON.stringify([event.id, event.created, event.model])
        identity ??= current
        if (current !== identity) { throw new OpenAiProtocolError('Chat completion identity changed') }
        correlations.add('completion-identity-stable')
        if (!Array.isArray(event.choices)) { throw new OpenAiProtocolError('Chat choices must be an array') }
        if (event.choices.length === 0) {
          if (!isJsonObject(event.usage)) { throw new OpenAiProtocolError('Core empty-choice chunk requires usage') }
          if (usageSeen || [...finished.values()].some(value => !value)) {
            throw new OpenAiProtocolError('Usage chunk must occur once after choices finish')
          }
          usageSeen = true
          take('usage')
          correlations.add('usage-after-finish')
        }
        else {
          if (usageSeen) { throw new OpenAiProtocolError('Choice follows final usage chunk') }
          const indices = new Set<number>()
          for (const rawChoice of event.choices) {
            const choice = record(rawChoice)
            const index = nonnegativeIndex(choice.index)
            if (indices.has(index)) { throw new OpenAiProtocolError('Duplicate choice index in chunk') }
            indices.add(index)
            if (finished.get(index)) { throw new OpenAiProtocolError('Delta follows finished choice') }
            finished.set(index, false)
            correlations.add('choice-index-isolated')
            const delta = record(choice.delta)
            if (delta.audio !== undefined) { throw new OpenAiProtocolError('Audio is outside the core chat stream profile') }
            take('chunk')
            if (typeof delta.content === 'string') { take('text') }
            if (typeof delta.refusal === 'string') { take('refusal') }
            if (delta.function_call !== undefined) { take('legacy-function') }
            if (Array.isArray(delta.tool_calls)) {
              const toolIndices = new Set<number>()
              for (const rawTool of delta.tool_calls) {
                const tool = record(rawTool)
                const toolIndex = nonnegativeIndex(tool.index)
                if (toolIndices.has(toolIndex)) { throw new OpenAiProtocolError('Duplicate tool index in choice delta') }
                toolIndices.add(toolIndex)
                const key = `${index}:${toolIndex}`
                if (typeof tool.id === 'string') {
                  const prior = calls.get(key)
                  if (prior !== undefined && prior !== tool.id) { throw new OpenAiProtocolError('Tool call ID changed at its choice/index') }
                  calls.set(key, tool.id)
                  correlations.add('tool-id-stable')
                }
                // Arguments are fragments and may remain invalid JSON by API contract.
                take('tool-delta')
              }
            }
            if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
              finished.set(index, true)
              take('choice-finished')
              correlations.add('finished-choice-forbids-delta')
            }
          }
        }
      }
    }
    if (terminal) { correlations.add('terminal-forbids-events') }
  }
  return { transitions: [...transitions], correlations: [...correlations], terminal }
}

function record(value: JsonValue | undefined): JsonObject {
  if (value === undefined || !isJsonObject(value)) { throw new OpenAiProtocolError('Expected chat stream object') }
  return value
}
function nonnegativeIndex(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new OpenAiProtocolError('Choice/tool index must be a nonnegative integer')
  }
  return value
}
