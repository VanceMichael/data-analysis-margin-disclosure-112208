import { num, dayNumber, round } from './util.js'
import { intervalValue } from './market.js'

const RECOGNIZED_STATES = new Set(['已确', '部分有效', '独立受理'])

export function selectCollateral(data, basis, options = {}) {
  const asOfDay = options.asOf?.day ?? 'LATEST'
  const cutoff = asOfDay === 'LATEST' ? Number.MAX_SAFE_INTEGER : dayNumber(asOfDay)
  const haircutOption = options.haircut ?? 0
  const unknownHaircutBounds = options.unknownHaircutBounds ?? [0, 1]

  const visible = data.collateral.filter(c => dayNumber(c.asof) <= cutoff)
  const latestByPledge = new Map()
  for (const c of visible) {
    const d = dayNumber(c.asof)
    if (!latestByPledge.has(c.pledge) || d > latestByPledge.get(c.pledge).day) {
      latestByPledge.set(c.pledge, { day: d, rows: [] })
    }
    if (latestByPledge.get(c.pledge).day === d) latestByPledge.get(c.pledge).rows.push(c)
  }

  const rows = []
  for (const { rows: latestRows } of latestByPledge.values()) {
    for (const c of latestRows) {
      const b = basis.prices[c.security]
      const units = num(c.units)
      const coefficient = units * (b?.price ?? 0)
      const valued = intervalValue(coefficient, b, { currency: c.currency })
      let haircut = haircutOption
      let haircutKnown = typeof haircut === 'number' && Number.isFinite(haircut)
      if (haircut === 'source' || haircut === undefined) {
        if (c.haircut === '?' || c.haircut === undefined) {
          haircut = c.haircut === '?' ? null : 0
          haircutKnown = c.haircut === undefined
        } else {
          haircut = num(c.haircut)
          haircutKnown = haircut !== null
        }
      }
      if (haircut === 'unknown' || options.unknownHaircut === true) haircutKnown = false

      let low = valued.low
      let high = valued.high
      if (valued.low !== null && haircutKnown) {
        const haircutFactor = 1 - haircut
        low = valued.low * haircutFactor
        high = valued.high * haircutFactor
      } else if (valued.low !== null && !haircutKnown) {
        // 没有来源折扣区间时，仅给最宽的数学支持域 [0, 市值]，并明确不是已确认值。
        low = valued.low * unknownHaircutBounds[0]
        high = valued.high * unknownHaircutBounds[1]
      }
      const matchedRequest = data.pledge_requests
        .filter(p => p.pledge === c.pledge && p.group === c.groups && num(p.units) === units)
        .filter(p => dayNumber(p.asof) <= cutoff)
        .sort((a, z) => dayNumber(z.asof) - dayNumber(a.asof))[0]

      const groupDesks = [...new Set(data.accounts.filter(a => a.group === c.groups).map(a => a.desk))]
      let desk = matchedRequest?.desk ?? null
      let attributionBasis = matchedRequest ? `request:${matchedRequest.request}` : null
      if (!desk && groupDesks.length === 1) {
        desk = groupDesks[0]
        attributionBasis = 'unique_desk_in_group'
      }
      if (!desk && options.allocateSharedBySecurity) {
        const matchingDesks = [
          ...new Set(
            data.holdings
              .filter(h => h.security === c.security)
              .map(h => data.accounts.find(a => a.account === h.account))
              .filter(Boolean)
              .filter(a => a.group === c.groups)
              .map(a => a.desk),
          ),
        ]
        if (matchingDesks.length === 1) {
          desk = matchingDesks[0]
          attributionBasis = 'security_match_simulation_not_formal'
        }
      }
      if (!desk) attributionBasis = 'group_shared_unallocated'

      const formallySupported =
        c.state === '已确' ||
        c.state === '部分有效' ||
        (c.state === '独立受理' && matchedRequest?.state === '已受理')

      rows.push({
        pledge: c.pledge,
        group: c.groups,
        desk,
        attributionBasis,
        matchedRequest: matchedRequest?.request ?? null,
        requestState: matchedRequest?.state ?? null,
        security: c.security,
        units,
        currency: c.currency,
        shared: c.share === 'yes',
        state: c.state,
        asof: c.asof,
        recognizedState: RECOGNIZED_STATES.has(c.state),
        formallySupported,
        // 实际口径只把正式/部分有效且能归属的证据计入；待确进入 support/unconfirmed。
        recognized: options.includePending ? RECOGNIZED_STATES.has(c.state) || c.state === '待确' : formallySupported,
        marketValue: valued.value === null ? null : round(valued.value, 6),
        preHaircutLow: valued.low === null ? null : round(valued.low, 6),
        preHaircutHigh: valued.high === null ? null : round(valued.high, 6),
        low: low === null ? null : round(low, 6),
        high: high === null ? null : round(high, 6),
        haircut: haircutKnown ? haircut : null,
        haircutKnown,
        haircutUnconfirmed: !haircutKnown,
        confirmed: valued.confirmed && haircutKnown,
        fxConfirmed: valued.confirmed,
        raw: c,
      })
    }
  }
  return rows
}

