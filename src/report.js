import { createHash } from 'node:crypto'
import { buildScenarioSuite, buildAttribution, buildStress } from './analysis.js'
import { round } from './util.js'

function policyRef(result) {
  const canonical = JSON.stringify(result.policy)
  return {
    valuationDay: result.valuationDay,
    contractDay: result.contractDay,
    asOf: result.asOf,
    rules: result.policy.map(p => p.rule),
    manifest: result.policy,
    hash: createHash('sha256').update(canonical).digest('hex').slice(0, 12),
  }
}

function scope(result, group, desk) {
  return result.scopes.find(s => s.group === group && s.desk === desk)
}
function group(result, g) {
  return result.groups.find(x => x.group === g)
}

function sourceRefs(s, g) {
  const lotIds = s.rows.map(r => r.lot)
  const eventIds = [...new Set(s.rows.flatMap(r => r.sources.filter(Boolean)))]
  const pledges = [...new Set(resultCollateralForScope(s).map(c => c.pledge))]
  const contracts = [...new Set(s.rows.map(r => r.contract.contract))]
  return { lots: lotIds, marketAndContractEvents: eventIds, pledges, contracts }
}

function resultCollateralForScope(s) {
  // scope items retain metadata from accumulator.
  return s.groupCollateral.items ?? []
}

function formalLineCollateral(s) {
  const items = s.lineCollateral.items ?? []
  const formalItems = items.filter(i => i.attributionBasis !== 'security_match_simulation_not_formal')
  const simulatedItems = items.filter(i => i.attributionBasis === 'security_match_simulation_not_formal')
  const sum = arr => round(arr.reduce((a, i) => a + (i.value ?? i.low ?? 0), 0))
  const formal = sum(formalItems)
  const simulated = sum(simulatedItems)
  const gross = s.gross.value
  return {
    formal,
    simulated,
    formalDeskNetExposureCny: gross === null ? null : round(gross - formal),
  }
}

function externalBody(result, groupId, desk, kind) {
  const s = scope(result, groupId, desk)
  const g = group(result, groupId)
  const refs = sourceRefs(s, g)
  const lineCollateral = formalLineCollateral(s)
  const basisEvents = [...new Set(Object.values(result.basis.prices).map(p => p.priceEvent).filter(Boolean))]

  const body = {
    reportKind: kind,
    recipientScope: { group: groupId, desk },
    valuationBasis: {
      valuationDay: result.valuationDay,
      evidenceCutoff: result.asOf,
      marketEvents: basisEvents,
    },
    groupLevel: {
      netExposureCny: g.netExposure.value,
      acceptedLimitCny: g.acceptedLimit,
      undrawnCny: g.limitAssessment.undrawn,
      excessOverAcceptedLimitCny: g.limitAssessment.excess,
      riskLabel: g.riskLabel ?? (g.limitAssessment.excess > 0 ? '高' : '需复核/关注'),
      marginCoverage: {
        marginRequirementCny: g.margin.value,
        collateralCountedOnceCny: g.collateral.value,
        marginShortfallBeforeLimitsCny: g.marginShortfall.value,
        acceptedLimitCny: g.acceptedLimit,
        residualCollateralPlusLimitMinusMarginCny: g.marginAfterAcceptedLimits,
      },
    },
    businessLineTrace: {
      grossExposureCny: s.gross.value,
      confirmedCnyFromKnownFactors: s.gross.confirmedCny,
      localConfirmedExposure: s.rows.map(r => ({
        lot: r.lot,
        security: r.security,
        units: r.units,
        price: r.price,
        localNotional: r.notionalLocal,
        fxKnown: r.fx !== null,
      })),
      recognizedFormalDeskCollateralCny: lineCollateral.formal,
      formalDeskNetExposureCny: lineCollateral.formalDeskNetExposureCny,
      acceptedDeskLimitCny: s.acceptedLimit,
      deskExcessCny:
        lineCollateral.formalDeskNetExposureCny === null
          ? null
          : round(Math.max(0, lineCollateral.formalDeskNetExposureCny - s.acceptedLimit)),
      note:
        s.group === 'G1'
          ? '组级共享抵押在 G1 层只计一次；无正式业务线归属的 C2 不伪装成 D2 已确认抵押，安全匹配仅留内参。'
          : undefined,
    },
    actions: [],
    sources: refs,
    policyHash: policyRef(result).hash,
  }

  if (g.limitAssessment.excess > 0) body.actions.push('按已接受额度缺口追加保证/核对追加抵押')
  if (g.marginAfterAcceptedLimits !== null && g.marginAfterAcceptedLimits < 0) {
    body.actions.push(
      `保证金压力口径下，抵押+已接受额度相对要求仍差 ${round(-g.marginAfterAcceptedLimits)}；额度不当然等同抵押，需核对追加保证或额度可用性`,
    )
  }
  if (
    lineCollateral.formalDeskNetExposureCny !== null &&
    lineCollateral.formalDeskNetExposureCny > s.acceptedLimit
  ) {
    body.actions.push('业务线正式归属轨迹超本线已接受额度；须先核对共享抵押/额度归属，不直接等同于组级最终超额')
  }
  if (s.flags.some(f => f.code === 'SHARED_COLLATERAL_ALLOCATION_REVIEW')) {
    body.actions.push('共享抵押归属需核对；组级未重复计算')
  }
  if (Object.values(result.basis.prices).some(p => p.fx === null || p.price === null)) {
    body.groupLevel.netExposureCny = null
    body.actions.push('行情/汇率未全部确认；本通报只发送已确认口径，区间留风险经理内参')
    body.unconfirmedFactors = Object.values(result.basis.prices)
      .filter(p => p.fx === null || p.price === null)
      .map(p => ({ security: p.security, missing: p.fx === null ? 'fx' : 'price' }))
  }
  if (!body.actions.length) body.actions.push('继续按基准监控')
  return body
}

