# native/ —— 原生侧（进程内注入）

> 这一层是**汉化的落地手段**：把 hook DLL 注入游戏进程，在运行时取词/回填。
> 仅用于静态改文件走不通的引擎（数据加密 / 编译后脚本 / Unity 打包资源）。

## 为什么必须走注入（而不是只改游戏文件）

| 场景 | 静态改文件 | 进程内注入 |
|---|---|---|
| 数据被加密（如 CryptoJS 加密的 MV/MZ） | ✗ 读不到 | ✓ 运行时拿到明文 |
| 编译后的脚本（KiriKiri `.scn`） | ✗ | ✓ |
| Unity 打包资源（`sharedassets` / `data.unity3d`） | 需完整格式解析 | ✓ |
| **实时悬浮翻译** | ✗ 不可能 | ✓ |
| 游戏更新 | 补丁失效 | 不受影响 |

静态改文件**保留**为 MV/MZ 的快速通道（明文 JS，省 80% 工作量），但**主线是注入**。

## 目录结构

```
native/
  common/            共用基础设施（不含任何引擎知识）
    log.h            ★ 日志：hook 跑在别人进程里，没有控制台，日志是唯一线索
    json.h           极简 JSON（读词表 + 说协议），不引第三方
    hook.h           MinHook 薄封装（成对管理 + 逆序干净卸载）
    wsclient.h       极简 WebSocket 客户端（Winsock2 手写，不引 Boost）
  toygame/           玩具目标程序（N0 第一步）
    toygame.cpp      Shift-JIS 文本 + TextOutW + 原始/缓存模式切换
  hooks/toy/         编码层 hook（N0 第二步）
    toyHook.cpp      MultiByteToWideChar / WideCharToMultiByte
    toyHook.x86.def  x86 导出名（见下方"导出名"说明）
  build.mjs          ★ 构建驱动（推荐）
  build.bat          Windows 交互用的等价脚本
  build/<arch>/      产物
```

## 构建

```bash
node native/build.mjs          # 两个架构都编（默认）
node native/build.mjs x86      # 只编 32 位
node native/build.mjs x64
```

**依赖**：MSVC Build Tools（本机装在 `D:\BuildTools`）+ Windows SDK。MinHook 已随项目
（`libs/minhook`，v1.3.3，BSD-2-Clause）。

产物：`native/build/<arch>/{toygame.exe, toyHook.dll, toymap.json}`

### 已知构建坑（都踩过了）

| 坑 | 现象 | 解法 |
|---|---|---|
| **源码编码** | 一堆莫名其妙的语法错误（`warning C4819`） | 必须加 **`/utf-8`**：MSVC 默认按系统代码页(936/GBK)读源码，会把 UTF-8 的中文注释打乱 |
| 相对路径 | `无法打开包括文件: "../common/log.h"` | 从 `hooks/toy/` 到 `common/` 是 **`../../common/`**，少一层就找不到 |
| **x86 导出名** | `GetProcAddress(h,"Install")` 返回空 | stdcall 会修饰成 `_Install@4`。见下 |
| `cmd.exe` | 受限环境里从 bash 调 `cmd` 被拦 | 用 `build.mjs`（Node 自己拼 INCLUDE/LIB/PATH 再调 cl） |

### 导出名（重要）

- **x64**：WINAPI 无修饰 → 导出就是 `Install` / `Uninstall` ✓
- **x86**：stdcall 修饰 → 导出是 `_Install@4` / `_Uninstall@0`

因此**注入器必须按多个候选名解析导出**（`Install` → `_Install@4` → `Install@4`），
不要写死一个名字 —— 真实世界的 hook DLL 导出名五花八门，这样也更稳。

## N0 / N1 进度

N0 这一步"**风险最高（决定后面所有事可可行性）**"，必须先做，不要一上来碰真游戏。

### N0 — 编码层 + 玩具目标 ✅

- [x] 玩具目标 `toygame.exe`：Shift-JIS 字节 + 每帧 `MultiByteToWideChar` + `TextOutW`；
      按钮在「原始（每帧转换，hook 能拦）」与「缓存（启动时转好，hook 拦不到）」之间切换
      —— **用来肉眼确认"变中文"确实是 hook 干的**
- [x] 编码 hook `toyHook.dll`：MinHook 挂 `MultiByteToWideChar` / `WideCharToMultiByte`，
      词表从 `toymap.json` 读，后台线程连宿主总线（`ws://127.0.0.1:17872`）上报身份与词条
