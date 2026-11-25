import { marketBasis } from './market.js'
import { applicableContract, policyManifest } from './contracts.js'
import { selectCollateral, pledgeClaimDiagnostics } from './collateral.js'
import {
  num,
  round,
  groupBy,
  clampNonNegative,
  asOfKey,
  dayNumber,
} from './util.js'

function newAcc() {
  return { value: 0, confirmedValue: 0, low: 0, high: 0, complete: true, items: [] }
}

function addInterval(acc, iv, meta = {}) {
  const item = { ...meta, ...iv }
  acc.items.push(item)
  if (iv.value === null || iv.value === undefined) {
    acc.complete = false
  } else {
    acc.value += iv.value
    acc.confirmedValue += iv.value
  }
  if (iv.confirmed) {
    // confirmedValue already added
  } else if (iv.low !== null && iv.low !== undefined) {
    // Unknown total contributes no confirmed CNY, only bounds.
  }
  if (iv.low !== null && iv.low !== undefined) acc.low += iv.low
  if (iv.high !== null && iv.high !== undefined) acc.high += iv.high
  return item
}

function finalizeAcc(acc) {
  return {
    value: acc.complete ? round(acc.value) : null,
    confirmedCny: round(acc.confirmedValue),
    low: round(acc.low),
    high: round(acc.high),
    complete: acc.complete,
    items: acc.items,
  }
}

function intervalFor(coefficient, basis, currency) {
  const fx = currency === 'CNY' ? 1 : basis.fx
  if (fx !== null && fx !== undefined) {
    const value = round(coefficient * fx)
    return { value, low: value, high: value, confirmed: true }
  }
  if (basis.fxRange) {
    const vals = basis.fxRange.map(r => coefficient * r)
    return { value: null, low: round(Math.min(...vals)), high: round(Math.max(...vals)), confirmed: false }
  }
  return { value: null, low: null, high: null, confirmed: false }
}

function applyMarketScenario(basis, scenario) {
  if (!scenario) return basis
  const prices = { ...basis.prices }
  for (const [security, b0] of Object.entries(prices)) {
    const b = { ...b0, quote: b0.quote ? { ...b0.quote } : null }
    if (scenario.prices?.[security] !== undefined) {
      b.price = scenario.prices[security]
    }
    if (scenario.fx !== undefined && scenario.fx !== null) {
      const fxSpec = scenario.fx
      if (fxSpec === 'low' && b.fx === null && b.fxRange) b.fx = b.fxRange[0]
      else if (fxSpec === 'high' && b.fx === null && b.fxRange) b.fx = b.fxRange[1]
      else if (typeof fxSpec === 'number' && scenario.allFx) b.fx = fxSpec
      else if (typeof fxSpec === 'object' && fxSpec[b.security] !== undefined) b.fx = fxSpec[b.security]
      b.fxKnown = b.fx !== null
    }
    prices[security] = b
  }
  return { ...basis, prices, scenario }
}

function claimCollateralRows(data, basis, cutoffDay) {
  const pledgeSecurity = new Map()
  for (const c of data.collateral) {
    if (!pledgeSecurity.has(c.pledge)) pledgeSecurity.set(c.pledge, c.security)
  }
  return data.pledge_requests
    .filter(p => dayNumber(p.asof) <= cutoffDay)
    .map(p => {
      const security = pledgeSecurity.get(p.pledge)
      const b = basis.prices[security]
      const units = num(p.units)
      const iv = intervalFor(units * (b?.price ?? 0), b, 'FX')
      return {
        pledge: p.pledge,
        group: p.group,
        desk: p.desk,
        units,
        security,
        shared: true,
        recognized: true,
        formallySupported: false,
        state: `申报口径:${p.state}`,
        attributionBasis: `request:${p.request}`,
        low: iv.low,
        high: iv.high,
        confirmed: iv.confirmed,
        claim: p.request,
      }
    })
}

