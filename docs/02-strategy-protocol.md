# 统一策略描述协议

版本：1.0  
协议标识：`strategy-spec/1.0`

## 1. 目的

统一策略描述协议是产品的核心合同。自然语言输入、结构化表单、规则摘要、回测引擎和版本比较都必须读写同一份协议对象。

协议只表达“做什么”，不包含具体程序代码。任何无法被协议明确表达的想法，都不能直接进入回测。

## 2. 设计原则

- 明确：每个字段只有一种含义。
- 完整：影响结果的条件都必须显式保存。
- 可验证：字段类型、范围和字段间关系可以自动检查。
- 可升级：字段变化通过协议版本管理。
- 可复现：策略协议与数据快照、引擎版本共同确定结果。
- 可阅读：机器字段必须能够生成普通用户可读的规则摘要。

## 3. 顶层结构

| 字段 | 类型 | 必填 | 含义 |
|---|---|---:|---|
| `schema_version` | 字符串 | 是 | 固定为 `strategy-spec/1.0` |
| `strategy` | 对象 | 是 | 策略基本信息 |
| `market` | 对象 | 是 | 市场和计价设置 |
| `universe` | 对象 | 是 | 候选股票范围 |
| `eligibility` | 对象 | 是 | 每个信号日的可选条件 |
| `signals` | 对象 | 是 | 筛选、排序和入选规则 |
| `schedule` | 对象 | 是 | 信号与执行日程 |
| `portfolio` | 对象 | 是 | 持仓和权重规则 |
| `execution` | 对象 | 是 | 成交与容量假设 |
| `costs` | 对象 | 是 | 费用方案 |
| `benchmark` | 对象 | 是 | 比较基准 |
| `research` | 对象 | 是 | 研究区间、预热期和样本划分 |
| `metadata` | 对象 | 是 | 创建来源、备注和标签 |

## 4. 字段规范

### 4.1 策略基本信息 `strategy`

| 字段 | 类型 | 规则 |
|---|---|---|
| `name` | 字符串 | 1 至 60 个字符 |
| `description` | 字符串 | 最多 500 个字符 |
| `base_version_id` | 字符串或空 | 从已有版本创建时填写 |
| `template_id` | 字符串或空 | 从模板开始时填写 |

### 4.2 市场设置 `market`

首版固定值：

```json
{
  "market": "CN_STOCK",
  "currency": "CNY",
  "calendar": "CN_EXCHANGE",
  "price_frequency": "1d",
  "position_direction": "long_only"
}
```

### 4.3 股票范围 `universe`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `exchanges` | 数组 | `SH,SZ` | 首版只允许这两个值 |
| `boards` | 数组 | 主板、创业板、科创板 | 可以排除其中任一板块 |
| `membership` | 字符串 | `all_eligible` | 可改为已接入指数的历史成分 |
| `membership_code` | 字符串或空 | 空 | 使用指数范围时必填 |
| `min_listed_days` | 整数 | 120 | 信号日已上市自然日数 |

指数范围必须按当时有效的成分表判断，不能用当前成分替代历史成分。

### 4.4 可选条件 `eligibility`

| 字段 | 默认值 | 含义 |
|---|---|---|
| `normal_status_only` | `true` | 排除风险警示、暂停上市和整理期股票 |
| `exclude_suspended` | `true` | 信号日停牌的股票不进入新候选 |
| `exclude_price_limited_at_signal` | `false` | 信号日触及价格限制仍可入选，执行日再判断能否成交 |
| `min_price` | `2.0` | 信号日收盘价下限，单位元 |
| `min_avg_turnover_20d` | `20000000` | 前 20 个交易日平均成交额下限，单位元 |
| `missing_value_policy` | `exclude` | 筛选或排序字段为空时排除该股票 |

### 4.5 信号规则 `signals`

`filters` 是筛选条件数组。首版所有条件使用“全部满足”关系。

每个筛选条件包含：

| 字段 | 允许值或规则 |
|---|---|
| `field` | 指标目录中的稳定字段编号 |
| `operator` | `gt`、`gte`、`lt`、`lte`、`between`、`top_pct`、`bottom_pct` |
| `value` | 单值或双值数组，与指标单位一致 |
| `as_of` | 固定为 `signal_date` |
| `null_policy` | 首版固定为 `exclude` |

`ranking` 是排序条件数组，最多三项：

| 字段 | 说明 |
|---|---|
| `field` | 指标字段编号 |
| `direction` | `asc` 或 `desc` |
| `weight` | 0 至 1；多指标排序时合计必须为 1 |
| `winsorize` | 是否按截面 1% 和 99% 分位缩尾 |
| `normalize` | 首版固定为截面百分位排名 |

多指标排序分数计算：

1. 对每个指标做截面缩尾。
2. 根据排序方向转换为 0 至 1 的百分位分数，越大越优。
3. 各指标百分位分数乘以权重后求和。
4. 总分相同时，依次按证券编号升序排列，确保结果稳定。