function internalBody(suite, attribution, stress) {
  return {
    notice: '以下包含待议额度、调配方案、未知汇率区间和模拟降额结果，仅供风险经理核查，不可直接外发。',
    uncertainty: {
      D7noon: suite.intraday.uncertainty,
      D7close: suite.closeInitial.uncertainty,
    },
    pendingLimits: suite.revised.scopes.map(s => ({
      scope: s.key,
      accepted: s.acceptedLimit,
      pending: s.pendingLimit,
      actualBasis: '仅已接受额度生效',
      counterfactualGroupAssessment: s.counterfactualGroupLimitAssessment,
    })),
    allocationPlans: attribution.collateralDuplication,
    d7ClaimDiagnostics: suite.intraday.claims,
    d8ClaimDiagnostics: suite.revised.claims,
    labelTransitions: attribution.labelTransitions,
    capacityReconciliation: attribution.capacityReconciliation,
    stress,
    attribution,
  }
}

export function buildReportBundle(data) {
  const suite = buildScenarioSuite(data)
  const attribution = buildAttribution(data, suite)
  const stress = buildStress(data, suite)
  const policy = policyRef(suite.revised)

  const sent = []
  const corrections = []
  const drafts = []

  for (const d of data.distributions) {
    const recipientScope = { group: d.group, desk: d.desk }
    const revision = Number(d.revision ?? 1)
    if (d.state === '已送') {
      const useNoon = d.mode.includes('日中')
      const initialResult = useNoon ? suite.intraday : suite.closeInitial
      const sentId = `${d.report}-R${revision}`
      sent.push({
        messageId: sentId,
        sourceReport: d.report,
        revision,
        kind: 'initial',
        status: '已送',
        provenance: 'distributions.json 记录已送状态；数字为按对应日中/收盘证据时点重建的留痕',
        sentCutoff: useNoon ? 'D7T120' : 'D7T590',
        mode: d.mode,
        originalRecipientScope: recipientScope,
        policy: policyRef(initialResult),
        external: externalBody(initialResult, d.group, d.desk, d.mode),
      })
      corrections.push({
        messageId: `${d.report}-R${revision + 1}-CORRECTION`,
        sourceReport: d.report,
        revision: revision + 1,
        kind: 'correction',
        status: '待按原范围更正发送',
        corrects: [sentId],
        recipientScope,
        originalRecipientScope: recipientScope,
        routingNote: `按 ${d.report} 原收件范围 ${d.group}/${d.desk} 更正，不扩发其他业务线`,
        arrivalEvents: ['Q5', 'Q6', 'D8权属/合同事件'],
        policy,
        external: externalBody(suite.revised, d.group, d.desk, '收盘更正'),
      })
    } else {
      drafts.push({
        messageId: `${d.report}-R${revision}-DRAFT`,
        sourceReport: d.report,
        revision,
        kind: 'first-current-report',
        status: d.state,
        recipientScope,
        policy,
        external: externalBody(suite.revised, d.group, d.desk, d.mode),
      })
    }
  }

  const distributedScopes = new Set(data.distributions.map(d => `${d.group}/${d.desk}`))
  for (const s of suite.revised.scopes) {
    if (distributedScopes.has(s.key)) continue
    drafts.push({
      messageId: `N-${s.group}${s.desk}-R1-DRAFT`,
      sourceReport: null,
      revision: 1,
      kind: 'unrelated-group-current-report',
      status: '新报草稿',
      recipientScope: { group: s.group, desk: s.desk },
      policy,
      external: externalBody(suite.revised, s.group, s.desk, '收盘组级'),
    })
  }

  return {
    generatedFor: 'D8T560 收盘更正与补签同时到达后的通报截止演练',
    policy,
    sentLedger: sent,
    corrections,
    drafts,
    sendableBundle: {
      notice: '以下仅含可外发汇总；未知区间、待议额度反事实和调配方案不在其中。',
      messages: [...corrections, ...drafts].map(m => ({
        messageId: m.messageId,
        sourceReport: m.sourceReport,
        status: m.status,
        recipientScope: m.recipientScope,
        corrects: m.corrects,
        external: m.external,
      })),
    },
    riskManagerWorksheet: {
      policy,
      scenarios: {
        intraday: compactResult(suite.intraday),
        closeInitial: compactResult(suite.closeInitial),
        revised: compactResult(suite.revised),
        forwardD9: compactResult(suite.forwardD9),
      },
      attribution,
      stress,
      internalOnly: internalBody(suite, attribution, stress),
    },
  }
}

