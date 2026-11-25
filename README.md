# 融资口径调整的压力归因与风险简报

本项目是无第三方依赖的 Node.js 22 内部分析原型，用来反复导入合成行情、合同事件、账户、抵押和额度资料，完成：

1. **点在市估值与净敞口估算**；
2. **统一下限 / 客户合同覆盖两层保证金计算**；
3. **政策参数、客户合约、资产构成、行情更正和抵押重报的受控归因**；
4. **同一抵押重复申报、共享抵押只计一次的诊断**；
5. **已接受额度 / 待议反事实额度、压力降额和风险标签**；
6. **可外发汇总与风险经理内参分离，以及更正通报的原收件范围路由**。

合成金额用记账单位表示。行情按 `valuation_day`、`reported_day` 和 `minute` 取当时已报送的证据；晚到的收盘更正只在其报送时点后可见。所有资料均为合成记录。源文件中的数字、日期和标记均保留为字符串，`?` 表示来源未能提供该值。

## 运行

```sh
npm ci --offline --ignore-scripts
npm test

# 只做资料读取与引用校验
npm run data:check

# 输出完整 JSON 分析；不加 --out 时写到 stdout
npm run analyze -- --data data --out reports/generated/analysis.json

# 生成通报草稿、外发汇总和风险经理内参
npm run report -- --data data --out reports/generated
```

也可以直接调用：

```js
import { loadDataset } from './src/dataset.js'
import { evaluate } from './src/engine.js'

const data = await loadDataset('/path/to/synthetic-dataset')
const result = evaluate(data, {
  valuationDay: 'D7',
  asOf: { day: 'D8', minute: 560 },
  contractDay: 'D7',
  haircut: 0.1,
})
```

`--data` 可以指向任何包含同名十张表的新合成资料目录，因此适合反复导入不同行情、合同或账户事件。

## 目录

- `data/`：给定合成业务资料。
- `src/dataset.js`：导入、原始字符串检查和引用校验。
- `src/market.js`：点在市行情、未知汇率和来源异常区间。
- `src/contracts.js`：签认/生效时间、合同凭据链和适用保证金条款。
- `src/collateral.js`：同一 `pledge` 的最新证据日拆分、业务线申报和重复计算诊断。
- `src/engine.js`：敞口、保证金、抵押、组/业务线额度和风险标记。
- `src/analysis.js`：关键情景、受控归因和压力档。
- `src/report.js`：外发/内参分离、更正路由和 Markdown 摘要。
- `bin/`：校验、分析和通报生成 CLI。
- `test/`：资料约定和核心业务规则测试。
- `reports/generated/`：最近一次生成的 JSON/Markdown 结果。

## 采用的模拟业务口径

### 1. 合同与政策

- 对每个持仓，先找在截止时点前已经签认、且生效日不晚于 `contractDay` 的合同事件。
- 历史持仓和续期持仓继续使用原签认条款；`kind=续期` 或事件 `kind=续期` 不视为新增融资。
- `prior_contract` 会形成凭据链；即使账户变化，也继续回溯并保留原凭据。
- 补签事件只有在其 `effective_day` 之后才改变适用合同。资料中的 K4 在 `D8:560` 已签认，但 `D9` 才生效，因此不改变 D7 估值日的当前保证金。
- 适用保证金率为：

```text
effective_rate = max(common_floor, override)
margin_requirement = units × market_unit_price × fx × effective_rate
```

这样同时保留“统一下限”和“客户合同覆盖”两层影响。

### 2. 行情与未知因子

- D7 日中 `120` 分取 Q1/Q2：X=12，Y=16 但 FX 未知。
- D7 收盘初次证据取 Q3/Q4：X=9，Y=14 但 FX 仍未知。
- D8 `560` 分后可取 Q5/Q6：D7 基准的 X 更正为 10，Y 的 FX 确认为 0.9。
- `quotes.json` 中 Y 的 `min/max=0.85/1.2` 是未知汇率的来源异常区间；X 的 `min/max=9/12` 是价格异常区间。
- 未知 FX 时不编造单点 CNY 数字，而是报告：
  - 已确认的本币/已知因子金额；
  - 用共同 FX 情景得到的可支持范围；
  - 未确认字段、抵押归属或调配方案。
- `currency=CNY` 的抵押折算因子为 1；`currency=FX` 的抵押使用对应证券行情中的 `fx`。

### 3. 共享抵押和重复申报