export function runScenario(data, options = {}) {
  const valuationDay = options.valuationDay ?? 'D7'
  const asOf = options.asOf ?? { day: 'D8', minute: 560 }
  const cutoffDay = asOf?.day ? dayNumber(asOf.day) : Number.MAX_SAFE_INTEGER
  let basis = marketBasis(data, {
    valuationDay,
    asOf,
    marketAsOf: options.marketAsOf,
  })
  basis = applyMarketScenario(basis, options.marketScenario)

  const collateralRows =
    options.claimBasis === 'all-claims'
      ? claimCollateralRows(data, basis, cutoffDay)
      : selectCollateral(data, basis, {
          asOf,
          haircut: options.haircut ?? 0,
          unknownHaircut: options.unknownHaircut,
          unknownHaircutBounds: options.unknownHaircutBounds,
          includePending: options.includePendingCollateral,
          allocateSharedBySecurity: options.allocateSharedBySecurity,
        })

  const scopeKeys = new Set()
  for (const a of data.accounts) scopeKeys.add(`${a.group}/${a.desk}`)
  for (const l of data.limits) scopeKeys.add(`${l.group}/${l.desk}`)
  const scopes = [...scopeKeys].sort().map(key => {
    const [group, desk] = key.split('/')
    return {
      key,
      group,
      desk,
      accounts: data.accounts.filter(a => a.group === group && a.desk === desk).map(a => a.account),
      products: [...new Set(data.accounts.filter(a => a.group === group && a.desk === desk).map(a => a.product))],
      rows: [],
      gross: newAcc(),
      margin: newAcc(),
      floorMargin: newAcc(),
      overrideLayer: newAcc(),
      lineCollateral: newAcc(),
      groupCollateral: newAcc(),
    }
  })
  const scopeMap = new Map(scopes.map(s => [s.key, s]))

  const exposureRows = []
  for (const h of data.holdings) {
    const account = data.accounts.find(a => a.account === h.account)
    const key = `${account.group}/${account.desk}`
    const scope = scopeMap.get(key)
    const contract = applicableContract(data, h, {
      asOf,
      valuationDay,
      contractDay: options.contractDay,
    })
    const b = basis.prices[h.security]
    const units = num(h.units)
    const price = b?.price ?? null
    const coefficient = units * (price ?? 0)
    const notional = intervalFor(coefficient, b)
    const margin = intervalFor(coefficient * contract.rate, b)
    const floorMargin = intervalFor(coefficient * contract.commonFloor, b)
    const overrideLayer = intervalFor(
      coefficient * Math.max(0, contract.rate - contract.commonFloor),
      b,
    )

    const row = {
      lot: h.lot,
      account: h.account,
      group: account.group,
      desk: account.desk,
      product: account.product,
      kind: h.kind,
      opened: h.opened,
      security: h.security,
      units,
      price,
      fx: b?.fx ?? null,
      fxRange: b?.fxRange ?? null,
      notionalLocal: round(coefficient, 6),
      notional,
      margin,
      floorMargin,
      overrideLayer,
      contract,
      sources: [contract.eventId, b.priceEvent].filter(Boolean),
    }
    exposureRows.push(row)
    scope.rows.push(row)
    addIntervalTo(scope, 'gross', notional, row)
    addIntervalTo(scope, 'margin', margin, row)
    addIntervalTo(scope, 'floorMargin', floorMargin, row)
    addIntervalTo(scope, 'overrideLayer', overrideLayer, row)
  }

  for (const c of collateralRows) {
    if (!c.recognized && options.claimBasis !== 'all-claims') continue
    const iv = { value: c.confirmed ? c.low : null, low: c.low, high: c.high, confirmed: c.confirmed }
    const groupScopes = scopes.filter(s => s.group === c.group)
    for (const s of groupScopes) addIntervalTo(s, 'groupCollateral', iv, c)
    if (c.desk) {
      const s = scopeMap.get(`${c.group}/${c.desk}`)
      if (s) addIntervalTo(s, 'lineCollateral', iv, c)
    }
  }

  const limits = data.limits.filter(l => dayNumber(l.asof) <= cutoffDay)
  for (const s of scopes) {
    const lineLimits = limits.filter(l => l.group === s.group && l.desk === s.desk)
    s.limitRecords = lineLimits.map(l => ({ ...l, limit: num(l.limit) }))
    s.acceptedLimit = round(
      lineLimits.filter(l => l.state === '已接受').reduce((a, l) => a + num(l.limit), 0),
    )
    s.pendingLimit = round(
      lineLimits.filter(l => l.state === '待议').reduce((a, l) => a + num(l.limit), 0),
    )
    s.counterfactualLimit = round(s.acceptedLimit + s.pendingLimit)
  }

  for (const s of scopes) {
    s.gross = finalizeAcc(s.gross)
    s.margin = finalizeAcc(s.margin)
    s.floorMargin = finalizeAcc(s.floorMargin)
    s.overrideLayer = finalizeAcc(s.overrideLayer)
    s.lineCollateral = finalizeAcc(s.lineCollateral)
    s.groupCollateral = finalizeAcc(s.groupCollateral)
  }

  const groups = [...new Set(scopes.map(s => s.group))].sort()
  const groupResults = groups.map(group => {
    const ss = scopes.filter(s => s.group === group)
    const merge = field => mergeIntervals(ss.map(s => s[field]))
    const acceptedLimit = round(ss.reduce((a, s) => a + s.acceptedLimit, 0))
    const pendingLimit = round(ss.reduce((a, s) => a + s.pendingLimit, 0))
    const gross = merge('gross')
    const margin = merge('margin')
    const floorMargin = merge('floorMargin')
    const overrideLayer = merge('overrideLayer')
    // groupCollateral 是整组共享池，已复制到组内每个 scope；合并 scope 会重复。
    const collateral = ss[0].groupCollateral
    const net = subtractIntervals(gross, collateral)
    const marginShortfall =
      margin.value === null || collateral.value === null
        ? { value: null, low: Math.max(0, (margin.low ?? 0) - (collateral.high ?? 0)), high: Math.max(0, (margin.high ?? 0) - (collateral.low ?? 0)) }
        : pointInterval(Math.max(0, margin.value - collateral.value))
    return {
      group,
      scopes: ss.map(s => s.key),
      gross,
      margin,
      floorMargin,
      overrideLayer,
      collateral,
      netExposure: net,
      marginShortfall,
      acceptedLimit,
      pendingLimit,
      counterfactualLimit: round(acceptedLimit + pendingLimit),
      limitAssessment: assessLimit(net, acceptedLimit),
      counterfactualLimitAssessment: assessLimit(net, acceptedLimit + pendingLimit),
      marginAfterAcceptedLimits:
        margin.value === null || collateral.value === null
          ? null
          : round(collateral.value + acceptedLimit - margin.value),
    }
  })

  for (const s of scopes) {
    const groupResult = groupResults.find(g => g.group === s.group)
    s.lineNetExposure = subtractIntervals(s.gross, s.lineCollateral)
    s.groupNetExposure = groupResult.netExposure
    s.lineLimitAssessment = assessLimit(s.lineNetExposure, s.acceptedLimit)
    s.groupLimitAssessment = groupResult.limitAssessment
    s.counterfactualGroupLimitAssessment = options.includePendingLimits
      ? groupResult.counterfactualLimitAssessment
      : assessLimit(s.groupNetExposure, s.acceptedLimit)
    s.flags = buildFlags(s, basis, collateralRows, options)
    s.riskLabel = s.flags.some(f => f.code === 'LIMIT_BREACH' || f.code === 'RANGE_ALL_BREACH')
      ? '高'
      : s.flags.length
        ? '需复核/关注'
        : '正常'
  }

  for (const g of groupResults) {
    const groupScopes = scopes.filter(s => s.group === g.group)
    const hasReviewFlags = groupScopes.some(s => s.flags.length > 0)
    if (g.limitAssessment.excess !== null && g.limitAssessment.excess > 0) g.riskLabel = '高'
    else if (groupScopes.some(s => s.flags.some(f => f.code === 'RANGE_ALL_BREACH'))) g.riskLabel = '高'
    else if (hasReviewFlags) g.riskLabel = '需复核/关注'
    else g.riskLabel = '正常'
  }

  return {
    options,
    asOf,
    valuationDay,
    contractDay: options.contractDay ?? valuationDay,
    basis,
    policy: policyManifest(data, asOf),
    scopes,
    groups: groupResults,
    exposureRows,
    collateralRows,
    claims: pledgeClaimDiagnostics(data, basis, options),
  }
}

