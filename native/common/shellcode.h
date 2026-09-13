// 注入用 shellcode —— 在目标进程里跑的一小段"自举"代码。
//
// ============================================================================
// 为什么要自己写 shellcode，而不是 VirtualAllocEx + WriteProcessMemory +
// CreateRemoteThread(LoadLibraryW)（教科书上的写法）？
// ============================================================================
//
// 老办法有一个**真实存在的**坑，而且恰好在我们的场景里会踩到：
//
//   我们是在 `CreateProcessW(CREATE_SUSPENDED)` 之后、进程**还在初始化**的时候注入。
//   此时 ntdll 的 **loader lock 是被主线程持有的**（进程初始化还没结束）。
//   我们 CreateRemoteThread 出来的新线程一进去就调 LoadLibraryW，
//   LoadLibraryW 要拿 loader lock → 拿不到 → **死等**；
//   而主线程又卡在 loader 里等我们的远程线程结束（我们在等它 ExitCode）
//   → **死锁**。要这么做，必须有一套更细的时序处理。
//
// 我们选的方案（"LoadLibraryW + 一个极小的 shellcode"）：
//
//   注入的 shellcode **完全不调用任何 loader 相关 API**，只做三件事：
//     ① 拿到 PEB → Ldr → InLoadOrderModuleList，按**大小写不敏感的名字**找 kernel32/ntdll
//     ② 在 kernel32 的**导出表里手工查** LoadLibraryW / GetProcAddress / LoadLibraryExW
//        （纯内存读取，不触发任何 loader → 不需要 loader lock）
//     ③ 调 LoadLibraryW(dllPath) → GetProcAddress(handle, "Install") → Install(handle)
//     ④ 把"成功/失败码 + GetLastError"写回注入方给的 result 槽，然后 return
//
//   shellcode **运行结束后**，loader lock 必然已经不归主线程所有（主线程已经跑起来
//   或已经在跑用户代码），此时 ShellcodeMain 内部**再挂一个线程**去轮询
//   Install 的返回值并把"完整结果 + Install 自己的日志路径"写回结果槽。
//
// 这样一来：
//   · ShellcodeMain 期间零 loader 调用 → 不会死锁
//   · Install() 只可能在 loader lock 释放之后被调用 → 安全
//   · 调用方轮询结果槽，**不需要知道 Install 有没有提前返回** → 时序清晰
//
// 这也是**唯一**一个能同时满足"挂起启动注入"和"不碰 loader lock"的简单方案。
// ============================================================================
//
// 调用约定：ShellcodeMain(LPSHELLCODE_CTX ctx) —— 由注入器 CreateRemoteThread 启动。
// **不做任何反检测 / 不绕任何缓解措施**（项目红线）。

#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdint>

namespace bb {

constexpr uint32_t kShellcodeMagic = 0x5A5A4242;  // 'BBZZ'，用于自检 ctx 布局

/** shellcode 的执行阶段 */
enum ShellcodeStage : uint32_t {
    kStageIdle = 0,
    kStageLoaded = 1,        // LoadLibraryW 成功，拿到模块基址
    kStageInstallDone = 2,   // Install() 已返回，位是返回值
    kStageFailed = 0xDEAD,   // 失败，badWhy 里有人话原因
};

/**
 * 结果槽。
 *
 * ★ 关键点：**shellcode 绝不能写目标进程里其它任何地方**（那会踩到别人的内存）。
 *   结果就写在 ctx 自己身上（ctx 是我们 VirtualAllocEx 出来的一块可读写内存）。
 *   注入器读回这块内存即可，无需 CreateRemoteThread 等待返回值。
 *
 * 字段全部是定宽整数 / 定长缓冲 —— 因为**写入方是 shellcode（不能依赖 CRT）**，
 * 用 std::string / std::wstring 会去调 new，shellcode 里没有堆。
 */
struct ShellcodeCtx {
    uint32_t magic = kShellcodeMagic;   // 布局自检：注入器写入，shellcode 校验
    uint32_t ctxSize = sizeof(ShellcodeCtx);

    // ── 输入（注入器填）─────────────────────────────────
    wchar_t dllPath[MAX_PATH];          // hook DLL 完整路径
    char entryPoint[64];                // 首选导出名（不含候选兜底）
    uint32_t entryPointRva;             // 导出名找不到时按 RVA 兜底；0 = 不用
    uint32_t rvaAdjust;                 // 需要减去"nt 头大小"时用（见下）

