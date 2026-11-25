import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadDataset, validateDataset } from '../src/dataset.js'
import { evaluate } from '../src/engine.js'
import { buildAttribution, buildScenarioSuite, buildStress } from '../src/analysis.js'
import { buildReportBundle } from '../src/report.js'

const data = await loadDataset(new URL('../data/', import.meta.url))

test('合成资料通过引用校验', () => {
  const result = validateDataset(data)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.counts.holdings, 5)
})

test('行情按报送时点取版本，并保留未知汇率区间', () => {
  const noon = evaluate(data, { asOf: { day: 'D7', minute: 120 } })
  assert.equal(noon.basis.prices.X.price, 12)
  assert.equal(noon.basis.prices.X.priceEvent, 'Q1')
  assert.equal(noon.basis.prices.Y.price, 16)
  assert.equal(noon.basis.prices.Y.fx, null)
  assert.deepEqual(noon.basis.prices.Y.fxRange, [0.85, 1.2])

  const close = evaluate(data, { asOf: { day: 'D7', minute: 590 } })
  assert.equal(close.basis.prices.X.price, 9)
  assert.equal(close.basis.prices.X.priceEvent, 'Q3')

  const revised = evaluate(data, { asOf: { day: 'D8', minute: 560 } })
  assert.equal(revised.basis.prices.X.price, 10)
  assert.equal(revised.basis.prices.X.priceEvent, 'Q5')
  assert.equal(revised.basis.prices.Y.fx, 0.9)
})

test('历史/续期持仓继续适用 K1，补签 K4 只在 D9 生效', () => {
  const revised = evaluate(data, { asOf: { day: 'D8', minute: 560 } })
  const l3 = revised.exposureRows.find(r => r.lot === 'L3')
  assert.equal(l3.contract.contract, 'K1')
  assert.equal(l3.contract.isRollover, true)
  assert.deepEqual(l3.contract.credentialChain, ['K1'])
  assert.equal(l3.margin.value, 231.84)

  const forward = evaluate(data, {
    asOf: { day: 'D8', minute: 560 },
    contractDay: 'D9',
  })
  const l3d9 = forward.exposureRows.find(r => r.lot === 'L3')
  assert.equal(l3d9.contract.contract, 'K4')
  assert.equal(l3d9.margin.value, 171.36)
})

test('D8 更正基准的组级净敞口、额度和未兑现量正确', () => {
  const r = evaluate(data, { asOf: { day: 'D8', minute: 560 } })
  const g1 = r.groups.find(g => g.group === 'G1')
  const g2 = r.groups.find(g => g.group === 'G2')
  const g3 = r.groups.find(g => g.group === 'G3')

  assert.equal(g1.collateral.value, 419.4)
  assert.equal(g1.netExposure.value, 82.2)
  assert.equal(g1.limitAssessment.undrawn, 7.8)
  assert.equal(g1.limitAssessment.excess, 0)

  assert.equal(g2.collateral.value, 120)
  assert.equal(g2.netExposure.value, 132)
  assert.equal(g2.limitAssessment.excess, 22)
  assert.equal(g2.marginShortfall.value, 119.4)
  assert.equal(g2.marginAfterAcceptedLimits, -9.4)

  assert.equal(g3.collateral.value, 434)
  assert.equal(g3.netExposure.value, -184)
})

test('待议额度只作反事实，不改变实际已接受额度', () => {
  const actual = evaluate(data, { asOf: { day: 'D8', minute: 560 } })
  const counter = evaluate(data, {
    asOf: { day: 'D8', minute: 560 },
    includePendingLimits: true,
  })
  const g1Actual = actual.groups.find(g => g.group === 'G1')
  const g1Counter = counter.groups.find(g => g.group === 'G1')
  assert.equal(g1Actual.acceptedLimit, 90)
  assert.equal(g1Actual.pendingLimit, 70)
  assert.equal(g1Actual.counterfactualLimit, 160)
  assert.equal(g1Counter.counterfactualLimitAssessment.limit, 160)
  assert.equal(g1Actual.limitAssessment.limit, 90)
})

test('C1 两条业务线同时全额申报会在 G1 多计 4 份/40', () => {
  const r = evaluate(data, { asOf: { day: 'D8', minute: 560 } })
  const c1 = r.claims.find(c => c.pledge === 'C1')
  assert.equal(c1.simultaneousG1ClaimUnits, 34)
  assert.equal(c1.registeredUnits, 30)
  assert.equal(c1.excessClaimUnits, 4)
  assert.equal(c1.overstatement.claimOverlapValue, 40)
  assert.equal(c1.overstatement.fullDuplicateValue, 300)
  assert.equal(c1.overstatement.scope, 'G1/D1+D2')
})