function addIntervalTo(scope, field, iv, meta) {
  if (!scope[field] || !scope[field].items) scope[field] = newAcc()
  addInterval(scope[field], iv, meta)
}

function mergeIntervals(intervals) {
  const complete = intervals.every(i => i.complete || i.value !== null)
  const value = intervals.every(i => i.value !== null)
    ? round(intervals.reduce((a, i) => a + i.value, 0))
    : null
  return {
    value,
    confirmedCny: round(intervals.reduce((a, i) => a + (i.confirmedCny ?? i.value ?? 0), 0)),
    low: round(intervals.reduce((a, i) => a + (i.low ?? 0), 0)),
    high: round(intervals.reduce((a, i) => a + (i.high ?? 0), 0)),
    complete: value !== null,
  }
}

function subtractIntervals(gross, collateral) {
  const value =
    gross.value !== null && collateral.value !== null ? round(gross.value - collateral.value) : null
  return {
    value,
    confirmedCny: round((gross.confirmedCny ?? 0) - (collateral.confirmedCny ?? 0)),
    low: round((gross.low ?? 0) - (collateral.high ?? 0)),
    high: round((gross.high ?? 0) - (collateral.low ?? 0)),
    complete: value !== null,
  }
}

function pointInterval(value) {
  const v = round(value)
  return { value: v, low: v, high: v, complete: true }
}