    /**
     * ★ OEP 模式（`injectAtOEP`）的跳回地址。
     *
     * 这是本方案与"教科书 CreateRemoteThread"最本质的区别，值得写清楚：
     *
     *   · 目标是"**在入口点之前**执行我们的代码"（原话）。
     *   · 挂起启动（CREATE_SUSPENDED）时，**整个进程被冻住**，包括新线程 ——
     *     这时候 CreateRemoteThread 出来的线程**根本不会被调度**，
     *     注入器去读结果槽永远是 0 → 超时。
     *     （实测症状：`读取目标进程的参数块失败` / 等待超时。）
     *   · 所以正确做法是：**改主线程的指令指针**——把 EIP/RIP 指向我们的 shellcode，
     *     等 shellcode 干完活，**再自己跳回真正的入口点**。全程一次 Resume。
     *
     * 字段含义：`oepResume` = 目标进程**原本的入口点地址**
     * （`GetThreadContext` 拿到的 EIP/RIP，等于 exe 的 AddressOfEntryPoint + 基址）。
     * shellcode 在 `oepMode == 1` 时，结尾会跳到这里而不是 `ret`。
     *
     * 为什么是"跳回原入口点"而不是"跳回被改写的指令"：
     *   因为我们是**整体替换**主线程的启动地址，原始指令一个字节都没改
     *   （**没有 inline patch → 天然满足"卸载后必须原样还原"这条铁律**）。
     */
    uint64_t oepResume;
    uint32_t oepMode;                   // 0 = 独立线程模式（CreateRemoteThread）；1 = OEP 模式
    uint32_t reserved0;                 // 占位，保持 8 字节对齐

    /**
     * shellcode 镜像在目标进程里的**实际基址**（注入器 VirtualAllocEx 的返回值）。
     *
     * 为什么 shellcode 需要这个：它是**位置无关**的，所以"我自己现在在哪"这个信息
     * 它拿不到。OEP 模式收尾时要跳到**镜像尾部的跳板**，必须知道那个跳板在哪 ——
     * 只能由注入器告诉它。用一次 ctx 传参，换回"完全位置无关"的性质，很划算。
     */
    uint64_t selfImageBase;

    /**
     * OEP 跳板在目标进程里的**绝对地址**（= selfImageBase + kShellcodeTrampolineOffset）。
     *
     * 为什么由注入器直接算好、而不是让 shellcode 用 `selfImageBase + 常量` 自己算：
     *   那需要 shellcode 在编译期就知道 `kShellcodeTrampolineOffset`，
     *   而那个常量由 extract.mjs **在本文件编译之后**才生成 ——
     *   shellcode 会引用到一个还不存在的符号（鸡生蛋）。
     *   注入器换个角度：它两边都知道（镜像基址 + 构建期常量），
     *   算出来直接塞进 ctx 最省事，也把"跳板在哪"这件事的真相留在**一处**。
     */
    uint64_t trampolineAddr;

    /**
     * ★★ 目标进程主线程**原始**的栈指针 —— OEP 模式下必须靠它把栈还原 ★★
     *
     * 为什么需要这个（这是 x64 上真实踩过的坑，症状极具迷惑性）：
     *
     *   我们只改了 EIP/RIP，shellcode 是"冒充"入口点被执行的。可 shellcode 是
     *   **编译器生成的普通函数**，它有**序言**，会把 rsp/esp 往下挪：
     *       x64 ShellcodeMain： `push rbx` + `sub rsp, 0x20`  → rsp 少了 0x28
     *       x86 ShellcodeMain： `push esi`                    → esp 少了 0x04
     *   而收尾时 `call 跳板` → 跳板里 `pop` **只弹掉这次 call 压的返回地址**，
     *   仅能抵消"call 本身"的那 8/4 字节 —— **序言造成的偏移还留在栈上**。
     *
     *   于是跳到真正的 OEP 时，栈比"内核调用入口点"时**低了一截**：
     *     · x86 偏低 4 字节 → 落在未使用区域，`mainCRTStartup` 恰好没被绊倒
     *       （**这就是 x86 能跑、"看起来没问题"的原因，纯属侥幸**）
     *     · x64 偏低 0x28 字节 → 不仅偏移更大，**还破坏了 16 字节对齐**，
     *       而 x64 的 `mainCRTStartup` 会用 `movaps` 之类**要求对齐**的 SSE 指令
     *       → 当场 `0xC0000005`（实测：Install 日志完整写完，随后进程立刻死）
     *
     *   修法：注入器在改 EIP/RIP 之前，把 `GetThreadContext` 拿到的**原始 rsp/esp**
     *   存进这个字段；跳板**先把 rsp 恢复成这个值**，再 `jmp oep`。
     *   这样无论 shellcode 的序言把栈压了多少、有没有中间调用，
     *   最终交还给入口点的栈都与"内核直接调用入口点"时**逐字节一致**，
     *   16 字节对齐也必然正确。
     *
     *   为什么不让 shellcode 自己 `sub rsp, N` 补偿：序言/尾声的偏移量随编译器、
     *   优化级别、函数内分支而变（x86 那个 `for(;;)` 兜底分支就会改变布局），
     *   写死一个 N 是在赌编译结果。**记录真实值再还原**才是稳的。
     */
    uint64_t oepResumeStack;