function compactResult(result) {
  return {
    asOf: result.asOf,
    valuationDay: result.valuationDay,
    contractDay: result.contractDay,
    basis: Object.fromEntries(
      Object.entries(result.basis.prices).map(([k, v]) => [
        k,
        { price: v.price, fx: v.fx, fxRange: v.fxRange, priceEvent: v.priceEvent, priceKind: v.priceKind },
      ]),
    ),
    groups: result.groups,
    scopes: result.scopes.map(s => ({
      key: s.key,
      accounts: s.accounts,
      products: s.products,
      riskLabel: s.riskLabel,
      flags: s.flags,
      gross: s.gross,
      margin: s.margin,
      lineCollateral: s.lineCollateral,
      groupCollateral: { ...s.groupCollateral, items: `[${s.groupCollateral.items?.length ?? 0} items]` },
      lineNetExposure: s.lineNetExposure,
      groupNetExposure: s.groupNetExposure,
      acceptedLimit: s.acceptedLimit,
      pendingLimit: s.pendingLimit,
      lineLimitAssessment: s.lineLimitAssessment,
      groupLimitAssessment: s.groupLimitAssessment,
      counterfactualGroupLimitAssessment: s.counterfactualGroupLimitAssessment,
      rows: s.rows.map(r => ({
        lot: r.lot,
        account: r.account,
        kind: r.kind,
        product: r.product,
        security: r.security,
        units: r.units,
        price: r.price,
        fx: r.fx,
        notionalLocal: r.notionalLocal,
        notional: r.notional,
        margin: r.margin,
        contract: {
          contract: r.contract.contract,
          rate: r.contract.rate,
          commonFloor: r.contract.commonFloor,
          override: r.contract.override,
          effectiveDay: r.contract.effectiveDay,
          credentialChain: r.contract.credentialChain,
          isRollover: r.contract.isRollover,
        },
      })),
    })),
    collateralRows: result.collateralRows,
    claims: result.claims,
    uncertainty: result.uncertainty,
  }
}

