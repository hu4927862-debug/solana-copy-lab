# Solana Copy Lab

[![Offline checks](https://github.com/hu4927862-debug/solana-copy-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/hu4927862-debug/solana-copy-lab/actions/workflows/ci.yml) [![Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) [![Node 24+](https://img.shields.io/badge/node-24%2B-43853d)](package.json)

**先看懂钱包交易，再研究是否跟随。**

面向 Solana 钱包活动的离线研究工具：保守的 swap 分类、精确整数金额、Paper 记账、持久化风险门槛，以及可复现的证据报告。

[English](README.md) · [快速开始](#快速开始) · [代码导航](#代码导航) · [参与贡献](#参与贡献)

![Solana Copy Lab 架构：交易输入经过标准化和保守分类，随后进入 Paper 风险、记账和证据报告。离线演示仅运行到分类。](docs/assets/overview.svg)

## 为什么做这个工具

Token 余额变化可能来自 swap、转账、租金、手续费或流动性操作。没有弄清原因就把变化当成跟随信号，容易得出错误结论。把 quote 当成 Paper 成交，也无法回答真实执行成本和落地结果。

Solana Copy Lab 把这些区别放到可检查的代码和证据中。你可以用它开发交易分析工具、复现解码错误、检查 Paper 仓位记账，以及判断研究结论是否有足够证据。

## 快速开始

使用 **Node.js 24 或更新版本**，以及 `package.json` 固定的 **pnpm 11.22.0**。如果 Node 安装提供 Corepack，可使用 `corepack pnpm` 读取该版本；否则通过你常用的包管理方式安装指定 pnpm 版本。

```sh
git clone https://github.com/hu4927862-debug/solana-copy-lab.git
cd solana-copy-lab
pnpm install --frozen-lockfile
pnpm demo
pnpm test
pnpm typecheck
pnpm build
```

安装会下载依赖。之后演示和默认测试在本机运行，不需要 RPC 凭据或钱包。测试使用固定 fixtures、临时 SQLite 数据库，以及部分案例需要的本机模拟服务。`better-sqlite3` 是原生依赖；请保留允许其构建的 `pnpm-workspace.yaml`。

### 演示会输出什么

`pnpm demo` 将五个**合成交易**交给现有 normalizer 和 classifier，输出 JSON：

| 案例                                         | 输出                                      |
| -------------------------------------------- | ----------------------------------------- |
| 支出 SOL、收到 token 的 swap                 | `ACCEPT`、`BUY`                           |
| 支出 token、收到 SOL 的 swap                 | `ACCEPT`、`SELL`                          |
| token 数量超过 JavaScript 安全整数上限的 BUY | 精确原始数量 `"9007199254740993"`         |
| 普通 token 转账                              | `REJECT`、`ORDINARY_TRANSFER` 与可读原因  |
| 失败交易                                     | `REJECT`、`TRANSACTION_FAILED` 与可读原因 |

解码器内部使用 `bigint`，JSON 中使用十进制字符串。演示不打开数据库，不导入网络、signer、采集器或封存 Research owner。被接受的 BUY 是解码结果，不是交易指令。

## 可以复用什么

| 能力                      | 入口                                                                 | 含义与限制                                                          |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 标准化交易、识别 swap     | [`src/decoder`](src/decoder)、[`test/fixtures`](test/fixtures)       | 结合 signer、资产变化与允许的 swap 证据；拒绝不支持或有歧义的情况。 |
| 检查金额与 Paper 风险决策 | [`src/copy`](src/copy)、[`src/risk`](src/risk)                       | 确定性跟随策略、敞口限制、时效和 provider 健康门槛。                |
| Paper 仓位记账与中断恢复  | [`src/persistence`](src/persistence)、[`src/recovery`](src/recovery) | SQLite 状态、reservation、fill 应用与重启测试。                     |
| 审阅研究证据              | [`src/strategy-evaluation`](src/strategy-evaluation)                 | 成本完整性、round trip、可比性、缺失证据与确定性报告。              |
| 调查 provider 行为        | [`src/network`](src/network)、[`src/stream`](src/stream)             | 传输、请求节奏与流恢复代码；联网使用需要另行配置。                  |

固定 fixture 集合同时包含合成案例与最小化的历史快照，来源说明见 [fixture provenance](test/fixtures/README.md)。演示只使用合成案例。

## 证据边界

- 解码器接受交易，表示受支持的交易证据满足分类规则，不代表它是合格 FOLLOW 或安全的跟随交易。
- Paper fill 使用明确的模型。Quote 不是已落地成交，Paper 记账不是真实已实现收益。
- 缺失成本与结果必须明确保留。结论可以是 `INSUFFICIENT_EVIDENCE`；未知值不能当成零。
- 公开快照不证明 alpha、盈利、完整无人值守运行或资金权限。开源不会重启采集器或启动实盘。

### 实验性执行源码

`src/live` 与 `src/autonomous` 保留实验性的交易审查、执行、签名策略和责任处理源码，供阅读检查。它们不在默认公开测试范围内。**不附带**私有运行证据、固定的封存 Research 依赖闭包、signer 凭据或程序证明二进制文件。

Fresh clone 无法完成历史自主 runtime 检查或执行该部署。TypeScript build 成功只说明源码编译通过；它不会补齐封存闭包、复制全部运行资产、证明执行资格或授予资金权限。请将这些模块视为实验性源码，不是可直接启动的交易机器人。

## 更多本地命令

```sh
# 默认离线测试的各个部分
pnpm test:fixtures
pnpm test:unit
pnpm test:integration
pnpm test:recovery

# 一个固定合成 fixture 的本地解码与分类耗时
pnpm benchmark:latency

# SQLite 只读报告与确定性输出验证
pnpm exec vitest run test/integration/deterministic-evidence-report-workflow.test.ts
```

Benchmark 测量本地解码与分类耗时，不是网络或交易执行延迟。报告测试检查输入数据库没有变化、重复输出字节一致，以及缺少证据时保留不足证据结论。

对于你自己的不可变 Paper SQLite 快照，[`scripts/evaluate-strategies.ts`](scripts/evaluate-strategies.ts) 可以生成 JSON 与 Markdown 报告。[`config/strategy-evaluation.example.json`](config/strategy-evaluation.example.json) 是请求模板，使用前必须替换数据库、时间窗口、身份和策略绑定；仓库没有附带已填充的研究数据库。

## 代码导航

```text
src/decoder/              交易标准化与分类
src/domain/               精确金额、事件与共享契约
src/copy/ + src/risk/      Paper 决策与准入限制
src/persistence/          SQLite 状态与 migrations
src/recovery/             回放、中断与退出恢复
src/strategy-evaluation/  证据读模型、指标与报告
src/live/ + autonomous/   实验性执行源码，限制见上文
test/                     离线 unit、integration、recovery 与 fixtures
scripts/demo-offline.ts   五个合成案例，仅输出 stdout
```

## 参与贡献

优先让现有工具更容易理解和复现：

- 添加最小化 decoder fixture，说明来源与预期分类或拒绝原因。
- 完善重复事件、精度、费用与中断状态下的记账和恢复案例。
- 让报告和文档更清楚地表达缺失证据与不支持的情况。
- 改善跨平台安装、可读示例与 CI 可复现性。

提交 issue 时附输入结构、预期行为、实际输出以及 Node/pnpm 版本，移除凭据、signer 材料和私有运行记录。保持修改范围清晰，运行 `pnpm test`、`pnpm typecheck` 和 `pnpm build`。算法、执行范围或资金权限的变更需要单独的设计讨论。

## 许可证

[Apache 2.0](LICENSE)。
