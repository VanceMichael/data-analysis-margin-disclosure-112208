#!/usr/bin/env node
import { loadDataset, validateDataset } from '../src/dataset.js'

const dataDir = process.argv[2] ?? new URL('../data/', import.meta.url)
const data = await loadDataset(dataDir)
const result = validateDataset(data)
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