- 同一 `pledge` 不按资料版本逐行相加。系统取不晚于截止日的最新 `asof`，并把该证据日的一组拆分string行作为同一笔凭证的归属。
- D8 的 C1 由 `G1=18` 与 `G2=12` 组成，合计仍为 30 份。
- C2 只登记给 G1 且 `share=yes`，在 G1 组级只计一次；没有正式业务线归属时，不把“按证券匹配 D2”的模拟分配当成正式事实。
- P1（G1/D1，18 份）和 P2（G1/D2，16 份）同时按全额申报得到 34 份，超过 C1 的 30 份：
  - 简单申报重叠在 **G1/D1+D2** 多计 4 份；
  - D7 更正基准 X=10 时，约多计 40；
  - 若两条线都把整笔 30 份各自计一次，则整笔 30 份被重复，对应 300。
- D7 尚未收到权属回执时，D1-first、D2-first 都只能作为互斥反事实，不能同时作为已确认调配依据。D8 回执表明其中 12 份归 G2 后，G1 只剩有证据支持的 18 份。

### 4. 额度和风险口径

- `state=已接受` 的额度进入实际组级限额评估。
- `state=待议` 的额度只进入 `counterfactual...` 字段或风险经理内参，不视为实际变更。
- 组级净敞口为：

```text
group_net_exposure = sum(group_holdings_market_value) - group_collateral_counted_once
```

- 额度指标：

```text
drawn     = max(0, group_net_exposure)
undrawn   = max(0, accepted_limit - drawn)
excess    = max(0, drawn - accepted_limit)
```

D7 更正基准和 D8 权属证据下的主要结果：

| 组 | 总敞口 | 抵押（一次） | 净敞口 | 已接受额度 | 未兑现 | 超额 |
|---|---:|---:|---:|---:|---:|---:|
| G1 | 501.6 | 419.4 | 82.2 | 90 | 7.8 | 0 |
| G2 | 252.0 | 120.0 | 132.0 | 110 | 0 | 22 |
| G3 | 250.0 | 434.0 | -184.0 | 0 | 0 | 0 |

G1 组级未破限，但 C2 的业务线归属和 D1/D2 轨迹需复核；G2 为明确超额/高风险组；G3 无已接受额度，120 的待议额度不按实际变更处理。

### 5. 归因可比性

`buildAttribution()` 始终把比较固定在 D7 估值日，避免把 D7 日中价、D7 收盘价、D8 更正价和 D8 当日新行情混在一起。

已分离的影响包括：

- **资产构成**：真正新增的 L2/L4 更正基准市值 352、保证金 334.4；L3 续期不计为新增。
- **政策参数**：同样资产和合同归属下，新增条款 K2（0.8/0.95）相对 K1 参数（1/1.15）减少保证金要求 70.4。
- **统一下限 vs 合同覆盖**：客户 override 相对 common floor 合计增加保证金 138.04。
- **未来合约**：固定 D7 行情，K4 在 D9 适用后使 L3 保证金从 231.84 降至 171.36，减少 60.48；D8 当前通报不应用 K4。
- **行情更正**：同一 D7 基准上 X 9→10 增加敞口 55、保证金 60；Y 的原 FX 未知，Q6 是把区间确认为 0.9，不伪造原单点差额。
- **抵押重报/重复申报**：单独列为抵押诊断，不并入政策效果。

### 6. 压力演练

`buildStress()` 默认生成：

- S0：D7 更正收盘基准；
- H10/H20：对全部抵押模拟降额 10%/20%；
- ABN：使用来源异常区间不利端（X=9、Y FX=0.85）；
- ABN_H10/ABN_H20：异常区间叠加降额。

降额比例是风险经理的模拟动作，不是来源已确认的折扣；结果中会明确标为压力/反事实。

## 通报产物

运行 `npm run report` 后：

- `reports/generated/summary.md`：人读摘要；
- `reports/generated/outbox.json`：已发送的 M1/M3 原始口径、数字和政策哈希；
- `reports/generated/report-ledger.json`：已送、待发更正和新报草稿的完整路由台账；
- `reports/generated/sendable-bundle.json`：可发送的更正/草稿汇总；
- `reports/generated/messages/*.external.json`：单份外发对象；
- `reports/generated/risk-manager-worksheet.json`：完整内参，包括未知区间、待议额度、互斥方案和压力结果；
- `reports/generated/analysis.json`：运行 `npm run analyze` 后得到的完整分析对象。

M1/M3 已有“已送”记录。D8 更正分别生成 `M1-R2-CORRECTION` 和 `M3-R2-CORRECTION`，并保持原收件范围 G1/D1、G2/D2；M2 为待发首报，G3/D1 是无关/无原更正关系组的继续出报草稿。外发对象不包含待议额度反事实、未知区间端点或 P1/P2 调配方案。

## 后续可扩展点

- 加入更多压力档或自定义 haircut/FX/price scenario；
- 把 `outbox.json` 换成真实邮件/IM webhook 适配器；
- 对导入目录增加 JSON Schema 或签名字段校验；
- 若后续资料给出独立折扣表，可把折扣从未知因子接入 `selectCollateral()` 的同一 certainty/range 结构。
