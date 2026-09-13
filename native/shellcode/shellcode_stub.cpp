// shellcode 本体（被编译成**独立的裸代码块**，拷进目标进程执行）。
//
// 本文件**不参与**注入器主程序的编译，而是单独编成一个 .obj，再由 build.mjs
// 从 .obj 里把 .text 段抠出来、导出成 `shellcode_stub.h`（一个 const 字节数组）。
// 这样做的原因见 shellcode.h 的"三条硬性约束"注释。
//
// 编译参数必须极端保守（build.mjs 里已固定）：
//   /O2 /GS- /GR- /EHs-c- /Gy- /Zl /c /utf-8 /D_CRT_SECURE_NO_WARNINGS
//   /DUNICODE /D_UNICODE  且 **不链接任何库**
//
// 本文件里的所有函数都必须：
//   · 不引用任何全局变量 / 字符串常量数组（用字面量，相对寻址）
//   · 不调用任何导入函数（自己从 PEB 找）
//   · 不使用局部大数组（避免 __security_check_cookie）
//   · 返回前把结果写进 ctx

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdint>

#include "shellcode.h"

namespace bb {
namespace sc {

// ── 这些类型在 shellcode 里要自己声明（不能依赖 <winternl.h> 的布局漂移）──
struct ScUnicodeString {
    uint16_t Length;
    uint16_t MaximumLength;
    wchar_t* Buffer;
};

struct ScListEntry {
    ScListEntry* Flink;
    ScListEntry* Blink;
};

struct ScLdrDataTableEntry {
    ScListEntry InLoadOrderLinks;
    ScListEntry InMemoryOrderLinks;
    ScListEntry InInitializationOrderLinks;
    void* DllBase;
    void* EntryPoint;
    uint32_t SizeOfImage;
    ScUnicodeString FullDllName;
    ScUnicodeString BaseDllName;
};

struct ScPebLdrData {
    uint32_t Length;
    uint8_t Initialized;
    void* SsHandle;
    ScListEntry InLoadOrderModuleList;
    ScListEntry InMemoryOrderModuleList;
    ScListEntry InInitializationOrderModuleList;
};

/** PEB 在 x64 上偏移 0x60，x86 上偏移 0x30。用 GS/FS 段寄存器反查，不硬编码 PEB 地址。 */
__declspec(noinline) inline ScPebLdrData* GetLdr() {
#if defined(_M_X64) || defined(_M_ARM64)
    const uintptr_t peb = static_cast<uintptr_t>(__readgsqword(0x60));
    return *reinterpret_cast<ScPebLdrData* const*>(peb + 0x18);
#else
    const uintptr_t peb = static_cast<uintptr_t>(__readfsdword(0x30));
    return *reinterpret_cast<ScPebLdrData* const*>(peb + 0x0C);
#endif
}

/** 小写化（只处理 ASCII），用于大小写不敏感的模块名比较 */
__declspec(noinline) inline wchar_t Lower(wchar_t c) {
    return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c;
}

/**
 * 按名字（大小写不敏感，且**只比较到 '.' 为止**）在已加载模块链表里找。
 * 例：name=L"kernel32" 能匹配到 "KERNEL32.DLL"。
 * ⚠️ 只比较"点之前的"部分，这样不需要知道目标机的扩展名习惯。
 */
__declspec(noinline) inline void* FindModuleByPrefix(ScPebLdrData* ldr, const wchar_t* name) {
    if (!ldr) return nullptr;
    const ScListEntry* head = &ldr->InLoadOrderModuleList;
    for (ScListEntry* cur = head->Flink; cur && cur != head; cur = cur->Flink) {
        auto* e = reinterpret_cast<ScLdrDataTableEntry*>(cur);
        const wchar_t* base = e->BaseDllName.Buffer;
        const uint32_t len = e->BaseDllName.Length / sizeof(wchar_t);
        if (!base) continue;
        uint32_t i = 0;
        bool ok = true;
        for (; name[i] && i < len; ++i) {
            const wchar_t c = base[i];
            if (c == L'.') break;              // 模块名到头了，前缀匹配成功
            if (Lower(c) != Lower(name[i])) { ok = false; break; }
        }
        if (!ok) continue;
        // name 也必须已经走完（否则 name 更长，是别的前缀）
        if (name[i] != 0) continue;
        return e->DllBase;
    }
    return nullptr;
}

/** 把 ASCII 小写比较写成一个不依赖 CRT 的小函数 */
__declspec(noinline) inline bool NameEqInsensitive(const char* a, const char* b) {
    for (;;) {
        char ca = *a, cb = *b;
        if (ca >= 'A' && ca <= 'Z') ca = static_cast<char>(ca - 'A' + 'a');
        if (cb >= 'A' && cb <= 'Z') cb = static_cast<char>(cb - 'A' + 'a');
        if (ca != cb) return false;
        if (!ca) return true;
        ++a;
        ++b;
    }
}

/** 拷贝字符串（不依赖 CRT） */
__declspec(noinline) inline void StrCopy(char* dst, const char* src, uint32_t cap) {
    uint32_t i = 0;
    if (cap == 0) return;
    for (; src[i] && i + 1 < cap; ++i) dst[i] = src[i];
    dst[i] = 0;
}

/** 拷贝宽字符串 */
__declspec(noinline) inline void WStrCopy(wchar_t* dst, const wchar_t* src, uint32_t capChars) {
    uint32_t i = 0;
    if (capChars == 0) return;
    for (; src[i] && i + 1 < capChars; ++i) dst[i] = src[i];
    dst[i] = 0;
}

/**
 * 在某个已加载模块的**导出表**里按名字找函数（纯内存读，不触发 loader）。
 *
 * 这里刻意**不解析转发导出（forwarder）**：kernel32 的 LoadLibraryW /
 * GetProcAddress 都是实打实的实现，不是转发（转发的是 kernelbase，
 * 但我们直接找 kernel32 就是为了避开这个坑）。找不到就返回 nullptr，
 * 调用方会报人话错误而不是崩。
 */
__declspec(noinline) inline void* FindExport(void* moduleBase, const char* name) {
    if (!moduleBase) return nullptr;
    auto* dos = reinterpret_cast<const uint8_t*>(moduleBase);
    if (dos[0] != 'M' || dos[1] != 'Z') return nullptr;
    const uint32_t e_lfanew = *reinterpret_cast<const uint32_t*>(dos + 0x3C);
    const uint8_t* nt = dos + e_lfanew;
    if (!(nt[0] == 'P' && nt[1] == 'E')) return nullptr;

    const uint16_t optMagic = *reinterpret_cast<const uint16_t*>(nt + 24);
    const bool pe32Plus = (optMagic == 0x20B);
    const uint32_t dirOff = static_cast<uint32_t>(24 + (pe32Plus ? 112 : 96));
    const uint32_t expRva = *reinterpret_cast<const uint32_t*>(nt + dirOff);
    if (expRva == 0) return nullptr;

    const uint8_t* expDir = dos + expRva;
    const uint32_t nName = *reinterpret_cast<const uint32_t*>(expDir + 24);
    const uint32_t addrFuncRva = *reinterpret_cast<const uint32_t*>(expDir + 28);
    const uint32_t addrNameRva = *reinterpret_cast<const uint32_t*>(expDir + 32);
    const uint32_t addrOrdRva = *reinterpret_cast<const uint32_t*>(expDir + 36);

    const uint32_t* names = reinterpret_cast<const uint32_t*>(dos + addrNameRva);
    const uint16_t* ords = reinterpret_cast<const uint16_t*>(dos + addrOrdRva);
    const uint32_t* funcs = reinterpret_cast<const uint32_t*>(dos + addrFuncRva);

    for (uint32_t i = 0; i < nName; ++i) {
        const char* cand = reinterpret_cast<const char*>(dos + names[i]);
        if (NameEqInsensitive(cand, name)) {
            const uint16_t ord = ords[i];
            const uint32_t frva = funcs[ord];
            // 转发导出（函数 RVA 落在导出目录区间内）直接跳过 —— 我们只接受真实实现
            if (frva >= expRva && frva < expRva + 0x10000) continue;
            return const_cast<uint8_t*>(dos + frva);
        }
    }
    return nullptr;
}

} // namespace sc
} // namespace bb