- [x] 双架构编译通过（x86 / x64）

### N1 — 注入器 ✅

- [x] `CreateProcessW` + `CREATE_SUSPENDED` 挂起启动
- [x] `LoadLibraryW` + 极小 shellcode bootstrap（**不调任何导入函数**，从 PEB 手工解析导出表，
      所以不会被挂起态的 loader lock 卡住 —— 详见 `injector.cpp` 头部的选型说明）
- [x] 设置到入口点前执行 → `ResumeThread`（OEP 从 PEB.ImageBaseAddress + PE 头推算，
      **不能**直接拿挂起态的 EIP —— 那时停在 `ntdll!LdrInitializeThunk`）
- [x] **位数检查**：32 位注入器注不进 64 位进程，不匹配明确报错（退出码 13）
- [x] `needEnglishPath`：在 `%LOCALAPPDATA%` 下建 **junction**（不需要管理员、不复制文件），
      反向还原 = 删掉联接，原始文件一字节未动
- [x] `envAppend`：给目标进程追加环境变量（**必须带 `CREATE_UNICODE_ENVIRONMENT`**）
- [x] `largeAddressAware`：给 exe 打大地址感知标志，**改前先备份 `.bak`**，
      且二次运行不覆盖已存在的备份
- [x] `makeLaunchBat`：生成启动脚本（`chcp 65001` + `cd /d` + UTF-8 BOM）
- [x] `--uninstall <pid>`：让已注入进程执行 `Uninstall()`，hook 拆干净、进程不崩
- [x] **看门狗进程**：注入器被强杀时，独立看门狗会把仍被挂起的目标恢复执行
- [x] 全程日志；失败给人话错误信息 + 稳定退出码（10~22）
- [x] **不做任何反检测/绕杀软**（项目宪法明文禁止）

### 验收：一条命令跑完全部

```bash
cd native && node build.mjs && bash acceptance-all.sh
```

会依次跑 8 组，任何一组失败则整体失败：

| 组 | 覆盖 | 结果 |
|---|---|---|
| N1-1 | 注入本体：正例 x86/x64、非 PE 目标、位数不匹配、无 `Install` 导出、缺参数 | 28/28 |
| N1-2·3 | 注入 → 卸载端到端（x64 / x86）：日志顺序证明 Install 与 Uninstall 都真跑过，卸载后进程仍存活 | 10/10 ×2 |
| N1-4·5 | 看门狗（x64 / x86）：被强杀 → 目标被立刻恢复；**含阴性对照**证明判定有鉴别力 | 6/6 ×2 |
| N1-6 | profile 特性：`largeAddressAware`/`makeLaunchBat`/`envAppend` | 14/14 |
| N2-1·2 | 排版回填（x86 / x64）：度量 / 折行不溢出 / 字号自适应 / 缺字兜底 / 全部还原 | 16/16 ×2 |

---

## N2 — 排版回填 ✅

这一步是"**能看**和**能用**的分界线"。
问题背景：日文换成中文后**字符宽度、行高、折行位置全变了**，
直接换字符串会导致文字溢出对话框、错位、被裁掉。

### 交付物

| 文件 | 作用 |
|---|---|
| `common/measure.h` | 文本度量代理。主路径 GDI（`GetTextExtentPoint32W` / `GetGlyphOutlineW`）；降级路径是**内嵌的最小 TrueType/OpenType 解析器**（只读 `head`/`hhea`/`hmtx`/`maxp`/`loca`/`glyf`/`cmap`，支持 **TTC 字体集合**），同时负责**缺字检测** |
| `common/wrap.h` | 自动折行（中文**禁则**：行首禁则/行尾禁则、西文整词不拆、每行最大字数兜底）+ **字号自适应**（逐级 ±1 到放得下）+ 引擎字号档位表（`fontSizeVx=-3` 等 12 项为既定档位） |
| `common/fontmap.h` | 字体决策：缺字检测 → `fixFontName`（默认黑体）→ fallback 兜底；`FontOverrideState` 保证**一键还原** |
| `common/layout_config.h` | 玩具对话框几何约定 —— 玩具与 hook **共享同一个头**，避免"玩具画 380 宽、hook 按 300 折行"这类不一致 |
| `hooks/toy/layout_hook.h` | 绘制时排版：从 HDC 读回**真实字体** → 折行 + 降字号 + 缺字兜底 → 逐行绘制 |
| `hooks/toy/toyHook.cpp` | 新增 hook `TextOutW`（排版接管）、`CreateFontIndirectW/A`（手段② 换族名，**默认关**） |
| `tools/measure_selftest.cpp` | **无 GUI 控制台自检** 30 项（进验收脚本，不用盯截图） |
| `injector/` | 新增 `--call <pid> --dll <dll> --entry <名>`：在已注入进程里调用任意导出（宿主发命令用） |