test('D7 未知汇率时给共同因子区间，G2 下沿仍破限', () => {
  const noon = evaluate(data, { asOf: { day: 'D7', minute: 120 } })
  const g2 = noon.groups.find(g => g.group === 'G2')
  assert.equal(g2.netExposure.value, null)
  assert.equal(g2.correlatedNetRange.low, 272)
  assert.equal(g2.correlatedNetRange.high, 384)
  assert.equal(g2.limitAssessment.limit, 110)
  assert.ok(g2.correlatedNetRange.low > 110)
})

test('D7 互斥调配方案无回执依据，D8 正式拆分才有支持', () => {
  const d7 = evaluate(data, { asOf: { day: 'D7', minute: 590 } })
  const d8 = evaluate(data, { asOf: { day: 'D8', minute: 560 } })
  const p7 = d7.claims.find(c => c.pledge === 'C1').mutuallyExclusivePlans
  const p8 = d8.claims.find(c => c.pledge === 'C1').mutuallyExclusivePlans
  assert.equal(p7.find(p => p.id === 'plan-D1-first').supportedAtCutoff, false)
  assert.equal(p7.find(p => p.id === 'plan-D2-first').supportedAtCutoff, false)
  assert.equal(p8.find(p => p.id === 'plan-D1-first').supportedAtCutoff, true)
  assert.equal(p8.find(p => p.id === 'plan-D2-first').supportedAtCutoff, false)
})

test('换账户事件仍按 lot 回溯原合同凭据并打标', () => {
  const changed = structuredClone(data)
  changed.contract_events.find(e => e.contract === 'K1' && e.lot === 'L1').account = 'A9-OLD'
  const r = evaluate(changed, { asOf: { day: 'D8', minute: 560 } })
  const l1 = r.exposureRows.find(x => x.lot === 'L1')
  assert.equal(l1.contract.accountChanged, true)
  assert.deepEqual(l1.contract.credentialChain, ['K1'])
  assert.ok(r.scopes.find(s => s.key === 'G1/D1').flags.some(f => f.code === 'ACCOUNT_CHANGED_CREDENTIAL'))
})

test('未知抵押折扣不给确认值，但保留抵押市值和未确认标记', () => {
  const r = evaluate(data, {
    asOf: { day: 'D8', minute: 560 },
    unknownHaircut: true,
    includeUncertainty: false,
  })
  const c2 = r.collateralRows.find(c => c.pledge === 'C2')
  assert.equal(c2.haircutKnown, false)
  assert.equal(c2.haircutUnconfirmed, true)
  assert.equal(c2.confirmed, false)
  assert.equal(c2.marketValue, 239.4)
  assert.equal(c2.low, 0)
  assert.equal(c2.high, 239.4)
})

test('归因分离政策、新增构成、续期和未来补签', () => {
  const suite = buildScenarioSuite(data)
  const a = buildAttribution(data, suite)
  assert.equal(a.composition.newComposition.notionalCny, 352)
  assert.equal(a.policyParameterEffect.totalMarginRequirementReliefVsK1, 70.4)
  assert.equal(a.composition.rollover.lots.includes('L3'), true)
  assert.equal(a.composition.rollover.treatedAsNewFinancing, false)
  assert.equal(a.composition.rollover.falseNewExposureIfMistaken, 201.6)
  assert.equal(a.futureContractEffect.totalFutureMarginReduction, 60.48)
  assert.equal(a.quoteCorrectionEffect.xPriceCorrectionTotal, 55)
  assert.equal(a.quoteCorrectionEffect.xMarginCorrectionTotal, 60)
})

test('压力档可重复生成且降额会扩大 G2 超额', () => {
  const stress = buildStress(data)
  assert.equal(stress.length >= 4, true)
  const base = stress.find(x => x.id === 'S0')
  const h20 = stress.find(x => x.id === 'H20')
  assert.equal(base.groups.find(g => g.group === 'G2').limitExcess, 22)
  assert.equal(h20.groups.find(g => g.group === 'G2').limitExcess, 46)
})

test('通报更正保持原收件范围，外发对象不含反事实额度字段', () => {
  const bundle = buildReportBundle(data)
  const m1 = bundle.corrections.find(m => m.sourceReport === 'M1')
  const m3 = bundle.corrections.find(m => m.sourceReport === 'M3')
  assert.deepEqual(m1.originalRecipientScope, { group: 'G1', desk: 'D1' })
  assert.deepEqual(m1.recipientScope, { group: 'G1', desk: 'D1' })
  assert.deepEqual(m3.recipientScope, { group: 'G2', desk: 'D2' })
  assert.deepEqual(m1.corrects, ['M1-R1'])

  const json = JSON.stringify(bundle.sendableBundle)
  assert.equal(json.includes('counterfactualLimit'), false)
  assert.equal(json.includes('allocationPlans'), false)
  assert.equal(json.includes('fxLow'), false)
})