export function pledgeClaimDiagnostics(data, basis, options = {}) {
  const asOfDay = options.asOf?.day ?? 'LATEST'
  const cutoff = asOfDay === 'LATEST' ? Number.MAX_SAFE_INTEGER : dayNumber(asOfDay)
  const requests = data.pledge_requests.filter(p => dayNumber(p.asof) <= cutoff)
  const byPledge = new Map()

  for (const p of requests) {
    if (!byPledge.has(p.pledge)) byPledge.set(p.pledge, [])
    byPledge.get(p.pledge).push(p)
  }

  const diagnostics = []
  for (const [pledge, claims] of byPledge) {
    const latestCollateralDay = Math.max(
      ...data.collateral.filter(c => c.pledge === pledge).map(c => dayNumber(c.asof)),
    )
    const registeredRows = data.collateral.filter(
      c => c.pledge === pledge && dayNumber(c.asof) === latestCollateralDay,
    )
    const registeredUnits = registeredRows.reduce((a, c) => a + num(c.units), 0)
    const security = registeredRows[0]?.security
    const b = basis.prices[security]
    const g1DeskClaims = claims.filter(c => c.group === 'G1')
    const simultaneousG1Units = g1DeskClaims.reduce((a, c) => a + num(c.units), 0)
    const excessClaimUnits = Math.max(0, simultaneousG1Units - registeredUnits)
    const price = b?.price ?? null
    const fx = b?.fx ?? (registeredRows[0]?.currency === 'CNY' ? 1 : null)
    const valuePerUnit = price === null || fx === null ? null : price * fx

    const formalG1Units = data.collateral
      .filter(c => c.pledge === pledge && c.groups === 'G1' && dayNumber(c.asof) <= cutoff)
      .sort((a, b) => dayNumber(b.asof) - dayNumber(a.asof))[0]
    const formalG2Accepted = data.pledge_requests.some(
      p => p.pledge === pledge && p.group === 'G2' && p.state === '已受理' && dayNumber(p.asof) <= cutoff,
    )
    const d8ReceiptVisible = cutoff >= 8 && Boolean(formalG1Units) && formalG2Accepted

    diagnostics.push({
      pledge,
      security,
      registeredUnits,
      registeredAsOf: registeredRows[0]?.asof ?? null,
      claims: claims.map(c => ({
        request: c.request,
        group: c.group,
        desk: c.desk,
        units: num(c.units),
        state: c.state,
        asof: c.asof,
      })),
      simultaneousG1ClaimUnits: simultaneousG1Units,
      excessClaimUnits,
      fullPledgeDuplicatedUnits: registeredUnits,
      overstatement: {
        claimOverlapUnits: excessClaimUnits,
        claimOverlapValue: valuePerUnit === null ? null : round(excessClaimUnits * valuePerUnit, 2),
        fullDuplicateUnits: registeredUnits,
        fullDuplicateValue: valuePerUnit === null ? null : round(registeredUnits * valuePerUnit, 2),
        scope: 'G1/D1+D2',
      },
      mutuallyExclusivePlans: [
        {
          id: 'plan-D1-first',
          allocations: { 'G1/D1': 18, 'G2/D2': 12 },
          total: 30,
          supportedAtCutoff: d8ReceiptVisible,
          basis: d8ReceiptVisible
            ? 'D8 C1=18(G1,部分有效)+P4/C1=12(G2,已受理)'
            : 'D7 仅为申报/待权属；不能作为已确认依据',
          note: 'D7 与 D2-first 互斥；D8 回执后该拆分与正式证据一致',
        },
        {
          id: 'plan-D2-first',
          allocations: { 'G1/D2': 16, 'G2/D2': 12 },
          total: 28,
          supportedAtCutoff: false,
          basis: 'P2 仍为待议，且 D8 正式拆分未给 D2 16 份',
          note: '可作反事实调配，但不能与 D1 全额方案同时作为依据',
        },
        {
          id: 'invalid-both-lines-full',
          allocations: { 'G1/D1': 18, 'G1/D2': 16, 'G2/D2': 12 },
          total: 46,
          registeredUnits: 30,
          unsupportedUnits: 16,
          supportedAtCutoff: false,
          note: 'G1 两条线全额同时申报本身已超 C1 总额 4；再加 G2 12 后超 16',
        },
      ],
    })
  }
  return diagnostics
}
