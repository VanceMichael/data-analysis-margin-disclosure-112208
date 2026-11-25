#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadDataset, validateDataset } from '../src/dataset.js'
import { buildScenarioSuite, buildAttribution, buildStress } from '../src/analysis.js'

function parseArgs(argv) {
  const args = { data: 'data', out: null }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--data') args.data = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

const args = parseArgs(process.argv)
if (args.help) {
  console.log('Usage: node bin/analyze.js [--data data-dir] [--out output.json]')
  process.exit(0)
}

const data = await loadDataset(args.data)
const validation = validateDataset(data)
if (!validation.ok) {
  console.error(JSON.stringify(validation.errors, null, 2))
  process.exit(1)
}

const suite = buildScenarioSuite(data)
const output = {
  validation,
  attribution: buildAttribution(data, suite),
  stress: buildStress(data, suite),
  scenarios: suite,
}

const json = JSON.stringify(output, null, 2)
if (args.out) {
  await mkdir(path.dirname(args.out), { recursive: true })
  await writeFile(args.out, json, 'utf8')
  console.log(`Wrote ${args.out}`)
} else {
  console.log(json)
}
