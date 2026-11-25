import { evaluate, runScenario } from './engine.js'
import { round } from './util.js'

const CUTOFF_D7_NOON = { day: 'D7', minute: 120 }
const CUTOFF_D7_CLOSE = { day: 'D7', minute: 590 }
const CUTOFF_D8_REVISION = { day: 'D8', minute: 560 }

export const CUTOFFS = {
  CUTOFF_D7_NOON,
  CUTOFF_D7_CLOSE,
  CUTOFF_D8_REVISION,
}

function byLot(result) {
  return new Map(result.exposureRows.map(r => [r.lot, r]))
}

export function buildScenarioSuite(data) {
  const intraday = evaluate(data, {
    asOf: CUTOFF_D7_NOON,
    valuationDay: 'D7',
    allocateSharedBySecurity: true,
  })
  const closeInitial = evaluate(data, {
    asOf: CUTOFF_D7_CLOSE,
    valuationDay: 'D7',
    allocateSharedBySecurity: true,
  })
  const revised = evaluate(data, {
    asOf: CUTOFF_D8_REVISION,
    valuationDay: 'D7',
    allocateSharedBySecurity: true,
  })
  const forwardD9 = evaluate(data, {
    asOf: CUTOFF_D8_REVISION,
    contractDay: 'D9',
    valuationDay: 'D7',
    allocateSharedBySecurity: true,
    includeUncertainty: false,
  })
  return { intraday, closeInitial, revised, forwardD9 }
}

