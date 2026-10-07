#!/usr/bin/env tsx
/* eslint-disable antfu/no-top-level-await */
/**
 * Standalone runner for the model API simulator.
 *
 * Usage:
 *   pnpm tsx run.ts              # starts on random port
 *   pnpm tsx run.ts 8787         # starts on port 8787
 *
 * The server exposes:
 *   - Anthropic API at http://127.0.0.1:<port>
 *   - OpenAI API    at http://127.0.0.1:<port>/v1
 *   - Control plane at http://127.0.0.1:<port>/_simulator
 *
 * POST /_simulator/enqueue  — enqueue a scenario (JSON body)
 * GET  /_simulator/requests — view recorded requests
 * POST /_simulator/reset    — reset scenario state
 */

// Minimal control-plane server on a fixed offset port
import { serve } from 'srvx'

import { startModelApiSimulator } from './src/index'

const port = Number(process.argv[2]) || 0

const simulator = await startModelApiSimulator({
  port,
  strictRequestValidation: false, // 不校验请求体 schema，兼容任意 SDK 版本
  autoRespond: true, // Mock server 模式：没有入队场景时自动合成响应
})
const url = new URL(simulator.anthropicBaseUrl)

console.log(`\n🎯 Model API Simulator running`)
console.log(`   Anthropic base : ${simulator.anthropicBaseUrl}`)
console.log(`   OpenAI base    : ${simulator.openaiBaseUrl}`)
console.log(`   Control plane  : ${url.origin}/_simulator\n`)
console.log(`POST ${url.origin}/_simulator/enqueue  — 入队场景`)
console.log(`GET  ${url.origin}/_simulator/requests — 查看已消费的请求`)
console.log(`POST ${url.origin}/_simulator/reset    — 重置状态\n`)

const controlPort = port ? port + 1 : Number(url.port) + 1
const control = serve({
  hostname: '127.0.0.1',
  port: controlPort,
  gracefulShutdown: false,
  silent: false,
  async fetch(request: Request): Promise<Response> {
    const reqUrl = new URL(request.url)
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'content-type': 'application/json' },
      })

    try {
      if (reqUrl.pathname === '/_simulator/enqueue' && request.method === 'POST') {
        const body = await request.json()
        simulator.controller.enqueue(body)
        return json({ ok: true, message: 'Scenario enqueued' })
      }

      if (reqUrl.pathname === '/_simulator/requests' && request.method === 'GET') {
        return json({ requests: simulator.controller.requests() })
      }

      if (reqUrl.pathname === '/_simulator/reset' && request.method === 'POST') {
        simulator.controller.reset()
        return json({ ok: true, message: 'State reset' })
      }

      return json({ error: 'Not found' }, 404)
    }
 catch (error) {
      return json({ error: String(error) }, 500)
    }
  },
})

await control.ready()
const controlUrl = control.url
console.log(`🎛️  Control plane : ${controlUrl}\n`)
console.log(`Press Ctrl+C to stop.\n`)

// Keep alive
process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await simulator.close()
  await control.close(true)
  process.exit(0)
})

// Block forever
await new Promise(() => {})