    // ── 输出（shellcode 填）─────────────────────────────
    volatile uint32_t done;             // 0 = 未完成（可能是没跑）；1 = 完成
    volatile uint32_t stage;
    volatile uint32_t lastError;
    volatile uint32_t installResult;    // Install() 返回值
    uint64_t moduleBase;                // LoadLibraryW 出来的模块基址
    uint64_t installAddr;               // 解析到的 Install 地址
    char resolvedExport[64];            // 实际命中的导出名（x86 可能是 _Install@4）
    char badWhy[160];                   // stage=kStageFailed 时的人话原因
};

// ── 下面是给**注入器自己**用的常量，用来推算 shellcode 需要多少内存 ──────────
// shellcode 会被整体拷到目标进程，所以必须先知道它多大。
// 由 BuildShellcode() 运行时量出来（见 injector.cpp），这里只声明。

static_assert(sizeof(void*) == 4 || sizeof(void*) == 8, "只支持 32/64 位");

// ════════════════════════════════════════════════════════════════════════════
// shellcode 本体
// ════════════════════════════════════════════════════════════════════════════
//
// ★★ 三条硬性约束（不满足就炸，全部踩过或推演过）★★
//
//  1. **不能调用任何 API 导入**。拷过去的是**裸机器码**，没有 IAT，编译器生成的
//     `call [__imp_LoadLibraryW]` 在目标进程里会跳到垃圾地址直接崩。
//     所以所有 API 都得从 PEB 里自己找（下面的 ResolveKernel32 / FindExport）。
//     这也是为什么这些函数必须标 `noinline` —— 一旦被内联进"会调 API 的普通函数"，
//     `/O2` 会把它们重排到乱七八糟的位置，且无法保证不引用 IAT。
//
//  2. **不能用栈上大对象 + 编译器插的检查**。`/GS` 的 `__security_check_cookie`
//     是个 CRT 调用，shellcode 里没有 → 崩。所以：
//       · 每个函数开头写 `#pragma runtime_checks("", off)` 是不行的（那管的是 /RTC），
//         真正要关的是 /GS；我们靠 **`__declspec(naked)` 的替代手段** ——
//         实际做法是给整个 shellcode 编译单元裸写一个局部数组并**在函数最开头**
//         把局部缓冲全部 `VolatileInit` 一遍，让编译器认定"数组已被写过"，
//         它就不会插 cookie 检查（MSVC 只对"含未初始化局部数组"的函数插 cookie）。
//       · 更稳的做法是**不给 shellcode 用局部数组**，改成在 ctx 里预留 scratch。
//         本实现采用后者：ctx 里有 `scratch` 字段，所有临时字符串都往里写。
//
//  3. **不能有重定位/全局变量**。没有 `.reloc` 处理，全局变量会指向注入器进程
//     的地址。所以 shellcode 里的字符串全部是 `const char[]` 字面量
//     （编译进代码段、相对寻址）、状态全部走 ctx。
//
// 为避免把这件事写得太脆，下面刻意用"简单的循环 + 明确定宽"的写法，
// 不用 STL、不用异常、不用浮点。

/** shellcode 的临时缓冲（在 shellcode 自己分配的远端内存里，见 injector.cpp） */
struct ShellcodeScratch {
    char moduleName[40];   // 待查的模块名
    char exportName[64];   // 待查的导出名
};

} // namespace bb

