import { num, eventTime, asOfKey, dayNumber } from './util.js'

/**
 * 选择估值日的点在市证据。
 * asOf 同时约束报送日/分钟；晚到的更正只会在其报送时点后被选中。
 */
export function marketBasis(data, options = {}) {
  const valuationDay = options.valuationDay ?? 'D7'
  const cutoff = asOfKey(options.marketAsOf ?? options.asOf)
  const securities = [...new Set(data.quotes.map(q => q.security))]
  const result = {
    valuationDay,
    cutoff: options.marketAsOf ?? options.asOf ?? 'LATEST',
    prices: {},
    sources: [],
    gaps: [],
  }

  for (const security of securities) {
    const events = data.valuation_events
      .filter(e => e.security === security && e.valuation_day === valuationDay)
      .filter(e => eventTime(e) <= cutoff)
      .sort((a, b) => eventTime(b) - eventTime(a) || String(b.event).localeCompare(String(a.event)))

    const quote = data.quotes.find(q => q.t === valuationDay && q.security === security) ?? null
    const selected = events[0] ?? null

    const rawMin = quote ? num(quote.min) : null
    const rawMax = quote ? num(quote.max) : null
    const first = quote ? num(quote.first) : null
    const close = quote ? num(quote.close) : null

    let price = selected ? num(selected.unit_price) : null
    let fx = selected ? num(selected.fx) : null
    if (price === null && quote) {
      // 没有事件证据时，quote 行只作为表内快照；优先 close，其次 first。
      price = num(quote.close) ?? num(quote.first)
    }
    if (fx === null && quote) fx = num(quote.fx)

    const priceInRange =
      price !== null && rawMin !== null && rawMax !== null && price >= rawMin && price <= rawMax
    const quotePriceInRange =
      (first !== null && first >= rawMin && first <= rawMax) ||
      (close !== null && close >= rawMin && close <= rawMax)

    // 给定合成资料中 Y 的 min/max 是未知汇率的异常区间；
    // 用“未知 fx 且区间围绕 1”识别，避免把 0.85 当成 Y 的单价。
    const fxRange =
      fx === null && rawMin !== null && rawMax !== null && rawMin <= 1 && rawMax >= 1
        ? [rawMin, rawMax]
        : null

    const priceRange =
      rawMin !== null &&
      rawMax !== null &&
      (priceInRange || quotePriceInRange) &&
      !(fxRange && rawMax <= 5)
        ? [rawMin, rawMax]
        : null

    const basis = {
      security,
      price,
      fx,
      fxKnown: fx !== null,
      priceEvent: selected?.event ?? null,
      priceKind: selected?.kind ?? (quote ? 'quote_snapshot' : null),
      fxEvent: selected?.event ?? null,
      quote: quote ? { t: quote.t, min: rawMin, max: rawMax, first, close } : null,
      abnormal: { min: rawMin, max: rawMax },
      priceRange,
      fxRange,
    }
    result.prices[security] = basis
    if (selected) result.sources.push(selected.event)
    if (fx === null) {
      result.gaps.push({
        security,
        field: 'fx',
        reason: fxRange ? '汇率未知；仅有来源异常区间' : '汇率未知且无区间',
        fxRange,
      })
    }
    if (price === null) {
      result.gaps.push({ security, field: 'price', reason: '无可用价格' })
    }
  }

  return result
}

export function factorForCurrency(currency, basis) {
  if (currency === 'CNY') return 1
  return basis?.fx ?? null
}

export function intervalValue(coefficient, basis, { currency } = {}) {
  // coefficient 已含 units * price，正负均可。
  const fx = currency === 'CNY' ? 1 : basis?.fx
  if (fx !== null && fx !== undefined) {
    const value = coefficient * fx
    return { value, low: value, high: value, confirmed: true }
  }
  const range = basis?.fxRange
  if (range) {
    const vals = range.map(r => coefficient * r)
    return { value: null, low: Math.min(...vals), high: Math.max(...vals), confirmed: false }
  }
  return { value: null, low: null, high: null, confirmed: false }
}

export { dayNumber }
