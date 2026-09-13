# 参与开发

感谢你愿意参与。这份文件说明**环境怎么搭、代码怎么写、什么绝对不能做**。

---

## 一、红线（违反 = 返工）

1. **一切可逆。** 任何修改游戏文件的动作，**先自动备份**再动手；补丁按倒序展开还原。
   "还原后逐字节一致"是每次交付前都要重新验证的断言，不是口头保证。
2. **不分发受版权保护的资源。** 不把字体文件、翻译文本、游戏资源写进仓库，也不写进用户游戏目录
   —— 中文字体走"让引擎使用系统已有字体"的路子（见 [README 的字体一节](./README.md#字体不分发字体文件)）。
3. **不实现任何反检测 / 不绕过杀软。**
   项目解决的是"看不懂"，不是"绕过什么"。不 hook 进程缓解策略相关函数。
4. **不静默外发数据。** 翻译记忆、术语表、文本库全在本机；除用户自己配置的机翻接口外，
   不允许有任何字节离开本机。

---

## 二、环境

| 项 | 要求 |
|---|---|
| Node.js | ≥ 22（推荐 22 LTS） |
| 系统 | Windows 10 / 11 x64 |
| 原生编译 | MSVC Build Tools（`better-sqlite3` 需要） |

```bash
npm install        # 会自动把 better-sqlite3 编到 Electron ABI
npm run dev        # 开发模式起窗（热更新）
```

> **原生模块 ABI 提示**：`better-sqlite3` 在 Node 与 Electron 下的 ABI 不同。
> `npm test` 的 `pretest` 会自动探测并切到 Node ABI，别把它删掉。
> 跑完测试想开应用，先执行 `npm run rebuild:electron`。

> **原生侧构建**：`native/` 的构建脚本会从 `D:\BuildTools` 找 MSVC（作者机器的默认值）。
> 装在别处时设环境变量 `BB_BUILD_TOOLS` 指向你的安装目录。

---

## 三、工程约定

- **TypeScript `strict`，禁止 `any`**（确需放宽时用 `unknown` + 收窄）。
- **目录分层严格**（见 [README 的项目结构](./README.md#项目结构)）：
  上层可依赖下层，**禁止反向依赖**。
- **接口契约以 [`src/shared/contracts.ts`](./src/shared/contracts.ts) 为准。**
  要改签名，先改契约，再同步所有实现 —— 不要只改一处。
- 引擎适配器放 `src/engines/<id>/`；翻译 Provider 放 `src/translate/providers/`。
- **注释与文档用简体中文；标识符用英文。**
- 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：
  `feat:` `fix:` `refactor:` `docs:` `test:` `chore:` …

---

## 四、新增一个引擎

引擎适配是**插件化**的，新增引擎不需要改动界面：

1. 在 `src/engines/<id>/` 实现 `EngineAdapter` 接口的 `detect` / `extract` / `repack`；
2. 填一份 **`EngineManifest`** —— 该选哪层目录、常见源语言、字体机制、已知坑；
3. 注册到 `src/main/bootstrap-plugins.ts`。

> **界面无需改动** —— 界面只读 manifest 数据，不含任何 `if (engineId === 'xxx')` 分支。
> 这是"声明式配置"这条设计约束的兑现点；如果你的改动需要往界面里加引擎分支，
> 说明走错了路，请先回到 `EngineManifest` 看看该字段能不能加进去。

新增引擎时**必须附一份侦察报告**（放 `docs/recon/`），并在其中给出**真实样本**上的实测数字。
本项目的原则是：**没有真样本就无法验证，无法验证就不叫"支持"。**

---

## 五、提交前自查

```bash
npm run typecheck   # 类型检查，必须 0 错误
npm test            # 单元 + 集成测试，必须全绿
npm run lint        # 代码检查
npm run build       # 三进程产物
```

- 改了原生侧（`native/`）→ 跑 `cd native && node build.mjs && bash acceptance-all.sh`；
- 改了打包相关 → 跑 `npm run dist`，并**用打包成品**（`dist/win-unpacked/`）验证一遍，
  而不是只跑开发模式 —— 打包环境与开发环境的行为差异**真的会**藏 bug
  （例如 CLI 参数判定、原生模块加载路径）。

---

## 六、测试样本

依赖真实游戏样本的测试**默认跳过**（样本不在本机时不会失败）。
要用自己的样本跑，通过环境变量传入：

| 环境变量 | 用途 |
|---|---|
| `BB_MV_SAMPLE` | RPG Maker MV 游戏目录（含 `www/`） |
| `BB_MZ_SAMPLE` | RPG Maker MZ 游戏目录 |
| `BB_UNITY_SAMPLE` | Unity `.bundle` 样本文件 |
| `BB_ENCRYPTED_SAMPLE` | 数据被加密的 MV/MZ 游戏目录（用于验证"明确拒绝"路径） |

**请不要把商业游戏样本、字体或翻译数据提交进仓库。**
自研 / 免费素材可以放进 `native/toygame/` —— 那里的玩具目标程序就是为此准备的。