export function buildAttribution(data, suite = buildScenarioSuite(data)) {
  const current = suite.revised
  const currentRows = current.exposureRows
  const known = currentRows.every(r => r.margin.value !== null)

  const totalNotional = round(currentRows.reduce((a, r) => a + r.notional.value, 0))
  const totalMargin = round(currentRows.reduce((a, r) => a + r.margin.value, 0))
  const totalFloorMargin = round(currentRows.reduce((a, r) => a + r.floorMargin.value, 0))
  const overrideLayer = round(totalMargin - totalFloorMargin)

  const newRows = currentRows.filter(r => r.kind === '新增')
  const rolloverRows = currentRows.filter(r => r.contract?.isRollover || r.isRollover)
  const legacyRows = currentRows.filter(r => r.kind === '原持仓')

  const newComposition = {
    lots: newRows.map(r => r.lot),
    notionalCny: round(newRows.reduce((a, r) => a + r.notional.value, 0)),
    marginCny: round(newRows.reduce((a, r) => a + r.margin.value, 0)),
  }
  const rollover = {
    lots: rolloverRows.map(r => r.lot),
    notionalCny: round(rolloverRows.reduce((a, r) => a + r.notional.value, 0)),
    marginCny: round(rolloverRows.reduce((a, r) => a + r.margin.value, 0)),
    treatedAsNewFinancing: false,
    credentialChains: rolloverRows.map(r => ({ lot: r.lot, chain: r.contract.credentialChain })),
    falseNewExposureIfMistaken: round(rolloverRows.reduce((a, r) => a + r.notional.value, 0)),
  }

  // 固定资产、合约和 D7 修正行情，只把新增条款 K2 换成 K1 的 1 / 1.15。
  const oldRateForNew = 1.15
  const newPolicyCounterfactual = newRows.map(r => {
    const oldMargin = r.notional.value * oldRateForNew
    return {
      lot: r.lot,
      actualRule: r.contract.contract,
      actualRate: r.contract.rate,
      actualMargin: round(r.margin.value),
      k1Rate: oldRateForNew,
      k1Margin: round(oldMargin),
      policyRelief: round(oldMargin - r.margin.value),
    }
  })
  const policyRelief = round(
    newPolicyCounterfactual.reduce((a, x) => a + x.policyRelief, 0),
  )

  // 统一下限 vs 客户合同覆盖。
  const contractLayer = {
    floorMarginCny: totalFloorMargin,
    actualMarginCny: totalMargin,
    customerOverrideAddsCny: overrideLayer,
    byLot: currentRows.map(r => ({
      lot: r.lot,
      floor: r.contract.commonFloor,
      override: r.contract.override,
      effectiveRate: r.contract.rate,
      floorMargin: round(r.floorMargin.value),
      actualMargin: round(r.margin.value),
      overrideAdds: round(r.overrideLayer.value),
    })),
  }

  // K4 已在 D8:560 签认，但 D9 才生效；同一 D7 行情基准上比较未来合约影响。
  const k4Rows = suite.forwardD9.exposureRows.filter(r => r.contract.contract === 'K4')
  const k4Effect = k4Rows.map(r => {
    const before = byLot(current).get(r.lot)
    return {
      lot: r.lot,
      account: r.account,
      beforeContract: before.contract.contract,
      beforeRate: before.contract.rate,
      beforeMargin: round(before.margin.value),
      afterContract: r.contract.contract,
      afterRate: r.contract.rate,
      afterMargin: round(r.margin.value),
      marginReduction: round(before.margin.value - r.margin.value),
      effectiveDay: r.contract.effectiveDay,
      signedDay: r.contract.signedDay,
    }
  })

  // 行情更正归因：证据日仍固定 D8 抵押/合同口径，只切换 D7 原始收盘与 D8 早间更正事件。
  const originalCloseQuoteFixedEvidence = evaluate(data, {
    asOf: CUTOFF_D8_REVISION,
    marketAsOf: CUTOFF_D7_CLOSE,
    valuationDay: 'D7',
    allocateSharedBySecurity: true,
    includeUncertainty: false,
  })
  const originalRows = byLot(originalCloseQuoteFixedEvidence)
  const quoteCorrection = []
  for (const r of currentRows) {
    const o = originalRows.get(r.lot)
    quoteCorrection.push({
      lot: r.lot,
      security: r.security,
      units: r.units,
      originalClosePrice: o.price,
      correctedPrice: r.price,
      originalFx: o.fx,
      correctedFx: r.fx,
      priceNotionalDelta:
        o.price !== null && r.price !== null ? round(r.units * (r.price - o.price) * (r.fx ?? 1)) : null,
      marginDeltaKnown:
        o.margin.value !== null && r.margin.value !== null
          ? round(r.margin.value - o.margin.value)
          : null,
      originalFxRange: o.fxRange,
      note: o.fx === null ? '原收盘汇率未知；不能伪造单点差额，只能报告区间收窄/确认' : null,
    })
  }

  const c1 = current.claims.find(c => c.pledge === 'C1')
  const collateralDuplication = {
    pledge: 'C1',
    overcountedScope: 'G1/D1+D2',
    simultaneousG1ClaimUnits: c1.simultaneousG1ClaimUnits,
    registeredUnits: c1.registeredUnits,
    excessClaimUnits: c1.excessClaimUnits,
    correctedBasisPrice: current.basis.prices.X.price,
    claimOverstatement: c1.overstatement,
    overstatement: c1.overstatement,
    ...c1.overstatement,
    explanation:
      'P1=18 与 P2=16 同时按全额计入 G1 两条业务线得到34份；C1 同一 pledge 最新证据总额为30份，故简单申报重叠多计4份。若两条线都把整笔30份各自计一次，则整笔30份被重复。',
  }

  const timeline = ['intraday', 'closeInitial', 'revised'].map(key => {
    const result = suite[key]
    return {
      scenario: key,
      asOf: result.asOf,
      groups: result.groups.map(g => ({
        group: g.group,
        riskLabel: g.riskLabel,
        netExposureCny: g.netExposure.value,
        correlatedNetRange: g.correlatedNetRange ?? null,
        acceptedLimit: g.acceptedLimit,
        undrawn: g.limitAssessment.undrawn,
        excess: g.limitAssessment.excess,
      })),
    }
  })

  const labelTransitions = ['G1', 'G2', 'G3'].map(groupId => {
    const pick = key => timeline.find(t => t.scenario === key).groups.find(g => g.group === groupId)
    const noon = pick('intraday')
    const revised = pick('revised')
    return {
      group: groupId,
      intradayLabel: noon.riskLabel,
      revisedLabel: revised.riskLabel,
      changed: noon.riskLabel !== revised.riskLabel,
      acceptedLimitContinues: revised.acceptedLimit,
      undrawn: revised.undrawn,
      reviewRequired: revised.excess > 0 || revised.riskLabel.includes('复核') || revised.riskLabel.includes('关注'),
    }
  })

  const capacityReconciliation = {
    actualAcceptedLimitCny: round(current.groups.reduce((a, g) => a + g.acceptedLimit, 0)),
    pendingLimitNotCountedCny: round(current.groups.reduce((a, g) => a + g.pendingLimit, 0)),
    policyParameterMarginReliefCny: policyRelief,
    duplicateClaimOverstatementCny: collateralDuplication.claimOverstatement.claimOverlapValue,
    fullPledgeDuplicationCny: collateralDuplication.claimOverstatement.fullDuplicateValue,
    statement:
      '给定资料没有额度审批变更；政策变化可量化为新增持仓保证金要求下降，抵押重复申报只虚增抵押支持/容量，不形成新的已接受额度。待议额度仅可反事实。',
  }

  return {
    comparableBasis: {
      valuationDay: 'D7',
      correctedEvents: ['Q5', 'Q6'],
      rule: '所有金额均在 D7 估值日、Q5/Q6 更正后的行情基准上比较；D8 行情不混入 D7 归因。',
    },
    totals: { totalNotional, totalMargin, known },
    composition: { newComposition, rollover, legacyLots: legacyRows.map(r => r.lot) },
    policyParameterEffect: {
      fixed: ['客户合约归属', '资产构成', 'D7更正行情'],
      newPolicyCounterfactual,
      totalMarginRequirementReliefVsK1: policyRelief,
      interpretation: '正数表示 K2 参数相对 K1(1/1.15) 减少的保证金要求，不是抵押品新增。',
    },
    contractOverrideLayer: contractLayer,
    futureContractEffect: {
      fixed: ['资产构成', 'D7更正行情', '政策表'],
      signedAtCutoffButEffectiveLater: true,
      currentD7BasisAppliesK4: false,
      forwardContractDay: 'D9',
      d9Effects: k4Effect,
      totalFutureMarginReduction: round(k4Effect.reduce((a, x) => a + x.marginReduction, 0)),
    },
    quoteCorrectionEffect: {
      fixed: ['客户合约', '资产构成', 'D8抵押证据'],
      byLot: quoteCorrection,
      xPriceCorrectionTotal: round(
        quoteCorrection.filter(x => x.security === 'X').reduce((a, x) => a + (x.priceNotionalDelta ?? 0), 0),
      ),
      xMarginCorrectionTotal: round(
        quoteCorrection.filter(x => x.security === 'X').reduce((a, x) => a + (x.marginDeltaKnown ?? 0), 0),
      ),
    },
    collateralDuplication,
    timeline,
    labelTransitions,
    capacityReconciliation,
  }
}