### 三件事分别怎么做

**① 折行** —— 中文断行不能"每行塞满 N 个字"，必须处理**禁则**：
- **行首禁则**：`，。、；：？！）】》」』…—` 等不能出现在一行**开头**
- **行尾禁则**：`（【《「『` 等不能出现在一行**结尾**
- 西文整词不拆（超长单词才硬切）；每行最大字数作为引擎侧兜底

**② 字号自适应** —— 基准字号试排 → 量总高 → 放不下就**降 1 级**重排，直到放下或到下限。
刻意用"逐级 ±1"而不是"一次算出理论值"：文字高度是离散像素，
字号与行数**不是连续函数**（小一点点可能刚好少一行、高度骤降），
一次算出来的理论值经常就差一像素放不下。

**③ 缺字兜底** —— 按既定优先级：
① 替换游戏字体文件（**本版本只做"登记 + 可还原"框架，不分发字体** ——
分发字体涉及授权，没确认许可证前不该往游戏目录塞文件）→
② hook `CreateFontIndirectA/W` 改族名（`fixFontName`，默认"黑体"）→
③ 缺字时用 fallback 字体兜（本版本用系统"宋体"扮演，
将来换成内嵌 Noto Sans CJK SC 子集即可，上层决策逻辑一行都不用改）。

### 验收怎么做到"不用肉眼看窗口"

排版发生在**目标进程内部**（hook 在 `TextOutW` 里重排），外部拿不到 HDC 也拿不到文本框。
所以让被注入的一侧把事实**写进日志**，脚本基于它做硬断言：

```
LAYOUT handled=1 ok=1 lines=7 widest=360 boxw=364 usedh=126 boxh=138 fonth=-18 shrink=4 substituted=1 face=黑体
```

| 验收要求 | 断言 |
|---|---|
| ① 3 倍长度中文自动折行、不溢出 | `widest(360) <= boxw(364)` 且 `lines >= 2` |
| ② 字号降级后完整可见 | `usedh(126) <= boxh(138)` 且**至少有一段文本** `shrink > 0` |
| ③ 龘 能显示（非豆腐块） | 自检断言 `龘 在 MS Gothic = 无`、`龘 在 黑体 = 有`；端到端 `substituted=1 face=黑体` |
| ④ 全部还原 | 日志 `RESTOREALL ok=1 fontOverride=0 layoutDisabled=1`，**且随后出现** `LAYOUT handled=0 reason=layout-disabled` |

> 最后那条"随后出现 handled=0"是关键：只断言"还原命令执行成功"是不够的 ——
> 必须证明**之后真的不再接管**，否则"字体和字号回到原始状态"这句话没有证据。

### ★ N2 期间踩到并修掉的真问题

| # | 现象 | 根因 |
|---|---|---|
| 1 | 32 位进程查不到任何字体，缺字检测**静默失真**（任何字都判成"有"） | **注册表要用 `KEY_WOW64_64KEY`**：32 位进程读 `HKLM\SOFTWARE\...` 会被 WOW64 重定向到 `WOW6432Node`，而字体表只在 64 位视图里 |
| 2 | 所有字体文件解析失败，而失败是静默的 | **sfnt 是 big-endian**：按小端读会把 `ttcf` 读成 `0x66637474`、`00 01 00 00` 读成 `0x00000100`。判据是"文件前 4 字节看着像乱码" |
| 3 | TTC 字体 `numGlyphs=0`，全被判成"什么字都没有" | **TTC 里表偏移相对"文件开头"**，不是相对子字体自己的偏移表 —— 参照系不能混 |
| 4 | 日志被同一行刷爆（2.5 秒 44 行） | **节流键必须"每段文本各自"**：用全局变量会被一帧里的"A、B、A、B"交替打穿 |
| 5 | "全部还原"执行成功、日志也写了，但排版照样接管 | **`Restore()` 不能顺手把 `enabled` 设回 true** —— 会把调用方刚设好的"停用"覆盖掉 |
| 6 | 长文本与对照行**叠在一起** | 排版 hook 用的是一个共享的框宽，它不知道哪次 `TextOutW` 属于哪个框 → 把对照行放到框外 |


