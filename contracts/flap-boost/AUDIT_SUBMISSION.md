# Flap Boost 源码送审说明

准备日期：2026-10-09；同步更新：2026-10-11。此文件描述当前源码候选版本，不能作为第三方审计通过证明。

## 送审范围

- 合约：`src/FlapBoostVault.sol`、`src/FlapBoostVaultFactory.sol`、`src/FlapBoostTypes.sol`。
- UI：`Component.tsx`、`VaultABI.ts`、`manifest.json`、`i18n.json`，单独打包为四文件源码包，保留当前动效。
- 支持网络：BNB Chain 主网 56 和测试网 97；其他 chain ID 拒绝创建 Vault。
- 这是用户自主充值的非税收 Mini App，不是报告中的 StakingBuybackVault。没有质押、推荐、分红、Guardian、Beacon 升级或 VaultPortal 发币业务，不声明 VaultFactory v2.3 合规。
- 第一轮可在所有者充值交易中直接尝试执行；后续通过官方 Trigger 服务串行预约。每个所有者、每个代币只有一份 Vault 与 BNB 共享资金。
- 测试网新增模式 5：一次回购买到的代币按合计 10000 bps 分配到销毁、指定留存钱包、分发。分发目的地二选一：1–5 个固定地址或 1–20 个新生成地址。创建和编辑均校验比例、地址与数量；已预约轮次完成后才应用编辑结果。原模式 4（销毁、固定地址、生成地址）保持不变，主网现有单选操作入口保留。
- Factory 构造时创建独立 `FlapBoostVaultDeployer`，将 Vault 创建字节码从 Factory 运行时分离。部署器只接受 Factory 调用；Vault 中记录的授权 Factory 仍为 Factory 本身。

## 构建与测试

编译配置：Solidity 0.8.26、Cancun、optimizer 200、via IR；OpenZeppelin 4.9.6、forge-std 1.14.0。包内提供 Foundry 配置、remappings、依赖源码及许可证，无需 Git 子模块下载。

在合约包解压目录执行：

```sh
forge build
forge test --no-match-path '*.mainnet.t.sol' -vv
```

本次使用 Foundry 1.8.5、`solc 0.8.26`、Cancun、optimizer 200 和 via IR 编译并运行本地套件；主网 fork 单独标记跳过。

本地套件覆盖功能回归、3 项 fuzz 属性测试（各 200 runs）及 2 项 stateful invariant（各 200 runs、depth 32）。验证原生 BNB 资金守恒、共享预约金额保护、退款、逐次预约收费、失败预约不收费、比例输出、权限及生命周期。

主网 fork 单独运行，不使用私钥、不广播交易：

```sh
RUN_BSC_FORK=true BSC_RPC_URL=https://YOUR_ARCHIVE_RPC BSC_FORK_BLOCK=126364736 \
  forge test --match-path 'test/FlapBoostVault.mainnet.t.sol' -vv
```

PowerShell：

```powershell
$env:RUN_BSC_FORK = 'true'
$env:BSC_RPC_URL = 'https://YOUR_ARCHIVE_RPC'
$env:BSC_FORK_BLOCK = '126364736'
forge test --match-path 'test/FlapBoostVault.mainnet.t.sol' -vv
```

**主网 fork 尚未取得通过结果。** 本次运行被公共 RPC 的历史状态访问限制阻断：官方公共节点返回 missing trie node，PublicNode 返回历史查询需个人凭据。未启用 fork 时使用 `vm.skip(true)` 标记跳过，不将其算作通过。套件意图覆盖真实依赖、BC 首轮与 Trigger 回调、毕业后 DEX 首轮与回调；其中测试专用 Portal 启动 ABI、真实运营角色和状态断言仍须在可用 archive RPC 上实际验证。

## 对参考报告的逐项对应