function assessLimit(net, limit) {
  const drawn = net.value === null ? null : clampNonNegative(net.value)
  return {
    limit: round(limit),
    drawn,
    undrawn: drawn === null ? null : round(Math.max(0, limit - drawn)),
    excess: drawn === null ? null : round(Math.max(0, drawn - limit)),
    utilization: drawn === null || limit === 0 ? null : round(drawn / limit, 4),
    rangeLowDrawn: clampNonNegative(net.low ?? 0),
    rangeHighDrawn: clampNonNegative(net.high ?? 0),
    rangeLowExcess: round(Math.max(0, (net.low ?? 0) - limit)),
    rangeHighExcess: round(Math.max(0, (net.high ?? 0) - limit)),
  }
}

function buildFlags(scope, basis, collateralRows, options) {
  const flags = []
  const assessment = scope.groupLimitAssessment
  if (assessment.excess !== null && assessment.excess > 0) {
    flags.push({ code: 'LIMIT_BREACH', message: `组级净敞口超已接受额度 ${assessment.excess}` })
  } else if (scope.groupNetExposure.value === null) {
    if (assessment.rangeLowExcess > 0 && assessment.rangeHighExcess > 0) {
      flags.push({ code: 'RANGE_ALL_BREACH', message: `支持区间下沿仍超额度 ${assessment.rangeLowExcess}` })
    } else if (assessment.rangeHighExcess > 0) {
      flags.push({ code: 'RANGE_CROSSES_LIMIT', message: '未知因子区间跨越额度，需追加核对' })
    }
  }

  const gaps = Object.values(basis.prices).filter(b => b.fx === null || b.price === null)
  if (gaps.some(b => scope.rows.some(r => r.security === b.security))) {
    flags.push({ code: 'MARKET_FACTOR_UNCONFIRMED', message: '持仓所用汇率/价格尚未确认' })
  }
  const unallocated = collateralRows.filter(
    c =>
      c.group === scope.group &&
      c.recognized &&
      (!c.desk || c.attributionBasis === 'group_shared_unallocated' || c.attributionBasis === 'security_match_simulation_not_formal'),
  )
  if (unallocated.length) {
    flags.push({
      code: 'SHARED_COLLATERAL_ALLOCATION_REVIEW',
      message: `共享抵押 ${[...new Set(unallocated.map(c => c.pledge))].join(',')} 缺少正式业务线归属；组级只计一次，安全匹配仅为模拟`,
    })
  }
  if (scope.rows.some(r => r.contract?.accountChanged)) {
    flags.push({ code: 'ACCOUNT_CHANGED_CREDENTIAL', message: '换账户持仓仍引用原合同凭据链' })
  }
  if (options.claimBasis === 'all-claims') {
    flags.push({ code: 'NAIVE_CLAIM_BASIS', message: '当前为把申报当抵押的重复计算口径，不能外发' })
  }
  return flags
}

