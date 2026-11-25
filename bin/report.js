#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadDataset, validateDataset } from '../src/dataset.js'
import { buildReportBundle, renderMarkdown } from '../src/report.js'

function parseArgs(argv) {
  const args = { data: 'data', out: 'reports/generated' }
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
  console.log('Usage: node bin/report.js [--data data-dir] [--out reports/generated]')
  process.exit(0)
}

const data = await loadDataset(args.data)
const validation = validateDataset(data)
if (!validation.ok) {
  console.error(JSON.stringify(validation.errors, null, 2))
  process.exit(1)
}

const bundle = buildReportBundle(data)
await mkdir(args.out, { recursive: true })
await mkdir(path.join(args.out, 'messages'), { recursive: true })
await mkdir(path.join(args.out, 'internal'), { recursive: true })

await writeFile(path.join(args.out, 'outbox.json'), JSON.stringify(bundle.sentLedger, null, 2), 'utf8')
await writeFile(
  path.join(args.out, 'report-ledger.json'),
  JSON.stringify(
    {
      generatedFor: bundle.generatedFor,
      policy: bundle.policy,
      sent: bundle.sentLedger,
      pendingCorrections: bundle.corrections,
      drafts: bundle.drafts,
    },
    null,
    2,
  ),
  'utf8',
)
await writeFile(path.join(args.out, 'sendable-bundle.json'), JSON.stringify(bundle.sendableBundle, null, 2), 'utf8')
await writeFile(
  path.join(args.out, 'risk-manager-worksheet.json'),
  JSON.stringify(bundle.riskManagerWorksheet, null, 2),
  'utf8',
)
await writeFile(path.join(args.out, 'summary.md'), renderMarkdown(bundle), 'utf8')

for (const m of [...bundle.corrections, ...bundle.drafts]) {
  const safe = m.messageId.replace(/[^A-Za-z0-9_.-]/g, '_')
  await writeFile(path.join(args.out, 'messages', `${safe}.external.json`), JSON.stringify(m.external, null, 2), 'utf8')
}
await writeFile(
  path.join(args.out, 'internal', 'worksheet-reference.json'),
  JSON.stringify({ internalOnly: bundle.riskManagerWorksheet.internalOnly }, null, 2),
  'utf8',
)

console.log(`Report bundle written to ${args.out}`)
console.log(`- ${path.join(args.out, 'summary.md')}`)
console.log(`- ${path.join(args.out, 'sendable-bundle.json')}`)
console.log(`- ${path.join(args.out, 'risk-manager-worksheet.json')}`)