### ★ 缓冲区长度语义（这类工具最常见的崩溃原因）

`MultiByteToWideChar` 的返回值是"**需要多少个宽字符**"（`cbMultiByte = -1` 时含结尾 0）。
译文比原文长时，如果我们在**查询长度**的调用里返回原文长度，
调用方就会按原文长度分配缓冲，我们往里写更长的译文 → **堆破坏 / 崩溃**。

`toyHook.cpp` 里的 `HijackResult()` 把三种情况分开处理，并且**宁可返回 0 报
`ERROR_INSUFFICIENT_BUFFER`，也绝不在长度查询里说谎、绝不截断硬写**。

### ★ N1 的五个真实根因（都已写进代码注释，别再重踩）

| # | 现象 | 根因 |
|---|---|---|
| 1 | 注入后目标秒崩，`stage=0` | **自举槽要填"自指指针"**：`g_selfImageBase` 里必须装**它自己的绝对地址**，不是镜像基址 —— 编译器把 `&slot - &selfBase` 折叠成常量 4（只是相对距离） |
| 2 | 同上，且入口字节看着是 `call 下一条指令` | **`.obj` 里节与节之间的 `rel32` 全是占位 0**，等链接器填。跳过链接器直接拼镜像就必须自己算 `值 = 目标镜像偏移 - (字段镜像偏移 + 4 + tail)` |
| 3 | x86 能跑、**x64 注入成功后进程立刻消失** | **OEP 跳板必须"还原"栈而不是"抵消"**：`pop` 只能抵消 `call` 压的 8/4 字节，而 shellcode 序言已挪了栈（x64 = 0x28）→ 破坏 16 字节对齐，`mainCRTStartup` 的 `movaps` 访问冲突 |
| 4 | 带 `envAppend` 时 `CreateProcessW` 报错 87，命令行/工作目录全对 | **传自定义环境块必须带 `CREATE_UNICODE_ENVIRONMENT`**：漏了它，宽字符块会被当 ANSI 解析 |
| 5 | 每次重新编译 `shellcode_*.h` 都变（**构建不可复现**） | **`.bss` 的节头是 `rawSize=8 / rawPtr=0`**（MSVC 对"没有实体数据"的节把文件偏移写成 0）。按 `rawSize > 0` 判"有实体字节"就会 `subarray(0, 8)` 读到 **`.obj` 自己的 COFF 文件头**（Machine + NumberOfSections + **TimeDateStamp**），于是 `.bss` 里本该为 0 的变量被灌进了编译器时间戳。判据改成 `rawSize>0 && rawPtr>0 && !(chars & CNT_UNINITIALIZED_DATA)`，详见 `extract.mjs` 的 `hasFileBytes()` |

> 第 5 条的验收手法：连续构建两次比较头文件哈希 —— 一致才算可复现。

### ★ 验收脚本踩过的环境坑（写脚本时先看这段）

| 坑 | 现象 | 解法 |
|---|---|---|
| `//FI`、`//FO`、`//F` 被吞 | `tasklist`/`taskkill` 报"无效参数 `//FI`"，**静默失败** → 进程存活检查永远返回 0，把崩溃误判成通过 | 用**绝对路径 + 单斜杠**：`/c/Windows/System32/tasklist.exe /FI ...` |
| Windows 路径当参数传给 node/原生程序 | 被 shim 转成 `C:\c\Users\...`（多一层 `\c`） | **先 `cd` 到目录，只传相对文件名** |
| hook 日志读不到 | DLL 用 `_wfopen_s(..., L"ab")` 持有它，`cp`/`cat` 都报 "Device or resource busy" | 卸载后 `Uninstall` 里的 `Log::close()` 会释放；否则先 kill 目标再读 |
| 删除操作被拦 | `[safe-delete]` 保护会拦截同一轮里偏多的 `rm`，导致"删了但没删掉" | 别依赖删除制造干净起点，改用**文件指纹**（mtime+size）比对 |
| `bash ... \| grep` 取退出码 | 拿到的是 `grep` 的退出码 → 失败被报成成功 | 先重定向到文件、立刻存 `$?`，再过滤输出 |