export function evaluate(data, options = {}) {
  const base = runScenario(data, options)
  const hasFxGap = Object.values(base.basis.prices).some(p => p.fx === null && p.fxRange)
  if (!hasFxGap || options.includeUncertainty === false || options.marketScenario) {
    base.uncertainty = null
    return base
  }
  const low = runScenario(data, {
    ...options,
    includeUncertainty: false,
    marketScenario: { ...(options.marketScenario ?? {}), fx: 'low' },
  })
  const high = runScenario(data, {
    ...options,
    includeUncertainty: false,
    marketScenario: { ...(options.marketScenario ?? {}), fx: 'high' },
  })
  base.uncertainty = {
    fxLow: summarizeScenario(low),
    fxHigh: summarizeScenario(high),
  }
  // 用共同汇率情景收窄/修正每个组的相关区间。
  for (const g of base.groups) {
    const lg = low.groups.find(x => x.group === g.group)
    const hg = high.groups.find(x => x.group === g.group)
    g.correlatedNetRange = {
      low: Math.min(lg.netExposure.value, hg.netExposure.value),
      high: Math.max(lg.netExposure.value, hg.netExposure.value),
      fxLowValue: lg.netExposure.value,
      fxHighValue: hg.netExposure.value,
    }
    const a = g.limitAssessment
    a.correlatedRangeLowExcess = round(Math.max(0, g.correlatedNetRange.low - g.acceptedLimit))
    a.correlatedRangeHighExcess = round(Math.max(0, g.correlatedNetRange.high - g.acceptedLimit))
    if (g.netExposure.value === null) {
      if (g.correlatedNetRange.low > g.acceptedLimit) {
        g.riskLabel = '高'
        g.uncertaintyFlag = 'RANGE_ALL_BREACH'
      } else if (g.correlatedNetRange.high > g.acceptedLimit) {
        g.riskLabel = '需复核/关注'
        g.uncertaintyFlag = 'RANGE_CROSSES_LIMIT'
      } else {
        g.riskLabel = '待确认'
      }
    } else {
      const hasScopeFlags = base.scopes
        .filter(s => s.group === g.group)
        .some(s => s.flags.some(f => f.code !== 'MARKET_FACTOR_UNCONFIRMED' || g.netExposure.value === null))
      g.riskLabel = a.excess > 0 ? '高' : hasScopeFlags ? '需复核/关注' : '正常'
    }
  }
  return base
}

function summarizeScenario(result) {
  return {
    asOf: result.asOf,
    groups: result.groups.map(g => ({
      group: g.group,
      netExposure: g.netExposure.value,
      margin: g.margin.value,
      collateral: g.collateral.value,
      acceptedLimit: g.acceptedLimit,
      excess: g.limitAssessment.excess,
    })),
  }
}
