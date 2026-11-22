# 融资口径调整的压力归因与风险简报

合成金额用记账单位表示。行情按 t 和源证据取当时版本。limit 是通过内部演练已确认的额度。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

额度和保证金为模拟记账值。政策生效由 from_date 决定，当日先使用已签认的适用合同；把证券份数乘市场单位价，再以币种折算。共享凭证总份数同时约束相同 pledge 下的多个组合。

- `accounts.json` 记录字段为 `account`、`group`、`desk`、`product`。
- `holdings.json` 记录字段为 `lot`、`account`、`units`、`opened`、`kind`、`contract`、`security`。
- `policy.json` 记录字段为 `rule`、`from_date`、`common_floor`、`override`、`scope`。
- `collateral.json` 记录字段为 `pledge`、`groups`、`security`、`units`、`currency`、`share`、`state`、`asof`。
- `quotes.json` 记录字段为 `t`、`security`、`first`、`close`、`fx`、`min`、`max`。
- `limits.json` 记录字段为 `group`、`desk`、`limit`、`state`、`asof`。
- `distributions.json` 记录字段为 `report`、`group`、`desk`、`revision`、`mode`、`state`。

- `contract_events.json` 记录字段为 `contract`、`lot`、`account`、`kind`、`signed_day`、`signed_minute`、`effective_day`、`prior_contract`。
- `valuation_events.json` 记录字段为 `event`、`valuation_day`、`reported_day`、`minute`、`security`、`kind`、`unit_price`、`fx`。
- `pledge_requests.json` 记录字段为 `request`、`pledge`、`group`、`desk`、`units`、`asof`、`state`。

contract_events 分别记录签认和生效日期。valuation_events 中 minute 为报送日期的市场当日分钟，valuation_day 指向被估值的日期。pledge_requests 为机构申报及权属回执，申报量和已分配量分别登记。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