`selection` 字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `method` | `top_n` | 首版固定选择排名靠前的若干只 |
| `count` | `20` | 1 至 100 |
| `buffer_count` | `5` | 额外保留候补数量，0 至 20 |

### 4.6 日程 `schedule`

| 字段 | 默认值 | 允许值 |
|---|---|---|
| `rebalance_frequency` | `monthly` | `daily`、`weekly`、`monthly` |
| `rebalance_day` | `last_trading_day` | 周频可选星期；月频可选首个或最后一个交易日 |
| `signal_time` | `close` | 首版固定为收盘后 |
| `execution_time` | `next_open` | 首版固定为下一个交易日开盘 |
| `missed_execution_policy` | `next_trading_day` | 最多顺延三个交易日，之后取消该笔调整 |

时间含义：在信号日收盘数据完整后计算股票范围和目标权重，最早在下一个交易日开盘执行。当天收盘后才公布的信息，最早从下一个交易日开始使用。

### 4.7 组合规则 `portfolio`

| 字段 | 默认值 | 规则 |
|---|---|---|
| `initial_cash` | `1000000` | 大于 0，单位元 |
| `weighting` | `equal` | 首版支持 `equal`、`score`、`inverse_volatility` |
| `max_position_weight` | `0.10` | 0.01 至 1 |
| `max_industry_weight` | `0.30` | 0.05 至 1 |
| `cash_reserve` | `0.02` | 0 至 0.20 |
| `min_trade_amount` | `1000` | 小于该金额不调整 |
| `odd_lot_policy` | `keep_until_sell` | 买入按市场最小单位，卖出允许处理剩余零股 |
| `rebalance_threshold` | `0.005` | 目标权重与当前权重差小于该值时不调整 |

权重分配顺序：

1. 根据 `weighting` 计算原始目标权重。
2. 应用单只权重上限，多余权重在未达上限的股票间重新分配。
3. 应用行业权重上限，多余权重转为现金，不跨行业再次分配。
4. 扣除现金保留比例。
5. 按最小交易单位取整，剩余金额保留为现金。

### 4.8 执行规则 `execution`

| 字段 | 默认值 | 说明 |
|---|---|---|
| `price` | `next_open` | 使用执行日开盘价作为基础价 |
| `slippage_bps` | `5` | 买入加、卖出减，单位为万分之一 |
| `max_participation_rate` | `0.05` | 单只股票单次金额不超过此前 20 日平均成交额的 5% |
| `price_limit_policy` | `no_fill_when_locked` | 开盘价封在不利方向价格限制且无可用成交空间时不成交 |
| `suspension_policy` | `defer_3_days` | 最多顺延三个交易日 |
| `sell_before_buy` | `true` | 同一执行日先卖后买 |

容量判断只使用执行日前已经完整形成的数据。日频数据无法准确还原开盘时段的排队情况，因此报告必须把该成交模型列为假设。

### 4.9 费用 `costs`

| 字段 | 默认值 | 说明 |
|---|---|---|
| `commission_bps` | `3` | 双边佣金，单位为万分之一 |
| `minimum_commission` | `5` | 每笔最低佣金，单位元 |
| `tax_schedule` | `cn_stock_statutory` | 按成交日期匹配内置税费表 |
| `transfer_fee_schedule` | `cn_stock_statutory` | 按成交日期和市场匹配内置过户费表 |

内置法定费率表必须带生效日期。历史运行使用对应日期的费率，不使用当前费率覆盖全部历史区间。

### 4.10 比较基准 `benchmark`

| 字段 | 默认值 | 说明 |
|---|---|---|
| `code` | `000300_TR` | 沪深 300 全收益口径 |
| `rebased_to` | `1.0` | 在研究起始日归一化 |
| `cash_return` | `0` | 首版默认现金不计收益，可配置年化值 |

### 4.11 研究设置 `research`

| 字段 | 默认值 | 规则 |
|---|---|---|
| `start_date` | `2015-01-01` | 不早于所需字段的可靠起始日期 |
| `end_date` | 最近完整交易日 | 不允许选择未来日期 |
| `warmup_trading_days` | `252` | 不计入结果，只用于指标预热 |
| `sample_split.enabled` | `true` | 默认启用样本划分 |
| `sample_split.in_sample_ratio` | `0.70` | 按交易日数量划分前 70% |
| `sample_split.out_sample_ratio` | `0.30` | 后 30%，两者合计为 1 |
| `risk_free_rate_annual` | `0.02` | 计算夏普比率使用的年化无风险收益 |

## 5. 完整示例

以下示例表示：在沪深普通股票中排除上市不足 120 天和流动性不足的股票，选择估值较低、盈利质量较高且中期表现较强的股票，每月调整，持有 20 只。

