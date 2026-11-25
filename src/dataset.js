import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TABLE_NAMES, dayNumber, isMissing } from './util.js'

export async function loadDataset(dir) {
  let base
  if (!dir) {
    base = fileURLToPath(new URL('../data/', import.meta.url))
  } else if (dir instanceof URL) {
    base = fileURLToPath(dir)
  } else {
    base = path.resolve(dir)
  }
  const data = {}
  for (const name of TABLE_NAMES) {
    const file = path.join(base, `${name}.json`)
    data[name] = JSON.parse(await readFile(file, 'utf8'))
  }
  return data
}

function addError(errors, code, message, refs = {}) {
  errors.push({ code, message, ...refs })
}

export function validateDataset(data) {
  const errors = []
  const warnings = []

  for (const name of TABLE_NAMES) {
    if (!Array.isArray(data[name]) || data[name].length === 0) {
      addError(errors, 'TABLE_EMPTY', `表 ${name} 缺失或为空`, { table: name })
    }
  }
  if (errors.length) return { ok: false, errors, warnings, counts: {} }

  for (const name of TABLE_NAMES) {
    const columns = Object.keys(data[name][0])
    data[name].forEach((row, i) => {
      for (const col of columns) {
        if (typeof row[col] !== 'string') {
          addError(errors, 'RAW_NOT_STRING', `${name}[${i}].${col} 不是字符串`, {
            table: name,
            index: i,
            field: col,
          })
        }
      }
    })
  }

  const accounts = data.accounts
  const accountIds = new Set(accounts.map(a => a.account))
  const groupDesk = new Set(accounts.map(a => `${a.group}/${a.desk}`))
  const groups = new Set(accounts.map(a => a.group))
  const rules = new Set(data.policy.map(p => p.rule))
  const pledges = new Set(data.collateral.map(c => c.pledge))
  const securities = new Set(data.quotes.map(q => q.security))

  for (const h of data.holdings) {
    if (!accountIds.has(h.account)) {
      addError(errors, 'BAD_ACCOUNT', `持仓 ${h.lot} 引用不存在账户 ${h.account}`, { lot: h.lot })
    }
    if (!rules.has(h.contract)) {
      addError(errors, 'BAD_RULE', `持仓 ${h.lot} 引用不存在政策/合同 ${h.contract}`, { lot: h.lot })
    }
    if (!securities.has(h.security)) {
      warnings.push({ code: 'NO_QUOTE', message: `持仓 ${h.lot} 的证券 ${h.security} 无行情`, lot: h.lot })
    }
  }

  const holdingKeys = new Set(data.holdings.map(h => `${h.lot}/${h.account}`))
  for (const e of data.contract_events) {
    if (!holdingKeys.has(`${e.lot}/${e.account}`)) {
      addError(errors, 'BAD_EVENT_LOT', `合同事件 ${e.contract} 引用不存在持仓/账户 ${e.lot}/${e.account}`)
    }
    if (!rules.has(e.contract)) {
      addError(errors, 'BAD_EVENT_RULE', `合同事件 ${e.contract} 找不到政策条款`)
    }
    if (!isMissing(e.prior_contract) && !rules.has(e.prior_contract)) {
      addError(errors, 'BAD_PRIOR_CONTRACT', `合同事件 ${e.contract} 的前序合同 ${e.prior_contract} 不存在`)
    }
    if (dayNumber(e.signed_day) > dayNumber(e.effective_day)) {
      warnings.push({ code: 'EFFECTIVE_BEFORE_SIGN', message: `${e.contract} 生效日早于签认日` })
    }
  }

  for (const c of data.collateral) {
    if (!groups.has(c.groups)) {
      addError(errors, 'BAD_GROUP', `抵押 ${c.pledge} 引用不存在组 ${c.groups}`)
    }
    if (!securities.has(c.security)) {
      warnings.push({ code: 'NO_QUOTE', message: `抵押 ${c.pledge} 的证券 ${c.security} 无行情` })
    }
  }

  for (const l of data.limits) {
    if (!groupDesk.has(`${l.group}/${l.desk}`)) {
      addError(errors, 'BAD_LIMIT_SCOPE', `额度 ${l.group}/${l.desk} 在账户表中不存在`)
    }
  }
  for (const d of data.distributions) {
    if (!groupDesk.has(`${d.group}/${d.desk}`)) {
      addError(errors, 'BAD_DISTRIBUTION_SCOPE', `通报 ${d.report} 收件范围 ${d.group}/${d.desk} 不存在`)
    }
  }
  for (const p of data.pledge_requests) {
    if (!pledges.has(p.pledge)) {
      addError(errors, 'BAD_PLEDGE', `申报 ${p.request} 引用不存在抵押 ${p.pledge}`)
    }
    if (!groupDesk.has(`${p.group}/${p.desk}`)) {
      addError(errors, 'BAD_REQUEST_SCOPE', `申报 ${p.request} 范围 ${p.group}/${p.desk} 不存在`)
    }
  }

  const counts = Object.fromEntries(TABLE_NAMES.map(n => [n, data[n].length]))
  return { ok: errors.length === 0, errors, warnings, counts }
}
