import assert from 'node:assert/strict'
import { mkdtemp, cp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadDataset } from '../src/dataset.js'
import { evaluate } from '../src/engine.js'

test('可以从任意目录重复导入修改后的合成资料', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'margin-import-'))
  const source = new URL('../data/', import.meta.url)
  await cp(source, dir, { recursive: true })

  const quotesPath = path.join(dir, 'quotes.json')
  const quotes = JSON.parse(await readFile(quotesPath, 'utf8'))
  const x = quotes.find(q => q.t === 'D8' && q.security === 'X')
  // 这个测试目录里把 D7 更正事件对应口径之外的 D8 行情改掉，不应影响 D7 Q5 选择。
  x.close = '99'
  await writeFile(quotesPath, JSON.stringify(quotes))

  const first = await loadDataset(dir)
  const second = await loadDataset(dir)
  assert.notEqual(first, second)
  assert.equal(first.quotes.find(q => q.t === 'D8' && q.security === 'X').close, '99')

  const result = evaluate(first, { asOf: { day: 'D8', minute: 560 } })
  assert.equal(result.basis.prices.X.price, 10)
  assert.equal(second.holdings.length, first.holdings.length)
})
