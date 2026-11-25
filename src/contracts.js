import { num, timeKey, eventTime, dayNumber } from './util.js'

function signedByCutoff(ev, cutoff) {
  return eventTime({ reported_day: ev.signed_day, minute: ev.signed_minute }) <= cutoff
}

export function applicableContract(data, holding, options = {}) {
  const cutoff =
    options.asOf && options.asOf.day
      ? timeKey(options.asOf.day, options.asOf.minute ?? 9999)
      : Number.MAX_SAFE_INTEGER
  const contractDay = dayNumber(options.contractDay ?? options.valuationDay ?? 'D7')

  const events = data.contract_events
    .filter(e => e.lot === holding.lot)
    .filter(e => signedByCutoff(e, cutoff))
    .filter(e => dayNumber(e.effective_day) <= contractDay)
    .sort((a, b) => {
      const da = dayNumber(a.effective_day)
      const db = dayNumber(b.effective_day)
      if (da !== db) return db - da
      return Number(b.signed_minute) - Number(a.signed_minute)
    })

  const event = events[0] ?? null
  const ruleId = event?.contract ?? holding.contract
  const policies = data.policy
    .filter(p => p.rule === ruleId)
    .filter(p => dayNumber(p.from_date) <= (event ? dayNumber(event.effective_day) : contractDay))
    .sort((a, b) => dayNumber(b.from_date) - dayNumber(a.from_date))
  const policy = policies[0] ?? data.policy.find(p => p.rule === ruleId) ?? null

  const commonFloor = policy ? num(policy.common_floor) : null
  const override = policy ? num(policy.override) : null
  const contractRate = commonFloor === null || override === null ? null : Math.max(commonFloor, override)

  const chain = []
  let current = event?.prior_contract
  const seen = new Set([ruleId])
  while (current && current !== '?' && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    const priorEvent = data.contract_events.find(e => e.contract === current && e.lot === holding.lot)
    current = priorEvent?.prior_contract
  }

  return {
    lot: holding.lot,
    contract: ruleId,
    eventKind: event?.kind ?? null,
    eventId: event ? `${event.contract}/${event.lot}/${event.signed_day}:${event.signed_minute}` : null,
    signedDay: event?.signed_day ?? null,
    effectiveDay: event?.effective_day ?? null,
    priorContract: event?.prior_contract ?? null,
    credentialChain: [ruleId, ...chain],
    accountOnEvent: event?.account ?? holding.account,
    accountChanged: Boolean(event && event.account !== holding.account),
    commonFloor,
    override,
    rate: contractRate,
    scope: policy?.scope ?? null,
    isRollover: holding.kind === '续期' || event?.kind === '续期',
    isBackdatedOrSupplementary: event?.kind === '补签',
  }
}

export function policyManifest(data, asOf) {
  const cutoffDay = asOf?.day ? dayNumber(asOf.day) : Number.MAX_SAFE_INTEGER
  return data.policy
    .filter(p => dayNumber(p.from_date) <= cutoffDay)
    .map(p => ({
      rule: p.rule,
      from_date: p.from_date,
      common_floor: num(p.common_floor),
      override: num(p.override),
      effective_rate: Math.max(num(p.common_floor), num(p.override)),
      scope: p.scope,
    }))
}
