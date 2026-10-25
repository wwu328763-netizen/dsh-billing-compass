# 计费罗盘 · Billing Compass

DeepSeek Harness 的**账单面板**插件:挂在输入框下方的统计条里,点一下弹出卡片,显示

| 数据块 | 来源 | 说明 |
|---|---|---|
| 账户余额 | `api.deepseek.com/user/balance` | 充值 / 赠送 / 可用状态,30s 刷新 |
| 官网消费 | `platform.deepseek.com/api/v0/usage/export` | 本月 + 上月导出的 `cost-*.csv` 求和,按模型拆分 |
| 各模型用量 | `platform.deepseek.com/api/v0/usage/amount` | 命中率、tokens、每亿 token 单价 |
| 本次运行 | 本地拦截 `llm/stream` 的 usage × 内置单价 | 仅内存,重启清零 |
| 本对话消费(整段) | 只读解析本地会话日志 | 覆盖整个会话,不受重启影响 |

> 界面为宿主原生风格:单一 DeepSeek 品牌蓝 + 中性灰,面板与输入框**同宽同位**。

---

## 环境要求

| 项目 | 要求 | 不满足时 |
|---|---|---|
| DeepSeek Harness | 0.2.x(带 `conversation.composer.dock` 槽位与 `useProjection`) | 面板不出现 |
| Node | ≥ 20;`≥ 22.15` 才内置 `zlib.zstdDecompressSync` | "本对话消费(整段)" 退化为"本次运行" |
| 操作系统 | Windows / macOS / Linux **均可** | — |
| 凭据 | `DEEPSEEK_API_KEY`(必需)、`DEEPSEEK_USER_TOKEN`(可选) | 逐项显示"未配置",其余数据正常 |

**不依赖** curl、pwsh、unzip、任何第三方 npm 包 —— HTTP 用 `node:https`,解压与 zstd 用 `node:zlib`。

---

## 安装

### 方式一:作为 bundle 安装(推荐)

```bash
git clone https://github.com/<your-account>/dsh-billing-compass.git
```

然后在 Harness 里让 Agent 执行(或你自己用 `plugin_manager`):

```
plugin_manager action=install_bundle target=<克隆下来的绝对路径>
```

安装后**重启 Harness**,让宿主半边重新导入。

### 方式二:手工放置

1. 把整个目录复制到 `<DSH_HOME>/profiles/node_modules/dsh-billing-compass/`
   - Windows 默认 `C:\Users\<你>\.dsh\profiles\node_modules\`
   - 桌面版也可能是 `<安装目录>\resources\...` 之外的用户目录,以 `DSH_HOME` 环境变量为准
2. 在**当前生效 profile** 的 `cordis.patch.yml`(`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`,桌面版通常是 `desktop`,Web 版是 `web`)末尾追加:

```yaml
- insert:
    - id: dsh-billing-compass
      name: dsh-billing-compass
      config: {}
```

3. 把 `dsh-billing-compass` 加进同目录 `package.json` 的 `dependencies`
4. **重启 Harness**;刷新页面(Ctrl+F5)

---

## 配置凭据

两个键都写在 `<DSH_HOME>/.credentials.yaml`,或用同名环境变量。

### `DEEPSEEK_API_KEY`(余额)

在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 创建,`sk-` 开头。

### `DEEPSEEK_USER_TOKEN`(官网用量与消费,**可选**)

这是**登录态的 token**,不是 API key,只能自己从浏览器拿:

1. 浏览器登录 <https://platform.deepseek.com>
2. F12 → Application/应用 → Local Storage → `https://platform.deepseek.com`
3. 找到 `userToken` 字段,复制其值(通常 64 位字符)

> 这是官网的**内部接口**,可能随官网改版失效;失效时插件会显示"官网…获取失败",不影响余额与实时统计。

写入示例:

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-xxxxxxxx
  DEEPSEEK_USER_TOKEN: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 可选配置

`cordis.patch.yml` 里那一行的 `config`(全部可省略):

```yaml
- insert:
    - id: dsh-billing-compass
      name: dsh-billing-compass
      config:
        balanceKeyRef: DEEPSEEK_API_KEY      # 改用自己的凭据名
        platformTokenRef: DEEPSEEK_USER_TOKEN
        balanceIntervalMs: 30000
        officialIntervalMs: 300000
        retryIntervalMs: 30000
        sessionLog: true                      # 关掉就不解析本地会话日志
        pricing:                              # 单价覆盖,USD / 1M tokens
          deepseek-v4-flash: { input: 0.28, cacheHit: 0.028, output: 0.42 }
          deepseek-v4-pro:   { input: 0.55, cacheHit: 0.14,  output: 2.19 }
```

---

## 计算口径

```
实时/整段费用 ≈ (未缓存输入 + 缓存写) × input + 缓存读 × cacheHit + 输出 × output
              (单价均为 USD / 1M tokens,取内置表,命中不到模型名时按 flash/pro 兜底)

每亿 token 消费 = 消费金额 ÷ (tokens ÷ 1e8)
综合每亿 token = 官网消费总额 ÷ (官网 tokens ÷ 1e8)
```

- 官网数据**以官网为准**,但平台侧可能有数小时延迟,且只覆盖最近约两个月;
- "本次运行""本对话消费(整段)"是**估算**,与官网账单存在偏差(单价表、缓存计费口径、重试请求等);

## 隐私

- 插件**不写任何文件**;
- 实时统计只保留最近 3000 条调用于内存,进程重启即清零;
- 会话日志**只读**,用于汇总整段对话的 token 用量,不会修改或上传;
- 唯一的外部请求是 DeepSeek 官方接口(余额 / 官网用量 / 官网导出)。

---

## 疑难排查

| 现象 | 原因 / 处理 |
|---|---|
| 统计条里没有"余额 …" | 未安装成功或未重启;检查 `cordis.patch.yml` 与 `profiles/node_modules` |
| 显示"余额 未配置" | 缺 `DEEPSEEK_API_KEY`,见上文 |
| 官网消费/用量显示"未配置" | 缺 `DEEPSEEK_USER_TOKEN`(可选功能) |
| 官网数据显示"获取失败 HTTP 401" | userToken 过期,重新取一次 |
| "本对话消费(整段)" 与"本次运行"相同 | Node < 22.15 不支持 zstd,或 `sessionLog: false` |
| 卡片位置/宽度不对 | 该 Harness 版本的输入框 DOM 变了;请提 issue 并附版本号 |
| 改了代码没生效 | 宿主模块在进程内被缓存,**必须重启 Harness**;客户端改动刷新页面即可 |

## 开发

```
lib/index.js   宿主:HTTP 抓取、zip/csv 解析、会话日志解析、/api/dsh-billing 路由
lib/client.js  客户端:统计条 + 点击弹出面板(React createElement,无构建步骤)
cordis.patch.yml  bundle 注册行
```

- 无构建、无依赖,改完直接生效(客户端刷新;宿主重启);
- 面板定位:测量 `[data-composer-input]` 所在输入卡片(28px 圆角)的矩形,与对话框同宽同位;
- 数据接口:`GET /api/dsh-billing?sessionId=<id>` 返回完整快照,可直接 curl 调试。

## License

MIT