export function buildStress(data, suite = buildScenarioSuite(data)) {
  const baseOptions = {
    asOf: CUTOFF_D8_REVISION,
    valuationDay: 'D7',
    allocateSharedBySecurity: true,
    includeUncertainty: false,
  }
  const tiers = [
    { id: 'S0', label: 'D7更正收盘基准', haircut: 0 },
    { id: 'H10', label: '模拟抵押降额10%', haircut: 0.1 },
    { id: 'H20', label: '模拟抵押降额20%', haircut: 0.2 },
    {
      id: 'ABN',
      label: '来源异常区间不利端(X=9,Y FX=.85)',
      haircut: 0,
      marketScenario: { prices: { X: 9 }, fx: { Y: 0.85 } },
    },
    {
      id: 'ABN_H10',
      label: '异常区间+降额10%',
      haircut: 0.1,
      marketScenario: { prices: { X: 9 }, fx: { Y: 0.85 } },
    },
    {
      id: 'ABN_H20',
      label: '异常区间+降额20%',
      haircut: 0.2,
      marketScenario: { prices: { X: 9 }, fx: { Y: 0.85 } },
    },
  ]

  return tiers.map(tier => {
    const result = runScenario(data, { ...baseOptions, ...tier })
    return {
      id: tier.id,
      label: tier.label,
      haircut: tier.haircut,
      marketScenario: tier.marketScenario ?? null,
      groups: result.groups.map(g => ({
        group: g.group,
        netExposure: g.netExposure.value,
        collateral: g.collateral.value,
        marginRequirement: g.margin.value,
        marginShortfall: g.marginShortfall.value,
        acceptedLimit: g.acceptedLimit,
        limitExcess: g.limitAssessment.excess,
        undrawn: g.limitAssessment.undrawn,
        counterfactualLimit: g.counterfactualLimit,
        counterfactualExcess: g.counterfactualLimitAssessment.excess,
      })),
    }
  })
}
