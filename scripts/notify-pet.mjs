#!/usr/bin/env node
/**
 * Push a desktop notification into a running pet through its local notify
 * endpoint (the `notifier` plugin). Any external process — the main DeepSeek
 * Harness host, a harness-host plugin, or a user script — can use this to make
 * the pet pop a notification; clicking it focuses the pet or opens `jumpUrl`.
 *
 * Usage:
 *   node scripts/notify-pet.mjs "标题" "内容"
 *   node scripts/notify-pet.mjs "需要审批" "bash 工具请求执行" "http://localhost:PORT/session/..."
 *   node scripts/notify-pet.mjs --port 17890 "标题" "内容"
 *
 * The port defaults to the `.desktop-pet-notify-port` file written by the pet
 * in its working directory, then to 17890.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const portArgIndex = args.indexOf('--port')
let port = 17890
if (portArgIndex !== -1 && args[portArgIndex + 1] !== undefined) {
  port = Number(args[portArgIndex + 1])
  args.splice(portArgIndex, 2)
} else {
  const portFile = resolve(process.cwd(), '.desktop-pet-notify-port')
  if (existsSync(portFile)) {
    const parsed = Number(readFileSync(portFile, 'utf8').trim())
    if (Number.isFinite(parsed)) port = parsed
  }
}
const [title, body, jumpUrl] = args

if (title === undefined) {
  console.error('usage: node scripts/notify-pet.mjs [--port N] "title" "body" ["jumpUrl"]')
  process.exit(2)
}

const payload = { title, body: body ?? '', ...jumpUrl !== undefined ? { jumpUrl } : {} }
const response = await fetch(`http://127.0.0.1:${port}/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
if (!response.ok) {
  console.error(`notify failed: HTTP ${response.status} ${await response.text()}`)
  process.exit(1)
}
console.log(`notified: ${title}`)