export function renderMarkdown(bundle) {
  const r = bundle.riskManagerWorksheet.scenarios.revised
  const attr = bundle.riskManagerWorksheet.attribution
  const lines = []
  lines.push('# 保证金政策压力演练分析报告（合成数据）')
  lines.push('')
  lines.push(`> ${bundle.generatedFor}`)
  lines.push(`> 政策哈希：\`${bundle.policy.hash}\`；采用条款：${bundle.policy.rules.join(', ')}`)
  lines.push('')
  lines.push('## 1. 结论')
  lines.push('')
  lines.push(
    `- 新增持仓 L2/L4 在 D7 更正行情上的市值合计 ${attr.composition.newComposition.notionalCny}，保证金要求 ${attr.composition.newComposition.marginCny}；相对 K1 参数(1/1.15)，K2 参数带来的保证金要求减少为 **${attr.policyParameterEffect.totalMarginRequirementReliefVsK1}**。这是政策参数影响。`,
  )
  lines.push(
    `- L3 是续期且凭据链为 ${attr.composition.rollover.credentialChains[0]?.chain.join(' <- ')}，不是新增融资；若误算为新增，会虚增 ${attr.composition.rollover.falseNewExposureIfMistaken} 敞口。`,
  )
  const d = attr.collateralDuplication
  lines.push(
    `- C1 同一 pledge 被 G1/D1(P1=18) 与 G1/D2(P2=16) 同时按全额申报：申报合计 ${d.simultaneousG1ClaimUnits} 份，登记/最新证据总额 ${d.registeredUnits} 份，简单口径在 **${d.overcountedScope}** 多计 ${d.excessClaimUnits} 份、约 **${d.claimOverstatement.claimOverlapValue}**；若两线各计整笔，则重复 ${d.fullDuplicateUnits} 份、${d.fullDuplicateValue}。`,
  )
  const g1 = r.groups.find(g => g.group === 'G1')
  const g2 = r.groups.find(g => g.group === 'G2')
  const g3 = r.groups.find(g => g.group === 'G3')
  lines.push(
    `- D7 更正基准 + D8 权属证据后：G1 组净敞口 ${g1.netExposure.value} / 已接受额度 ${g1.acceptedLimit}，未兑现 ${g1.limitAssessment.undrawn}，但共享抵押业务线归属需复核；G2 净敞口 ${g2.netExposure.value} / ${g2.acceptedLimit}，净敞口超额 ${g2.limitAssessment.excess}，保证金缺口 ${g2.marginShortfall.value} 经已接受额度后余缺为 ${g2.marginAfterAcceptedLimits}（负数表示仍缺 ${round(-g2.marginAfterAcceptedLimits)}），为需复核高风险组；G3 净敞口 ${g3.netExposure.value}，无已接受额度，待议 120 未按实际变更处理。`,
  )
  lines.push('')
  lines.push('## 2. D7 更正基准上的组级口径')
  lines.push('')
  lines.push('| 组 | 总敞口 | 抵押(只计一次) | 净敞口 | 保证金要求 | 保证金缺口 | 已接受额度 | 未兑现 | 净敞口超额 | 额度后保证金余缺 |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const g of r.groups) {
    lines.push(
      `| ${g.group} | ${g.gross.value} | ${g.collateral.value} | ${g.netExposure.value} | ${g.margin.value} | ${g.marginShortfall.value} | ${g.acceptedLimit} | ${g.limitAssessment.undrawn} | ${g.limitAssessment.excess} | ${g.marginAfterAcceptedLimits} |`,
    )
  }
  lines.push('')
  lines.push('## 3. 日中→收盘→更正后的标签变化')
  lines.push('')
  lines.push('| 组 | D7日中 | D7收盘初值 | D8更正/回执后 | 已接受额度未兑现 | 需复核 |')
  lines.push('|---|---|---|---|---:|---|')
  for (const t of attr.labelTransitions) {
    const close = attr.timeline.find(x => x.scenario === 'closeInitial').groups.find(g => g.group === t.group)
    const revised = attr.timeline.find(x => x.scenario === 'revised').groups.find(g => g.group === t.group)
    lines.push(
      `| ${t.group} | ${t.intradayLabel} | ${close.riskLabel} | ${t.revisedLabel} | ${t.undrawn ?? '?'} | ${t.reviewRequired ? '是' : '否'} |`,
    )
  }
  lines.push('')
  lines.push('## 4. 固定基准后的变化归因')
  lines.push('')
  lines.push(`- 客户合同覆盖层相对统一下限多增加保证金：${attr.contractOverrideLayer.customerOverrideAddsCny}。`)
  lines.push(`- X 收盘更正 9→10 在同一 D7 基准上增加敞口 ${attr.quoteCorrectionEffect.xPriceCorrectionTotal}、保证金 ${attr.quoteCorrectionEffect.xMarginCorrectionTotal}；Y 原汇率未知，Q6 只把未知区间确认为 0.9，不能编造原单点差额。`)
  lines.push(`- K4 在 D8:560 已签认但 D9 才生效；D7 当前口径不适用。D9 同行情反事实下 L3 保证金减少 ${attr.futureContractEffect.totalFutureMarginReduction}。`)
  lines.push('')
  lines.push('## 5. 压力档（风险经理内参）')
  lines.push('')
  lines.push('| 档位 | G1 净/超额 | G2 净/超额 | G3 净/超额 |')
  lines.push('|---|---:|---:|---:|')
  for (const t of bundle.riskManagerWorksheet.stress) {
    const cell = g => {
      const x = t.groups.find(z => z.group === g)
      return `${x.netExposure}/${x.limitExcess}`
    }
    lines.push(`| ${t.id} ${t.label} | ${cell('G1')} | ${cell('G2')} | ${cell('G3')} |`)
  }
  lines.push('')
  lines.push('## 6. 通报与更正路由')
  lines.push('')
  for (const m of bundle.sentLedger) {
    lines.push(`- 已送 ${m.messageId} → ${m.originalRecipientScope.group}/${m.originalRecipientScope.desk}，政策哈希 ${m.policy.hash}`)
  }
  for (const m of bundle.corrections) {
    lines.push(`- 更正 ${m.messageId} 更正 ${m.corrects.join(',')}，仍发原范围 ${m.originalRecipientScope.group}/${m.originalRecipientScope.desk}`)
  }
  for (const m of bundle.drafts) {
    lines.push(`- ${m.status} ${m.messageId} → ${m.recipientScope.group}/${m.recipientScope.desk}`)
  }
  lines.push('')
  lines.push('> 未知汇率区间、P1/P2 调配方案、待议额度反事实及压力明细见 `risk-manager-worksheet.json`，不得作为已确认事实外发。')
  return lines.join('\n')
}