```json
{
  "schema_version": "strategy-spec/1.0",
  "strategy": {
    "name": "质量价值趋势组合",
    "description": "质量、估值和中期表现的综合排序",
    "base_version_id": null,
    "template_id": null
  },
  "market": {
    "market": "CN_STOCK",
    "currency": "CNY",
    "calendar": "CN_EXCHANGE",
    "price_frequency": "1d",
    "position_direction": "long_only"
  },
  "universe": {
    "exchanges": ["SH", "SZ"],
    "boards": ["main", "chinext", "star"],
    "membership": "all_eligible",
    "membership_code": null,
    "min_listed_days": 120
  },
  "eligibility": {
    "normal_status_only": true,
    "exclude_suspended": true,
    "exclude_price_limited_at_signal": false,
    "min_price": 2.0,
    "min_avg_turnover_20d": 20000000,
    "missing_value_policy": "exclude"
  },
  "signals": {
    "filters": [
      {
        "field": "roe_ttm",
        "operator": "gte",
        "value": 0.10,
        "as_of": "signal_date",
        "null_policy": "exclude"
      },
      {
        "field": "pe_ttm",
        "operator": "between",
        "value": [0, 30],
        "as_of": "signal_date",
        "null_policy": "exclude"
      }
    ],
    "ranking": [
      {
        "field": "pe_ttm",
        "direction": "asc",
        "weight": 0.4,
        "winsorize": true,
        "normalize": "percentile"
      },
      {
        "field": "roe_ttm",
        "direction": "desc",
        "weight": 0.3,
        "winsorize": true,
        "normalize": "percentile"
      },
      {
        "field": "return_120d_skip_20d",
        "direction": "desc",
        "weight": 0.3,
        "winsorize": true,
        "normalize": "percentile"
      }
    ],
    "selection": {
      "method": "top_n",
      "count": 20,
      "buffer_count": 5
    }
  },
  "schedule": {
    "rebalance_frequency": "monthly",
    "rebalance_day": "last_trading_day",
    "signal_time": "close",
    "execution_time": "next_open",
    "missed_execution_policy": "next_trading_day"
  },
  "portfolio": {
    "initial_cash": 1000000,
    "weighting": "equal",
    "max_position_weight": 0.10,
    "max_industry_weight": 0.30,
    "cash_reserve": 0.02,
    "min_trade_amount": 1000,
    "odd_lot_policy": "keep_until_sell",
    "rebalance_threshold": 0.005
  },
  "execution": {
    "price": "next_open",
    "slippage_bps": 5,
    "max_participation_rate": 0.05,
    "price_limit_policy": "no_fill_when_locked",
    "suspension_policy": "defer_3_days",
    "sell_before_buy": true
  },
  "costs": {
    "commission_bps": 3,
    "minimum_commission": 5,
    "tax_schedule": "cn_stock_statutory",
    "transfer_fee_schedule": "cn_stock_statutory"
  },
  "benchmark": {
    "code": "000300_TR",
    "rebased_to": 1.0,
    "cash_return": 0
  },
  "research": {
    "start_date": "2015-01-01",
    "end_date": "latest_complete_trading_day",
    "warmup_trading_days": 252,
    "risk_free_rate_annual": 0.02,
    "sample_split": {
      "enabled": true,
      "in_sample_ratio": 0.70,
      "out_sample_ratio": 0.30
    }
  },
  "metadata": {
    "created_from": "conversation",
    "tags": ["质量", "价值", "趋势"],
    "note": "首轮验证版本"
  }
}
```

## 6. 自动校验规则

### 6.1 阻止运行

- 缺少任何必填字段。
- 研究开始日不早于结束日。
- 排序权重合计与 1 的差大于 `0.000001`。
- 最大单只权重乘以持仓数量仍不足以分配目标股票仓位。
- 行业上限小于单只权重上限。
- 指标数据起始日期晚于研究开始日且预热期无法满足。
- 指数范围或比较基准没有覆盖研究区间。
- 使用首版不支持的市场、频率、方向或逻辑组合。

### 6.2 需要确认

- 预计平均持仓少于五只。
- 单一行业上限高于 50%。
- 滑点为 0。
- 费用明显低于系统默认值。
- 研究区间少于三个自然年。
- 参数试验任务数超过 20。

### 6.3 信息提示

- 实际持仓可能因最小交易单位、成交条件或行业上限少于目标数量。
- 研究区间跨越税费调整日期。
- 样本外区间少于 500 个交易日。

## 7. 版本与校验值

保存策略版本时按以下规则生成稳定校验值：

1. 移除仅用于展示且不影响计算的字段，如描述、标签和备注。
2. 对对象字段按字段名升序排列，数组保持业务顺序。
3. 数值使用十进制定点表达，禁止保存非数字值。
4. 日期统一为 `YYYY-MM-DD`。
5. 对规范化后的文本生成 SHA-256 校验值。

策略版本记录至少包含：协议原文、规范化文本、校验值、协议版本、创建时间和创建者编号。

## 8. 协议升级

- 新增可选字段且旧引擎可以忽略时，提升次版本。
- 修改字段含义、默认值或计算顺序时，提升主版本。
- 历史版本始终保留原协议，不在读取时静默改写。
- 升级必须生成迁移预览，由用户确认后保存为新策略版本。