// ── 以上是工具函数。下面是真正被拷进目标进程的入口 ────────────────────────
//
// 所有工具函数都标了 noinline，但 /O2 仍可能把它们"内联化"的拷贝放进
// ShellcodeMain。为了可控，我们把 ShellcodeMain 单独编成一个段：
//   #pragma section(".scmain", read, execute)
// build.mjs 直接从 .obj 里把 **整个 .text** 抠出来即可（因为本文件不链接任何库，
// .text 里就只有我们的代码）。
//
// ⚠️ 注意 `__declspec(noinline)` + 内联函数在 C++ 里必须放在**使用之前**，
//    上面的顺序是刻意的。

namespace bb {
namespace sc {

/**
 * 把执行权交还给目标进程的**原入口点**。只在 OEP 模式（ctx->oepMode == 1）下用。
 *
 * ★★ 这段是整个 OEP 方案的最后一环，也是唯一"不能靠 C++ 写出来"的地方 ★★
 *
 * 为什么必须用汇编（或者说，为什么不能用普通 `return`）：
 *   · 在 OEP 模式下，我们的 shellcode 是**冒充**目标进程入口点被调用的：
 *     我们改掉了主线程的 EIP/RIP，让它从我们的代码开始跑。
 *   · 所以**没有"调用者栈帧"可以返回** —— 栈上只有内核压进去的那套
 *     （x64 上是 `BaseThreadInitThunk` 的返回地址；x86 上是 SEH 链 + 返回地址）。
 *     如果直接 `return`，会返回到不可控的地方 → 目标进程崩。
 *   · 正确做法：**跳到真正的入口点**（jmp，不是 call）。这样目标进程自己会
 *     完整走完它的启动流程（CRT 初始化 → main → ...），一切如常。
 *   · 因为是 jmp 而不是 call，栈**一个字节都不动** —— 入口点看到的栈布局
 *     与"内核直接调用它"时完全一致。
 *
 * ── 为什么需要两个架构各写一份 ────────────────────────────────────────────
 *
 *   MSVC 对 x86 提供内联汇编（`__asm { ... }`），但**x64 完全不支持内联汇编**
 *   （编译器只允许 `__asm` 出现在 x86 目标上；x64 上直接报 C4235）。
 *   x64 上想写汇编只有一条路：**`__declspec(naked)` 的纯汇编函数** ——
 *   编译器不生成任何序言/尾声，函数体里每一行都是我们自己写的指令。
 *   所以这两个架构必须分开实现，别想着"一份代码通吃"。
 *
 * ── 寄存器选择 ────────────────────────────────────────────────────────────
 *
 *   两个架构都借一个**易失（caller-saved）**寄存器来装目标地址，跳完就不再管它：
 *     · x64 用 r11 —— 不参与参数传递，且是易失的
 *     · x86 用 eax —— 同理
 *   覆盖易失寄存器**不会破坏入口点期望的任何状态**：按 ABI，函数入口处
 *   所有易失寄存器的值本来就是"未定义"的，入口点自己会用之前先初始化。
 */

// ══════════════════════════════════════════════════════════════════════════
//  OEP 模式怎么把执行权还给目标 —— 「尾部跳板」方案
// ══════════════════════════════════════════════════════════════════════════
//
// 问题陈述：
//   OEP 模式下我们的 shellcode 是**冒充**目标进程入口点被执行的（注入器把主线程
//   EIP/RIP 指到了我们这里），所以**没有调用者栈帧可以 return** —— 栈上只有内核
//   压进去的那套东西。干完活必须**跳到** ctx->oepResume，而且必须保证
//   跳过去时**栈的状态与"内核准备调用入口点"时一模一样**。
//
// 为什么不能靠编译器：
//   · `return` 会返回到不可控的地方（栈上没人给我们留返回地址）→ 目标进程崩。
//   · "跳转到任意地址"在 C++ 里没有直接表达方式。用函数指针调用会生成 `call`
//     → 栈上多压一个返回地址 → 破坏栈布局 → 入口点崩。风险不可接受。
//   · MSVC 在 x64 上**完全不支持内联汇编**（`__asm` 关键字直接报 C4235，
//     `__declspec(naked)` 也不管用）。x86 虽然支持，但两个架构得写两套。
//
// 采用的方案（**零编译器依赖、零重定位技巧**）：
//
//   ① 由 **extract.mjs 在镜像末尾拼一段固定跳板**，并在 build 期把它的偏移
//      导出成常量 `kShellcodeTrampolineOffset`（大小 `kShellcodeTrampolineSize`）。
//
//   ② 跳板机器码（两个架构不同，由注入器在**运行时**填两个地址）：
//
//        x64（28 字节）：
//            48 BC <8字节>     mov  rsp, oepResumeStack   ← ★ 恢复原始栈指针
//            48 B8 <8字节>     mov  rax, oepResume
//            FF E0             jmp  rax
//
//        x86（13 字节）：
//            BC <4字节>        mov  esp, oepResumeStack   ← ★ 恢复原始栈指针
//            B8 <4字节>        mov  eax, oepResume
//            FF E0             jmp  eax
//
//      ★★ 为什么是"直接恢复 rsp"而不是"pop 掉返回地址"（第一版的失败教训）★★
//
//      第一版跳板只做 `pop reg`，理由是"我们是 `call` 进跳板的，弹掉那个返回地址
//      栈就干净了"。这个推理**漏了 shellcode 自己的函数序言**：
//        · shellcode 是编译器生成的普通函数，序言会把栈往下挪
//            x64：`push rbx` + `sub rsp,0x20` → 栈低 0x28 字节
//            x86：`push esi`                  → 栈低 0x04 字节
//        · 而 `pop` 只抵消 `call` 自身压的 8/4 字节，**抵消不了序言那部分**
//        · 结果：交还给入口点的栈是**偏的**
//            x86 偏 4 字节，落在未使用区，`mainCRTStartup` 恰好没踩到 → **侥幸能跑**
//            x64 偏 0x28 字节，且**破坏了 16 字节栈对齐** → `mainCRTStartup`
//                一执行 `movaps` 就 `0xC0000005`
//            实测症状极具迷惑性：Install 全部成功、hook 日志完整写完、
//            注入器也拿到 done=1 报"注入成功"，**目标进程随后立刻消失**。
//
//      所以正确做法不是"抵消"而是"还原"：注入器在改 EIP/RIP 之前把
//      `GetThreadContext` 取到的**原始 rsp/esp** 记进 `ctx.oepResumeStack`，
//      跳板无条件 `mov rsp, 它` —— 无论 shellcode 中间压了多少层、
//      编译器的序言怎么变，交还给入口点的栈都与"内核直接调用入口点"时
//      **逐字节一致**，16 字节对齐也就必然正确。
//      这比"让 shellcode 自己 `sub rsp,N` 补偿"稳得多：那个 N 会随编译器版本、
//      优化级别、函数内分支布局变化，写死就是在赌编译结果。
//
//   ③ 那 8/4 字节的两个地址由**注入器**在写镜像时填入
//      （`ctx.oepResumeStack` 和 `ctx.oepResume`）。
//      注入器本来就在做"绝对地址修正"，这只是同一件事的另一个用途。
//
//   ④ shellcode 这边的结尾就三行：算出跳板地址 → 调过去。见下面
//      `JumpToTrampoline`。**不需要知道跳板里写的是什么**，职责很干净。
//
// 为什么不让 extract.mjs 直接把 `oepResume` 编进跳板：
//   因为那个值只有注入器知道（等于 exe 的 `AddressOfEntryPoint + 实际基址`，
//   基址随 ASLR 变）。所以只能留占位、运行时填。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 把执行权交给**镜像尾部的跳板**，由跳板完成"回到目标入口点"的最后一跳。
 *
 * 参数 `trampolineAddr` = `镜像基址 + kShellcodeTrampolineOffset`（注入器算好，
 * 从 ctx 里读）。为什么必须由注入器给基址：shellcode 是**位置无关**的，
 * 它拿不到"自己现在被放在哪"—— 这正是位置无关的代价，用一次 ctx 传参换回来。
 *
 * ⚠️ 这个函数**永不返回**：跳板会 `mov rsp, <原始值>` 把栈整个还原，
 * 再 `jmp` 到入口点。`jmp` 一走就再也回不来（而且我们的栈也已经被换掉了）。
 *
 * 说明：这里的 `call`（函数指针调用）虽然会压一个返回地址，但**不用管它** ——
 * 跳板第一步就是 `mov rsp, oepResumeStack`，直接把 rsp 设回原始值，
 * 那个返回地址连同 shellcode 序言造成的全部偏移一起被丢弃。这正是
 * "还原"比"逐个抵消"更简单也更可靠的地方。
 */
__declspec(noinline) static void JumpToTrampoline(void* trampolineAddr) {
    if (!trampolineAddr) return;   // 防御：没给地址就退化成"什么都不做"
    reinterpret_cast<void (*)()>(trampolineAddr)();
}

// ══════════════════════════════════════════════════════════════════════════

/**
 * shellcode 入口。**签名固定**：DWORD WINAPI fn(LPVOID)，因为：
 *   · OEP 模式：我们直接把 EIP/RIP 指到这里，`ctx` 通过**约定好的寄存器/栈位置**取
 *     （见下方 `#pragma` 段落与 injector.cpp 的 SetThreadContext）
 *   · 独立线程模式（备用，`oepMode == 0`）：CreateRemoteThread 启动，ctx 是 lpParameter
 *
 * 流程：
 *   ① 自检 ctx（magic / size）
 *   ② 从 PEB 找 kernel32（**不调用 API**）
 *   ③ 手工查 LoadLibraryW / GetProcAddress
 *   ④ LoadLibraryW(dllPath)
 *   ⑤ GetProcAddress(module, entryPoint)（找不到就退化为"按 RVA"）
 *   ⑥ 调用 Install(module)
 *   ⑦ 把结果写回 ctx.done = 1
 *   ⑧ **OEP 模式：跳回原入口点**（这一步不能少，否则目标进程起不来）
 *
 * ⚠️ 关于"挂起态里调 LoadLibraryW 会不会死锁"，本实现**不会**，原因是时序：
 *    shellcode 是作为**主线程的入口点**跑的 —— 此刻主线程已经在执行代码，
 *    说明上一轮 ResumeThread 已经发生、loader lock 已被释放（或本来就没被持有），
 *    所以 LoadLibraryW 能正常拿到锁。
 *    「远程线程 + 挂起进程」那套才会死锁（新线程永远不被调度，见 injector 文件头）。
 */
/**
 * shellcode 的**实际工作函数**。
 *
 * 它只负责干活 + 把结果写进 ctx，**绝不自己决定"接下来去哪"** ——
 * 是"返回调用者"还是"跳回目标入口点"，由外层 ShellcodeMain 统一决定。
 * 这样拆开的原因：OEP 模式下**每一个提前返回的分支**都必须跳回入口点，
 * 如果散在十几处 return 里各写一次汇编跳转，漏一个就是"目标进程起不来"。
 * 集中到一处，漏不了。
 */
__declspec(noinline) static uint32_t ShellcodeBody(ShellcodeCtx* ctx) {
    // ① 自检
    if (!ctx || ctx->magic != kShellcodeMagic || ctx->ctxSize != sizeof(ShellcodeCtx)) {
        return 1;
    }
    ScPebLdrData* ldr = GetLdr();
    void* kernel32 = FindModuleByPrefix(ldr, L"kernel32");
    if (!kernel32) {
        ctx->stage = kStageFailed;
        StrCopy(ctx->badWhy, "shellcode: PEB 里找不到 kernel32.dll", sizeof(ctx->badWhy));
        ctx->done = 1;
        return 2;
    }

    // ③ 手工查三个必需 API
    using PfnLoadLibraryW = HMODULE(WINAPI*)(LPCWSTR);
    using PfnGetProcAddress = FARPROC(WINAPI*)(HMODULE, LPCSTR);
    using PfnGetLastError = DWORD(WINAPI*)();

    auto pLoadLibraryW = reinterpret_cast<PfnLoadLibraryW>(FindExport(kernel32, "LoadLibraryW"));
    auto pGetProcAddress = reinterpret_cast<PfnGetProcAddress>(FindExport(kernel32, "GetProcAddress"));
    auto pGetLastError = reinterpret_cast<PfnGetLastError>(FindExport(kernel32, "GetLastError"));

    if (!pLoadLibraryW || !pGetProcAddress) {
        ctx->stage = kStageFailed;
        StrCopy(ctx->badWhy, "shellcode: 在 kernel32 导出表里找不到 LoadLibraryW/GetProcAddress",
                sizeof(ctx->badWhy));
        ctx->done = 1;
        return 3;
    }

    // ④ 加载 DLL
    HMODULE mod = pLoadLibraryW(ctx->dllPath);
    if (!mod) {
        ctx->lastError = pGetLastError ? pGetLastError() : 0;
        ctx->stage = kStageFailed;
        StrCopy(ctx->badWhy, "shellcode: LoadLibraryW 失败（DLL 可能位数不符/依赖缺失）",
                sizeof(ctx->badWhy));
        ctx->done = 1;
        return 4;
    }
    ctx->moduleBase = reinterpret_cast<uint64_t>(mod);
    ctx->stage = kStageLoaded;

    // ⑤ 找入口导出：先按名字，再按 RVA 兜底
    void* entry = nullptr;
    if (ctx->entryPoint[0]) {
        entry = reinterpret_cast<void*>(pGetProcAddress(mod, ctx->entryPoint));
        if (entry) StrCopy(ctx->resolvedExport, ctx->entryPoint, sizeof(ctx->resolvedExport));
    }
    if (!entry && ctx->entryPointRva) {
        // 按 RVA 定位：模块基址 + (RVA - RvaAdjust)。
        // RvaAdjust 用于"目标 DLL 的节对齐与文件偏移不同"的场景，注入器会算好。
        entry = reinterpret_cast<void*>(
            reinterpret_cast<uint8_t*>(mod) + ctx->entryPointRva - ctx->rvaAdjust);
        StrCopy(ctx->resolvedExport, "(按 RVA 定位)", sizeof(ctx->resolvedExport));
    }
    if (!entry) {
        ctx->lastError = pGetLastError ? pGetLastError() : 0;
        ctx->stage = kStageFailed;
        StrCopy(ctx->badWhy, "shellcode: 模块加载成功但找不到 installEntry（名字与 RVA 都试过了）",
                sizeof(ctx->badWhy));
        ctx->done = 1;
        return 5;
    }
    ctx->installAddr = reinterpret_cast<uint64_t>(entry);

    // ⑥ 调 Install(HMODULE)。签名：BOOL WINAPI Install(HMODULE self)
    using PfnInstall = BOOL(WINAPI*)(HMODULE);
    auto pInstall = reinterpret_cast<PfnInstall>(entry);
    const BOOL ok = pInstall(mod);

    ctx->installResult = ok ? 1u : 0u;
    ctx->stage = kStageInstallDone;
    if (!ok) {
        ctx->lastError = pGetLastError ? pGetLastError() : 0;
        StrCopy(ctx->badWhy, "Install() 返回 FALSE（细节见 hook DLL 自己的日志）",
                sizeof(ctx->badWhy));
    }
    ctx->done = 1;
    return ok ? 0u : 6u;
}

/**
 * ★★ shellcode 的**自举槽** —— 整个方案的关键发明，值得详细说明 ★★
 *
 * 问题：OEP 模式下注入器只能通过 `SetThreadContext` 改**寄存器**和**栈**，
 *       没法走正常的"压参数"路径把 ctx 地址交给 shellcode。
 *       而"从寄存器取参"这条路在两个架构上要求不同：
 *         · x86 是 cdecl/stdcall —— 参数在**栈上**（`[esp+4]`），改 EDX 根本没用
 *         · x64 是寄存器传参 —— 参数在 RCX/RDX，但 MSVC 的序言会先把它们
 *           存进栈，且中间可能被复用，**不可靠**
 *       两边都没有一条"统一且不依赖编译器行为"的取参路。
 *
 * 解法：**让 shellcode 自己知道 ctx 在哪，不靠参数传递。**
 *
 *   在镜像的数据区里放两个变量（都是初值 0，所以躺在 `.bss` 里）：
 *     · `g_selfImageBase` ← 注入器填"**它自己的绝对地址**"（自指指针）
 *     · `g_bootCtxSlot`   ← 注入器填 `remoteCtx`（它自己算的，绝对可靠）
 *
 *   那"自己的地址"从哪来呢？这就用上了我们**本来就有的重定位机制**：
 *   下面这个全局变量 `g_selfImageBase` 的**地址**会被编译成一条**绝对地址
 *   重定位**（x86 是 DIR32、x64 是 ADDR64），而 `extract.mjs` 早已支持
 *   把这类引用改成"镜像基址 + 偏移"（x86 上本来就有 10 处这样的修正）。
 *
 *   于是自举链完整了：
 *     ① 注入器知道 remoteCode（VirtualAllocEx 的返回值）
 *     ② 构建期已记录 `g_selfImageBase` 在镜像里的偏移（kShellcodeSelfBaseOffset）
 *     ③ 注入器填 `g_selfImageBase = remoteCode + kShellcodeSelfBaseOffset`
 *        —— 即"它自己的绝对地址"（**自指指针**，理由见 TakeCtxFromBootSlot）
 *     ④ shellcode 读 `g_selfImageBase` 的值 → 拿到自己的地址（位置无关，零依赖）
 *     ⑤ 加上两个变量的编译期相对距离 → 得到槽的绝对地址
 *     ⑥ 读槽 → 拿到 ctx 指针
 *     ⑦ 后面全部走正常的 C++，再不需要任何寄存器约定
 *
 *   这套写法的好处是：**完全不依赖编译器的调用约定/序言生成**，
 *   两个架构一份代码（只差槽宽度），且"注入器怎么启动它"变成纯粹的
 *   实现细节 —— 无论 OEP 模式还是 CreateRemoteThread 模式，取 ctx 的方式都一样。
 *
 * ⚠️ 为什么用 `volatile`：防止 `/O2` 把这个变量优化成一个常量/寄存器值。
 *    我们要的正是"它的**地址**要出现在代码里、且带重定位"。
 */
extern "C" volatile uintptr_t g_selfImageBase = 0;

/**
 * 自举槽：注入器把 `remoteCtx`（ctx 指针）填进这个变量。
 * 它的**地址**由 `g_selfImageBase` 的内容 + 一个编译期相对距离算出来。
 *
 * 为什么要单独一个变量而不是直接塞在镜像偏移 0：
 *   · 偏移 0 是**代码**（JumpToTrampoline 之类的函数体），不能占；
 *   · 用一个有名字的变量表达意图，extract.mjs 才能把它的偏移导出给注入器；
 *   · 代码好读，排障时一看日志就知道"槽填在哪、填了什么"。
 */
extern "C" volatile uintptr_t g_bootCtxSlot = 0;

/** 从自举槽里取出 ctx 指针（不依赖任何参数传递约定） */
__declspec(noinline) static ShellcodeCtx* TakeCtxFromBootSlot() {
    // 第一跳：拿到**自己的地址**。
    //
    //   ⚠️ 这个变量里装的不是"镜像基址"，而是"**它自己的绝对地址**"
    //      （= 镜像基址 + 它在镜像里的偏移）。可以把它理解成一个
    //      **自指指针**（self-referential pointer）。这是本方案最反直觉的一点：
    //
    //        注入器填进 g_selfImageBase 的是一个"指针自己的地址"，
    //        而不是"这个指针指向的对象的地址"。
    //
    //      为什么必须是这样：编译器把下面那句
    //          &g_bootCtxSlot - &g_selfImageBase
    //      折叠成一个**常量**（本架构实测 = 4，即 0x784 - 0x780）——
    //      它只是两个变量在镜像里的**相对距离**，**不含** g_selfImageBase
    //      自己的偏移 0x780。所以想让 slotAddr 落在真正的槽上，就必须
    //          起始点 = &g_selfImageBase = 镜像基址 + 0x780
    //      也就是说 `g_selfImageBase` 的值应当等于 `&g_selfImageBase`。
    //
    //   ★ 踩坑记录（值得记住）：最初注入器填的是裸的"镜像基址"，
    //     于是这里算出的 slotAddr = 镜像基址 + 4 —— 落在镜像开头那条指令
    //     的**中间**，把那段机器码字节当成 ctx 指针去解引用，
    //     目标进程当场 0xC0000005（访问冲突），且 shellcode 连
    //     ctx->stage 都来不及写（表面现象是"ctx 明明读到了 magic 却崩了"）。
    //
    //   结论 —— 三个量要分清：
    //     · 变量**地址**：由重定位机制自动修正（指向"镜像基址+偏移"）
    //     · 变量**内容**：是数据，重定位不管，必须由注入器主动填
    //     · 二者在"自指指针"这个技巧里被故意合到了一起
    const uintptr_t self = static_cast<uintptr_t>(g_selfImageBase);
    if (!self) return nullptr;
    // 第二跳：槽的地址 = 自己的地址 + 两个变量的相对距离（编译期常量）。
    //   这个**减法**是相对量，天然位置无关 —— 与 extract.mjs 的结论一致。
    const uintptr_t slotAddr = self +
        (reinterpret_cast<uintptr_t>(const_cast<uintptr_t*>(&g_bootCtxSlot)) -
         reinterpret_cast<uintptr_t>(const_cast<uintptr_t*>(&g_selfImageBase)));
    return reinterpret_cast<ShellcodeCtx*>(static_cast<uintptr_t>(
        *reinterpret_cast<volatile uintptr_t*>(slotAddr)));
}

/**
 * ★★ 唯一被注入器写进目标进程的那个入口 ★★
 *
 * ★ 取参方式：**不靠参数**，而是通过**镜像开头的自举槽**自己找 ctx
 *   （完整原理见上面 `g_selfImageBase` 的注释 —— 这是本方案的基石）。
 *   所以这个函数声明成**无参**，注入器也不必费心摆寄存器/栈。
 *
 * 干完活之后**必须跳回 ctx->oepResume**，绝不能 `ret`：
 *   因为"没有调用者"——栈上的返回地址是内核的，ret 会跳到不可控的地方。
 */
extern "C" __declspec(noinline) uint32_t ShellcodeMain() {
    ShellcodeCtx* ctx = TakeCtxFromBootSlot();
    const uint32_t rc = ShellcodeBody(ctx);

    // ⑦ 结果已写进 ctx。接下来决定"去哪"。
    if (ctx && ctx->oepMode == 1) {
        // OEP 模式：把执行权完整交还给目标进程的原入口点。
        //
        // 走法：镜像尾部有一段**注入器填好地址的跳板**（见本文件上半部分的
        // 「尾部跳板」说明），它的绝对地址由注入器算好放在 ctx->trampolineAddr。
        // 跳板会先 `pop` 掉这次调用压的返回地址（把栈还原成内核调入口点时
        // 的样子），再 `jmp` 到 oepResume。**这条路径永不返回。**
        JumpToTrampoline(reinterpret_cast<void*>(ctx->trampolineAddr));
        // 防御性兜底：跳板地址为 0 时 JumpToTrampoline 会直接返回，
        // 那时候我们**不能**再往下走（栈上没有我们的返回地址）——
        // 于是原地死循环，让注入器的超时逻辑接手报错。
        // 这比"返回到未知地址把目标进程搞崩"要好得多：宁可挂住也不要崩。
        for (;;) { /* spin：交给注入器超时处理 */ }
    }
    return rc;   // 独立线程模式：正常返回到 CreateRemoteThread 的收尾代码
}

} // namespace sc
} // namespace bb