- R1：本版本最低间隔为 1 分钟，UI 默认 60 分钟，不存在税收池 20 秒循环。后续自动轮次要求回购金额至少为当时 Trigger 费与固定 0.0001 BNB 预约费合计的 10 倍；当前 Trigger 费为 0.0002 BNB 时门槛为 0.003 BNB。低于门槛时暂缓预约，不支付费用。首轮直接执行本身不收预约费；成功预约下一轮时才收费。
- R2：附完整 `test/`、`foundry.toml`、`remappings.txt` 与依赖；补充 200-run fuzz/invariant。主网 fork 未验证属于未完成项，不能据此声称已满足全部规则 006。
- W1：Portal 与 Trigger 已按 chain ID 硬编码，不接收部署者自定义服务地址。主网 Trigger 为 `0xcf4EE25035CF883895110f367F5BA8172416a7F9`，主网 Portal 为 `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`。
- W2：没有公开的 `minOut=0` 超时 swap 路径；每轮使用非零绝对价格底线，固定数量还要求实际收到指定数量。官方 Trigger 状态为 `FAILED` 时，所有者可释放预约并重订；`PENDING` 请求没有超时释放入口，因为官方服务不保证精确执行时间。**固定 BNB / 固定数量模式尚无协议级 BNB 绝对上限；服务长期不回调时预约资金可能持续锁定。**请列入审计范围。
- W3：报告中的推荐抽佣、零地址抽佣及无质押分红流向不适用。此项目的实际信任边界是：所有者能提走所有未预约 BNB；第三方捐赠者不能单独赎回，必须信任该所有者。
- W4：业务源码使用字符串 `require/revert`，没有 migration、Beacon、factorySpecVersion 冒称。**当前 Solidity revert 字符串主要为英文**，UI 提供中英本地化；不能把它描述为全部字面错误中英双语合规。Mini App 不伪装税收 Vault 的 `vaultUISchema/newVault` 接口。
- 随机地址分发：生成地址通常没有任何人掌握其私钥，代币实际无法取回，不是随机发给真实用户。UI 已明确提示；必须保持该披露。

## 已纳入本次源码的修复

- 暂停或关闭缺资金的队首操作后，继续尝试预约下一条操作。
- 实际到账数量小于 minimum 时，回滚整个 self-call 中的 Portal swap，避免不足数量被当作正常输出再次转出。
- 每个 Vault 的全部操作共用资金和一个预约；预约金额及未付预约费不可提现。
- 定量买入直接按代币数量询价，UI 不再要求额外填写 BNB 上限。
- 所有者可在充值交易中尝试首轮回购，无需充值后再次确认启动；小额充值保留在金库，后续补足再试。
- 自动轮次按合计费用实施 10 倍门槛；每次成功预约收取 0.0001 BNB，失败预约不收。Mini App 读取官方请求状态，仅对证明 `FAILED` 的请求显示所有者恢复入口。`PENDING` 不显示恢复按钮。
- 比例输出在一轮中只进行一次回购，比例必须合计 10000 bps。模式 5 按销毁、留存、分发比例处理；留存转入指定钱包，分发转入固定地址或新生成地址。整数除法余数优先进入分发；未选择分发时进入留存；仅选销毁时进入销毁。原模式 4 的销毁、固定地址、生成地址规则保持不变。

## 需要重点审查的既有设计

- 价格底线创建后固定、不可编辑；UI 采用创建时报价的 70%。价格上涨超过保护范围后，操作可能持续失败并付费重试。
- 最多 24 个终身操作，关闭的操作也占名额。
- 输出失败阻塞该 Vault 的后续买入，可通过 `settlePendingOutput()` 重试；关闭操作不取消已经买入代币的原定转出。
- 再预约失败不会使已买入代币或 BNB 账本丢失；失败回退间隔从 5 分钟开始，最大 320 分钟。失败轮次的服务费不可退还。
- “20 地址”输出 gas 测试使用 mock，不等价于真实 Portal 最坏 gas；主网 fork 通过前不可据此宣称全部回调符合现场限制。

## 部署与交付

UI manifest 当前绑定测试网 Factory `0x8501188344c454acb2198518e2ed81e0f8f6381e`（[部署交易](https://testnet.bscscan.com/tx/0xba100a12cfcc29d046e69cccd236bd30783d88306c404c5b3049cb5ac85bed35)），其部署器为 `0x9243Eb546F8A8E58d8E91235817342ED9e8C1431`。UI 仍读取旧 Factory `0xF12C19d415b432268e201ea38fd93011F7a306F1` 的任务；旧 Vault 不迁移，资金池彼此独立。主网代码路径保留，但 manifest 尚未设置正式主网 Factory；主网上线需独立部署并绑定。

UI 四文件 zip 是审核源码交付，不是带 Workbench 格式标记的生产上传包。合约包不包含 `.env`、私钥、钱包文件、`broadcast/`、`out/`、`cache/` 或 `.git/`；SHA256 清单标识实际交付内容。

参考：

- 用户提供的 2026-09-28 StakingBuybackVault 预审计报告，作为检查清单参考，未复制为本项目审计结论。
- [Flap 官方 Trigger 接口](https://github.com/flap-sh/FlapVaultExample/blob/main/src/flap/IFlapTriggerService.sol)：说明执行时间不保证精确，需按 requestId 鉴权和对接动态费用。
- [Flap 官方主网测试 Fixture](https://github.com/flap-sh/FlapVaultExample/blob/main/test/FlapBSCFixture.sol)：依赖地址和测试调用约定参考。
