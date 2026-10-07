import { rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true })
execFileSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' })
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true })
