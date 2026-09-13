// ============================================================================
// 白的百宝箱 —— 注入器（N1）
//
// 职责：把 hook DLL 送进目标进程，并在 DLL 加载后调用它的 Install()。
//
// 用法（两种模式，都不需要 GUI）：
//   bbInject32.exe --profile <profile.json>          # 按配置启动并注入
//   bbInject32.exe --exe <目标> --dll <hook.dll>     # 命令行直接指定，便于自测
//   可选：--cwd <目录>  --timeout <毫秒>  --json  --log <路径>
//
// ============================================================================
// 【选定的注入方式 & 为什么】—— 项目要求"先说明你选哪种方案、为什么"
// ============================================================================
//
// 方案：**CreateProcessW(CREATE_SUSPENDED) + 自定义 shellcode**
//       （"LoadLibraryW + 一个极小的 shellcode"这条路）
//
// ── 为什么不用教科书上的 "VirtualAllocEx + 写路径 + CreateRemoteThread(LoadLibraryW)" ──
//    在我们的场景里它有**真实的死锁**：
//      挂起启动时进程初始化还没走完，ntdll 的 **loader lock 由主线程持有**。
//      远程线程一进去调 LoadLibraryW 就要拿 loader lock → 拿不到 → 阻塞；
//      而我们又在等远程线程结束 → **双方互等**。
//
// ── 为什么不用"纯手动 PE 映射"──
//    hook DLL 依赖 MSVC CRT + MinHook + ws2_32。手工映射要自己处理重定位、
//    导入表、TLS 回调、SEH 表、CFG 表 —— 漏一个就是**偶发**崩溃（最难查的一类）。
//    而"避开 loader lock"这个收益，我们用 shellcode 已经拿到了，成本却低得多。
//
// ── 我们的 shellcode 为什么安全（见 native/shellcode/shellcode_stub.cpp）──
//    它**不调用任何导入函数**：从 PEB 找 kernel32 → 手工解析导出表 →
//    拿到 LoadLibraryW / GetProcAddress → 加载 DLL → 调用 Install()。
//    全程零 loader 调用，因此不会被 loader lock 卡住。
//    而且它被编译成**位置无关镜像**（本仓库用真实链接产物对拍验证过：
//    `node native/shellcode/verify-order.mjs x86`，见那个脚本的注释）。
//
// ── 时序（决定了方案能不能成立，值得单独说）──
//    我们**不要求** shellcode 在进程恢复前跑完。做法是：
//      ① 挂起启动 → VirtualAllocEx 两块内存（参数块 + 代码镜像）→ 写进去
//      ② CreateRemoteThread 启动 shellcode
//      ③ **立刻 ResumeThread(主线程)** —— 主线程跑起来后 loader lock 迟早释放
//      ④ shellcode 的线程自己去 LoadLibrary + Install
//      ⑤ 注入器**轮询**远程的参数块（done 标志），而不是等线程 ExitCode
//    这样"挂起启动"的收益（赶在游戏初始化前拿到控制权）拿到了，
//    又完全不必赌 loader lock 的时序假设。
//
// ── 关于"设置到入口点前执行 → Resume" ──
//    我们做的是**等效且更稳**的版本。不去改主线程 CONTEXT 插到 OEP，因为：
//    现代引擎（NW.js / Electron / Unity）的 OEP 在加壳或自解压后才有效，
//    静态解析出的 OEP 往往是错的位置，改 CONTEXT 直接崩。
//    而"能不能更早拿到控制权"这件事，后续里程碑有更可靠的手段
//    （DllMain + TLS 回调天然就比 OEP 早）。
// ============================================================================
//
// ⚠️ 项目红线：**不做任何反检测 / 不绕过任何缓解措施 / 不混淆**。
//    本文件里没有一处对杀软、调试器、VM、缓解措施的探测或规避。

#define WIN32_LEAN_AND_MEAN
#pragma warning(disable : 4127)   // 构建期生成的修正表可能为空 → `if (kFixCount > 0)` 常量条件
#include <windows.h>
#include <tlhelp32.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../common/log.h"
#include "../common/pe.h"
#include "../common/profile.h"
#include "../common/shellcode.h"

// shellcode 镜像由 build.mjs 从 .obj 抠出来生成（见 native/shellcode/extract.mjs）
#if defined(_M_X64) || defined(_M_ARM64)
#include "../shellcode/shellcode_x64.h"
#else
#include "../shellcode/shellcode_x86.h"
#endif

namespace bb {

// ── 退出码：给上层（宿主 Node）判断用的**稳定契约** ────────────────────────
enum ExitCode : int {
    kOk = 0,
    kBadArgs = 10,
    kBadTarget = 11,      // 目标 exe 找不到 / 不是 PE / 是 DLL
    kBadDll = 12,         // hook DLL 找不到 / 不是 PE / 是 exe
    kArchMismatch = 13,   // 位数不匹配（32 位注不进 64 位）
    kNoExport = 14,       // DLL 里找不到要调的入口导出
    kCreateFailed = 15,   // CreateProcessW 失败
    kInjectFailed = 16,   // 写内存 / 建线程失败
    kRemoteFailed = 17,   // shellcode 在目标里失败了（细节见 badWhy）
    kInstallFailed = 18,  // Install() 返回 FALSE
    kTimeout = 19,        // 等结果超时
    kNoProcess = 20,      // --uninstall：目标 pid 不存在 / 打不开
    kNotInjected = 21,    // --uninstall：目标进程里没有我们的 DLL（没注入过）
    kUninstallFailed = 22,// --uninstall：Uninstall 调用失败
};

const char* ExitCodeName(int code) {
    switch (code) {
        case kOk: return "OK";
        case kBadArgs: return "参数错误";
        case kBadTarget: return "目标程序有问题";
        case kBadDll: return "hook DLL 有问题";
        case kArchMismatch: return "位数不匹配";
        case kNoExport: return "DLL 里找不到入口导出";
        case kCreateFailed: return "CreateProcessW 失败";
        case kInjectFailed: return "写入目标进程失败";
        case kRemoteFailed: return "shellcode 在目标进程里失败";
        case kInstallFailed: return "Install() 返回 FALSE";
        case kTimeout: return "等待注入结果超时";
        case kNoProcess: return "目标进程不存在或打不开";
        case kNotInjected: return "目标进程里没有加载我们的 hook DLL";
        case kUninstallFailed: return "卸载（调用 Uninstall）失败";
        default: return "未知错误";
    }
}

// ── 日志 + 结果收集 ─────────────────────────────────────────────────────────

struct Options {
    std::wstring profilePath;
    std::wstring exePath;
    std::wstring dllPath;
    std::wstring workDirOverride;
    std::wstring logPath;
    int timeoutMs = 30000;
    bool jsonOut = false;

    // ── 卸载 / 远程调用模式 ──
    bool uninstall = false;
    DWORD uninstallPid = 0;
    std::string uninstallEntry = "Uninstall";   // 与 hook DLL 的导出名保持一致

    /**
     * `--call <pid> --entry <导出名>`：在已注入的进程里调用任意导出。
     *
     * 为什么和 --uninstall 分开：语义不同（一个是"拆掉我们"，一个是"给被注入侧
     * 发一条命令"，比如 N2 的"全部还原"）。但**底层机制完全相同**，
     * 所以复用同一段实现，只在措辞上区分。
     */
    bool remoteCall = false;
    DWORD remoteCallPid = 0;
    std::string remoteCallEntry;
};

/** UTF-8 ↔ 宽字符。定义在下面，这里先声明（Reporter 要用）。 */
std::wstring Utf8ToWide(const std::string& s);
std::string WideToUtf8(const std::wstring& w);

/** 收集"人话错误"，最后统一打印 + 写日志（要求：不要只抛 NTSTATUS） */
struct Reporter {
    std::vector<std::string> errors;
    std::vector<std::string> notes;
    int code = kOk;

    /**
     * 这次干的是什么（"注入" / "卸载"），只用在一句话总结里。
     * 存成成员而不是给 PrintResult 传参，是为了让各处 fail()/note() 的写法
     * 保持统一 —— 注入和卸载会走完全一样的日志与错误收集逻辑。
     */
    std::string verb = "注入";

    // ⚠️ 这里的 msg 是 **UTF-8 窄串**（我们内部统一用 UTF-8 存文本，
    //    因为 JSON 输出要 UTF-8，Windows 宽 API 要 UTF-16，UTF-8 是两者的公约数）。
    //    日志宏的 %s 要的是 wchar_t*，所以必须先显式转一次。
    //    **不能**用 %S：`%S` 在宽字符格式化里是"窄串按**当前 ANSI 代码页**转宽"，
    //    而我们的字节是 UTF-8 —— 直接把「日志」显示成了「æ¥å¿」。
    //    （实测踩到过：bbinject.log 里所有中文都成了乱码。）
    void fail(int c, const std::string& msg) {
        if (code == kOk) code = c;
        errors.push_back(msg);
        BB_ERR(L"%s", Utf8ToWide(msg).c_str());
    }
    void note(const std::string& m) {
        notes.push_back(m);
        BB_LOG(L"%s", Utf8ToWide(m).c_str());
    }
};

// ── UTF-8 ↔ 宽字符 ─────────────────────────────────────────────────────────

std::string WideToUtf8(const std::wstring& w) {
    if (w.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    if (n <= 0) return "";
    std::string s(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (n <= 0) return L"";
    std::wstring w(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

std::wstring DirOf(const std::wstring& p) {
    const size_t pos = p.find_last_of(L"\\/");
    return pos == std::wstring::npos ? L"." : p.substr(0, pos);
}

std::wstring BaseNameOf(const std::wstring& p) {
    const size_t pos = p.find_last_of(L"\\/");
    return pos == std::wstring::npos ? p : p.substr(pos + 1);
}

std::wstring Absolute(const std::wstring& p) {
    wchar_t buf[MAX_PATH * 2] = {0};
    const DWORD n = GetFullPathNameW(p.c_str(), MAX_PATH * 2, buf, nullptr);
    if (n == 0 || n >= MAX_PATH * 2) return p;
    return std::wstring(buf, n);
}

bool FileExists(const std::wstring& p) {
    const DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

std::string Hex(uint64_t v) {
    char b[32];
    snprintf(b, sizeof(b), "0x%llx", static_cast<unsigned long long>(v));
    return b;
}

int SelfBits() { return static_cast<int>(sizeof(void*) * 8); }

// ── ASCII 工作目录（needEnglishPath）────────────────────────────────────────
//
// 为什么需要：Chromium 系引擎（NW.js / Electron 打包的游戏，含 MV/MZ）
// 在非 ASCII 路径下会白屏或崩溃（这是已知的坑，见下方坑表）。
//
// 做法：在 %LOCALAPPDATA% 下建一个纯 ASCII 目录，用 **junction**
// （目录联接，NTFS 原生重解析点；**不需要管理员权限**、**不复制任何文件**）
// 指向真实游戏目录，游戏在 ASCII 路径下被启动。
// 反向还原 = 直接删掉这个 junction —— 原始文件**一个字节都没动**，
// 所以不存在"还原不干净"的问题（比"复制文件"的做法更干净）。
//
// 目录名带真实路径的稳定哈希，保证同一个游戏每次都落到同一条 junction。

uint32_t Fnv1a(const std::wstring& s) {
    uint32_t h = 2166136261u;
    for (wchar_t c : s) {
        h = (h ^ static_cast<uint32_t>(c & 0xFF)) * 16777619u;
        h = (h ^ static_cast<uint32_t>((c >> 8) & 0xFF)) * 16777619u;
    }
    return h;
}

bool IsAscii(const std::wstring& s) {
    for (wchar_t c : s) {
        if (c > 0x7F) return false;
    }
    return true;
}

/** 递归建目录（不依赖 shlwapi 的 SHCreateDirectoryEx） */
bool EnsureDir(const std::wstring& dir) {
    std::wstring cur;
    for (size_t i = 0; i < dir.size(); ++i) {
        cur.push_back(dir[i]);
        if ((dir[i] == L'\\' || dir[i] == L'/') && i > 2) {
            CreateDirectoryW(cur.c_str(), nullptr);
        }
    }
    CreateDirectoryW(dir.c_str(), nullptr);
    const DWORD a = GetFileAttributesW(dir.c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

/** 安全地把 GetFullPathNameW / GetModuleFileNameW 结果取成 std::wstring */
std::wstring TryGetFullPath(const std::wstring& p) { return Absolute(p); }

/**
 * 建目录联接。
 *
 * 用 `cmd /c mklink /J` 而不是 CreateSymbolicLinkW —— 后者需要
 * SeCreateSymbolicLink 特权（管理员），而 junction 不需要（普通用户可建）。
 * 这是 Windows 上"给非 ASCII 目录造 ASCII 别名"最省事且不需要提权的办法。
 */
bool CreateJunction(const std::wstring& linkPath, const std::wstring& targetPath, Reporter* rep) {
    const DWORD attr = GetFileAttributesW(linkPath.c_str());
    if (attr != INVALID_FILE_ATTRIBUTES) {
        if (!(attr & FILE_ATTRIBUTE_REPARSE_POINT)) {
            rep->note("ASCII 工作目录已存在且不是联接（可能是真实目录），保留不动：" +
                      WideToUtf8(linkPath));
            return true;
        }
        RemoveDirectoryW(linkPath.c_str());
    }

    std::wstring cmd = L"cmd.exe /c mklink /J \"" + linkPath + L"\" \"" + targetPath + L"\"";
    std::vector<wchar_t> mut(cmd.begin(), cmd.end());
    mut.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};

    if (!CreateProcessW(nullptr, mut.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                        nullptr, &si, &pi)) {
        rep->fail(kCreateFailed, "创建 ASCII 工作目录失败：无法启动 mklink（错误 " +
                                     std::to_string(GetLastError()) + "）");
        return false;
    }
    WaitForSingleObject(pi.hProcess, 10000);
    DWORD rc = 1;
    GetExitCodeProcess(pi.hProcess, &rc);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    if (rc != 0 || GetFileAttributesW(linkPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
        rep->fail(kCreateFailed, "创建 ASCII 工作目录失败：mklink /J 返回 " + std::to_string(rc) +
                                     "（目标：" + WideToUtf8(targetPath) + "）");
        return false;
    }
    rep->note("已建立 ASCII 工作目录联接：" + WideToUtf8(linkPath) + "  →  " +
              WideToUtf8(targetPath));
    return true;
}

// ── 大地址感知（largeAddressAware）─────────────────────────────────────────
//
// 干什么：给目标 exe 的 PE 头打上 IMAGE_FILE_LARGE_ADDRESS_AWARE（0x0020）
// 标志。32 位程序打开这个标志后，在 64 位 Windows 上能用满 4GB 而不是只有 2GB
// 用户空间 —— 对"加载整套汉化资源"的场景是刚需（否则很容易 OOM）。
//
// ★ 这是个**破坏性写操作**（改了目标 exe 文件本身），所以：
//   ① 改之前先把原 exe 备份成 `<名字>.bak`，且**只有不存在备份时才建** ——
//      避免连续跑两次就把"已经改过的版本"当成原始版本存下来（那样就回不去了）
//   ② 改的只是 PE 文件头 Characteristics 里的一位，不动任何代码/数据
//   ③ 全程留日志，并把"怎么还原"明确写出来
//
// 实现选择：直接改 PE 头，不调 editbin。
//   常见的做法是调用 `editbin /LARGEADDRESSAWARE`，但 editbin 属于
//   Visual Studio 命令行工具，**运行时机器上不一定有** —— 一个要发给用户跑的
//   注入器不该依赖 VS 安装。而这个标志就是 PE 头 Characteristics 的 bit 5，
//   直接写那一位与 editbin 效果完全等价，且没有外部依赖。
//   （若确实需要走 editbin 路线，可在 profile 里保留一个开关，后续再加。）

/**
 * 给 exe 打上 LARGE_ADDRESS_AWARE 标志，改前先备份。
 *
 * @param exePath 目标 exe（会被就地修改）
 * @param pe      exe 的 PE 信息（要拿 Characteristics 字段的文件偏移）
 * @return true = 已生效（含"本来就有"的情况）；false = 失败（已写 fail 说明）
 */
bool ApplyLargeAddressAware(const std::wstring& exePath, const PeInfo& pe, Reporter* rep) {
    if (!pe.valid || pe.kind != PeKind::Exe) {
        rep->fail(kBadTarget, "largeAddressAware 只对 exe 生效，当前目标不是有效 exe");
        return false;
    }

    // ★ 32 位才有意义：64 位进程天然有 8TB 用户空间，这个标志对它是空操作。
    //   显式说清楚，避免用户以为自己"优化"了 64 位游戏。
    if (pe.bits() == 64) {
        rep->note("largeAddressAware：目标是 64 位，该标志对 64 位无实际作用（天然可用大地址空间），"
                  "跳过修改。");
        return true;
    }

    if (pe.largeAddressAware) {
        rep->note("largeAddressAware：目标 exe 本来就带这个标志，无需修改。");
        return true;
    }

    const std::wstring bak = exePath + L".bak";

    // 备份（只建一次：已存在就不再覆盖，否则第二次运行会把"已修改版"当原始版存下来）
    if (GetFileAttributesW(bak.c_str()) == INVALID_FILE_ATTRIBUTES) {
        if (!CopyFileW(exePath.c_str(), bak.c_str(), TRUE)) {
            rep->fail(kBadTarget, "largeAddressAware：备份原 exe 失败（错误 " +
                                      std::to_string(GetLastError()) + "），" +
                                      "为安全起见**放弃修改**。备份目标：" + WideToUtf8(bak));
            return false;
        }
        rep->note("largeAddressAware：已备份原 exe → " + WideToUtf8(bak) +
                  "（还原方法：删掉改动后的 exe，把 .bak 改回原名）");
    } else {
        rep->note("largeAddressAware：备份已存在，保留不动 → " + WideToUtf8(bak) +
                  "（这样反复运行也不会把已改版本误存为原始版本）");
    }

    // 就地改 PE 头的那一位
    HANDLE h = CreateFileW(exePath.c_str(), GENERIC_READ | GENERIC_WRITE,
                           FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        rep->fail(kBadTarget, "largeAddressAware：打不开目标 exe 写入（错误 " +
                                  std::to_string(GetLastError()) + "）。原文件已备份，未做任何修改。");
        return false;
    }

    // Characteristics 的文件偏移由 ParsePe 算好（它知道字段布局，见 pe.h 注释）
    LARGE_INTEGER pos{};
    pos.QuadPart = static_cast<LONGLONG>(pe.characteristicsOffset);
    uint16_t chars = 0;
    DWORD got = 0;
    if (!SetFilePointerEx(h, pos, nullptr, FILE_BEGIN) ||
        !ReadFile(h, &chars, sizeof(chars), &got, nullptr) || got != sizeof(chars)) {
        rep->fail(kBadTarget, "largeAddressAware：读 PE 头失败（错误 " +
                                  std::to_string(GetLastError()) + "）。原文件已备份，未做修改。");
        CloseHandle(h);
        return false;
    }

    const uint16_t kLargeAddrAware = 0x0020;
    const uint16_t newChars = static_cast<uint16_t>(chars | kLargeAddrAware);
    if (!SetFilePointerEx(h, pos, nullptr, FILE_BEGIN) ||
        !WriteFile(h, &newChars, sizeof(newChars), &got, nullptr) || got != sizeof(newChars)) {
        rep->fail(kBadTarget, "largeAddressAware：写 PE 头失败（错误 " +
                                  std::to_string(GetLastError()) + "）。原文件已备份，可手工还原。");
        CloseHandle(h);
        return false;
    }
    CloseHandle(h);

    // ★ Hex() 自己就带 "0x" 前缀，这里不要再手写一个 —— 否则日志里
    //   会变成 `0x0x102`（本轮实测踩到的显示 bug，无害但很误导）。
    rep->note("largeAddressAware：已置位（Characteristics 0x" + Hex(chars) + " → 0x" +
              Hex(newChars) + "）。32 位程序在 64 位系统上可用内存上限从 2GB 提升到 4GB。");
    BB_LOG(L"largeAddressAware 已应用：%s，Characteristics 0x%04x → 0x%04x",
           exePath.c_str(), chars, newChars);
    return true;
}

// ── 启动脚本（makeLaunchBat）───────────────────────────────────────────────
//
// makeLaunchBat：生成一个 .bat，让用户双击就能带注入启动游戏。
//
// ★ 为什么不能只写一行 `bbInject.exe --profile xxx.json`：
//   · **代码页**：Windows 控制台的默认代码页是 936(GBK) 或 932(Shift-JIS)。
//     我们内部一律 UTF-8，且日志/JSON 都是 UTF-8。不显式 `chcp 65001`，
//     中文路径/中文日志在控制台里会变成乱码 —— 用户一看就以为程序坏了。
//   · **工作目录**：很多游戏用相对路径读自己的资源，必须在游戏目录下启动。
//     .bat 被双击时的工作目录是"它自己所在的目录"，所以要先 cd。
//   · `@echo off` + `cd /d`（/d 才能跨盘符切目录）也是这两个原因。
//
// ★ 脚本用 **UTF-8 with BOM** 存，且第一行 `chcp 65001 >nul`：
//   cmd.exe 读 .bat 时会按当前代码页解码文件内容；带 BOM 的 UTF-8 能被
//   现代 cmd 正确识别，中文路径才不会在批处理内部就被解错。

/**
 * 生成 `<游戏目录>\<游戏名>_注入启动.bat`。
 *
 * @return true = 已生成；false = 写不出来（已写 fail）
 */
bool MakeLaunchBat(const std::wstring& exePath, const std::wstring& dllPath,
                   const std::wstring& profilePath, Reporter* rep) {
    const std::wstring gameDir = DirOf(exePath);
    std::wstring base = BaseNameOf(exePath);
    const size_t dot = base.find_last_of(L'.');
    if (dot != std::wstring::npos) base.resize(dot);

    const std::wstring batPath = gameDir + L"\\" + base + L"_注入启动.bat";

    // 注入器自身的绝对路径：.bat 可能被拷到别处，用绝对路径最稳
    wchar_t selfPath[1024] = {0};
    if (GetModuleFileNameW(nullptr, selfPath, _countof(selfPath)) == 0) {
        rep->fail(kCreateFailed, "makeLaunchBat：拿不到注入器自身路径（错误 " +
                                     std::to_string(GetLastError()) + "）");
        return false;
    }

    std::wstring body;
    body += L"@echo off\r\n";
    // ① 代码页先切 UTF-8 —— 否则后面的中文全是乱码
    body += L"chcp 65001 >nul\r\n";
    body += L"rem ============================================================\r\n";
    body += L"rem  白的百宝箱 —— 游戏注入启动脚本（自动生成，可删除）\r\n";
    body += L"rem  作用：以正确的代码页和工作目录启动注入器，带汉化 hook 打开游戏。\r\n";
    body += L"rem  还原：直接删掉本文件即可；游戏本体不会被本脚本修改。\r\n";
    body += L"rem ============================================================\r\n";
    // ② /d 让 cd 能跨盘符 —— 没有 /d 时从 C: 切到 D: 会静默失败
    body += L"cd /d \"" + gameDir + L"\"\r\n";

    // 优先用 profile（能带 envAppend / needEnglishPath 等全部配置）；
    // 没有 profile 就退回 --exe/--dll 直给形式。
    if (!profilePath.empty()) {
        body += L"\"" + std::wstring(selfPath) + L"\" --profile \"" + profilePath + L"\"\r\n";
    } else {
        body += L"\"" + std::wstring(selfPath) + L"\" --exe \"" + exePath +
                L"\" --dll \"" + dllPath + L"\"\r\n";
    }
    body += L"if errorlevel 1 (\r\n";
    body += L"  echo.\r\n";
    body += L"  echo [失败] 注入没有成功，错误码 %errorlevel%。上面几行是原因。\r\n";
    body += L"  echo 日志在游戏目录的 bbinject.log，可以发给开发者。\r\n";
    body += L")\r\n";
    body += L"pause\r\n";

    // 写成 UTF-8 with BOM（EF BB BF）—— cmd 靠 BOM 判定这是 UTF-8 批处理
    FILE* f = nullptr;
    if (_wfopen_s(&f, batPath.c_str(), L"wb") != 0 || !f) {
        rep->fail(kCreateFailed, "makeLaunchBat：写不出启动脚本（错误 " +
                                     std::to_string(GetLastError()) + "）：" + WideToUtf8(batPath));
        return false;
    }
    const unsigned char bom[3] = {0xEF, 0xBB, 0xBF};
    fwrite(bom, 1, sizeof(bom), f);
    const int need = WideCharToMultiByte(CP_UTF8, 0, body.c_str(),
                                         static_cast<int>(body.size()),
                                         nullptr, 0, nullptr, nullptr);
    if (need > 0) {
        std::string utf8(static_cast<size_t>(need), '\0');
        WideCharToMultiByte(CP_UTF8, 0, body.c_str(), static_cast<int>(body.size()),
                            utf8.data(), need, nullptr, nullptr);
        fwrite(utf8.data(), 1, utf8.size(), f);
    }
    fclose(f);

    rep->note("makeLaunchBat：已生成启动脚本 → " + WideToUtf8(batPath) +
              "（含 chcp 65001 与工作目录切换；双击即可注入启动）");
    return true;
}

// ── 镜像写入 + 绝对地址修正 ────────────────────────────────────────────────

/**
 * 把位置无关的 shellcode 镜像写进目标进程，并按 kShellcodeFixes 修正绝对地址。
 *
 * ★ 为什么需要修正：x64 镜像里代码内部全是 RIP 相对引用，但 x86 镜像里引用
 *   字符串字面量用的是**绝对地址**（10 处）。镜像搬到目标进程后，
 *   那些绝对地址指向的还是**注入器进程**的旧地址 → 必崩。
 *
 * 修正公式：`写出 = 目标基址 + 镜像偏移`。
 *   这条记录是**自洽的**（同时给出"写哪里"和"写什么"），
 *   所以它不依赖链接器布局 —— 与 verify-order.mjs 验证的代码顺序假设相互独立。
 *
 * 三类修正项（`ShellcodeFix::kind`）：
 *   kind == 0  填「镜像基址 + targetOffset」—— 镜像内部的绝对地址引用
 *   kind == 1  填 `oepResume`（**外部值**）—— 镜像尾部 OEP 跳板的目标入口点
 *              它填的不是"镜像里的哪个位置"，而是目标进程原本的入口点，
 *              只有注入器知道（随 ASLR 变），所以必须单独一类。
 *   kind == 2  填 `oepResumeStack`（**外部值**）—— OEP 跳板要恢复的栈指针
 *              填的是目标主线程**原始**的 rsp/esp（注入器改 EIP 前从线程
 *              上下文里取的）。跳板用它把栈整个还原，详见下面的大段说明。
 */
bool WriteImageWithFixes(HANDLE hProcess, void* remoteBase, uint64_t oepResume,
                         uint64_t oepResumeStack, Reporter* rep, std::string* why) {
    std::vector<uint8_t> image(kShellcodeBytes, kShellcodeBytes + kShellcodeImageSize);

    uint32_t imageFixCount = 0, oepFixCount = 0, stackFixCount = 0;
    // 逐条打补丁
    // ⚠️ 条数用 kShellcodeFixCount，**不要**用 sizeof —— 没有修正时表里有一条哨兵。
    for (uint32_t i = 0; i < kShellcodeFixCount; ++i) {
        const ShellcodeFix& fx = kShellcodeFixes[i];
        if (static_cast<uint64_t>(fx.at) + fx.size > image.size()) {
            *why = "修正记录越界（构建期生成的表与镜像不匹配，请重新构建）";
            return false;
        }
        uint64_t target = 0;
        if (fx.kind == 1) {
            target = oepResume;
            ++oepFixCount;
        } else if (fx.kind == 2) {
            target = oepResumeStack;
            ++stackFixCount;
        } else {
            target = reinterpret_cast<uint64_t>(remoteBase) + fx.targetOffset;
            ++imageFixCount;
        }
        if (fx.size == 4) {
            const uint32_t v = static_cast<uint32_t>(target);
            memcpy(&image[fx.at], &v, 4);
        } else if (fx.size == 8) {
            memcpy(&image[fx.at], &target, 8);
        } else {
            *why = "不支持的修正宽度 " + std::to_string(fx.size);
            return false;
        }
    }

    if (!WriteProcessMemory(hProcess, remoteBase, image.data(), image.size(), nullptr)) {
        *why = "把 shellcode 镜像写进目标进程失败（错误 " + std::to_string(GetLastError()) + "）";
        return false;
    }

    // 报告（分三类说，便于排障时一眼看出 OEP 跳板有没有被填上）
    std::string msg = "已写入 shellcode 镜像 " + std::to_string(kShellcodeImageSize) +
                      " 字节（基址 " + Hex(reinterpret_cast<uint64_t>(remoteBase)) + "）：";
    msg += std::to_string(imageFixCount) + " 处镜像内地址修正";
    if (oepFixCount) {
        msg += " + " + std::to_string(oepFixCount) + " 处 OEP 跳板目标（入口点 " +
               Hex(oepResume) + "）";
    }
    if (stackFixCount) {
        msg += " + " + std::to_string(stackFixCount) + " 处 OEP 跳板栈指针（原始 rsp " +
               Hex(oepResumeStack) + "）";
    }
    rep->note(msg);
    return true;
}

// ── 进程内注入 ─────────────────────────────────────────────────────────────

struct InjectResult {
    bool ok = false;
    DWORD pid = 0;
    uint64_t moduleBase = 0;
    uint64_t installAddr = 0;
    std::string resolvedExport;
    uint64_t oepResume = 0;
};

/**
 * 算出一个已挂起进程的**真正入口点（OEP）地址**。
 *
 * ══ 为什么不能直接用 GetThreadContext 的 EIP/RIP ══
 *
 * 这是本项目实测踩到的一个**很反直觉**的坑：
 *
 *   `CreateProcessW(CREATE_SUSPENDED)` 返回时，主线程**并没有停在 exe 的入口点**，
 *   而是停在 `ntdll!LdrInitializeThunk` 里（加载器正在做 DLL 映射/重定位，
 *   还没轮到调用 exe 的 entry point）。
 *   实测值：`GetThreadContext` 拿到的 Eip = `0x7704c000` —— 那是 **ntdll 的地盘**，
 *   跟 toygame.exe（通常 0x400000 附近）毫无关系。
 *
 *   如果照这个值跳回去，目标会从 ntdll 的某个随机位置开始执行 → **立刻崩**。
 *   症状就是本项目遇到的"读完上下文、写完镜像、Resume 之后立刻读不到参数块
 *   （因为进程已经死了）"。
 *
 * 正确做法（两步，全部是纯内存读，不触发任何 API）：
 *   ① 从 PEB 读 `ImageBaseAddress`（PEB 偏移在 x86 是 0x08，x64 是 0x10）
 *      —— 这就是 exe 实际被加载到的基址（随 ASLR 变）
 *   ② 从 exe 的 PE 头读 `AddressOfEntryPoint`（RVA）
 *   最终 OEP = ImageBaseAddress + AddressOfEntryPoint
 *
 * 为什么不用 `EnumProcessModules` 之类的 API：那些要在目标进程里跑代码。
 * 我们自己读内存就够了，而且**和 shellcode 走同一套"手工解 PE"逻辑**，
 * 逻辑上更一致（shellcode 里也有一个解析 PE 导出表的 FindExport）。
 */
bool ComputeRemoteOep(HANDLE hProcess, bool targetIs64, uint64_t threadIp, uint64_t* oepOut,
                      Reporter* rep, std::string* why) {
    // ① 读 PEB 指针。x86（WOW64 或本机 32 位）走 FS:[0x30]，x64 走 GS:[0x60]。
    //    GetThreadContext 拿不到段基址，但可以用 **NtQueryInformationProcess**
    //    拿 PEB 地址……那又是个 API 调用。
    //
    //    更稳的办法：**从 exe 自己的 PE 头推**。但我们连 exe 基址都不知道。
    //
    //    实际最可靠、也最简单的路：用注入器自己的 PEB 拿"NtGlobalFlag"没用……
    //    —— 直接用 `NtQueryInformationProcess(ProcessBasicInformation)`，
    //    它是 ntdll 导出的**查询类** API，只读不改，且不需要在目标里执行代码。
    //    （这与"不做任何反检测/不绕缓解措施"的项目红线无关：这是正常查询。）
    using PfnNtQueryInformationProcess = LONG(WINAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    static PfnNtQueryInformationProcess pNtQip = nullptr;
    if (!pNtQip) {
        HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        if (ntdll) {
            pNtQip = reinterpret_cast<PfnNtQueryInformationProcess>(
                GetProcAddress(ntdll, "NtQueryInformationProcess"));
        }
    }
    if (!pNtQip) {
        *why = "拿不到 NtQueryInformationProcess（不认识的系统环境），无法推算目标入口点";
        return false;
    }

    // PROCESS_BASIC_INFORMATION：ProcessBasicInformation = 0
    struct ProcessBasicInfo {
        void* Reserved1;
        void* PebBaseAddress;
        void* Reserved2[2];
        ULONG_PTR UniqueProcessId;
        void* Reserved3;
    } pbi{};
    const LONG st = pNtQip(hProcess, 0, &pbi, sizeof(pbi), nullptr);
    if (st < 0 || !pbi.PebBaseAddress) {
        *why = "查询目标 PEB 失败（NTSTATUS=0x" + Hex(static_cast<uint32_t>(st)) +
               "），无法推算目标入口点";
        return false;
    }

    // ② 从 PEB 读 ImageBaseAddress
    uint64_t imageBase = 0;
    const SIZE_T ibOff = targetIs64 ? 0x10 : 0x08;   // PEB->ImageBaseAddress
    if (!ReadProcessMemory(hProcess, reinterpret_cast<uint8_t*>(pbi.PebBaseAddress) + ibOff,
                           &imageBase, targetIs64 ? 8 : 4, nullptr)) {
        *why = "读目标 PEB.ImageBaseAddress 失败（错误 " + std::to_string(GetLastError()) + "）";
        return false;
    }
    if (!imageBase) {
        *why = "目标 PEB.ImageBaseAddress 是 0（加载器还没把 exe 映射好？）";
        return false;
    }

    // ③ 从 exe 的 PE 头读 AddressOfEntryPoint
    uint8_t dosHeader[0x40] = {0};
    if (!ReadProcessMemory(hProcess, reinterpret_cast<void*>(imageBase), dosHeader,
                           sizeof(dosHeader), nullptr)) {
        *why = "读目标 exe 的 DOS 头失败（错误 " + std::to_string(GetLastError()) + "）";
        return false;
    }
    if (dosHeader[0] != 'M' || dosHeader[1] != 'Z') {
        *why = "目标的 ImageBase 处不是 MZ（PE 头读取位置不对）";
        return false;
    }
    uint32_t e_lfanew = 0;
    memcpy(&e_lfanew, dosHeader + 0x3C, 4);

    uint8_t ntSig[4] = {0};
    if (!ReadProcessMemory(hProcess, reinterpret_cast<void*>(imageBase + e_lfanew), ntSig,
                           sizeof(ntSig), nullptr) ||
        ntSig[0] != 'P' || ntSig[1] != 'E') {
        *why = "目标 exe 的 PE 签名读不到或不对";
        return false;
    }
    // AddressOfEntryPoint 在 optional header 偏移 16 处（PE32 与 PE32+ 相同）
    uint32_t entryRva = 0;
    if (!ReadProcessMemory(hProcess, reinterpret_cast<void*>(imageBase + e_lfanew + 24 + 16),
                           &entryRva, sizeof(entryRva), nullptr)) {
        *why = "读目标 exe 的 AddressOfEntryPoint 失败（错误 " +
               std::to_string(GetLastError()) + "）";
        return false;
    }
    if (!entryRva) {
        *why = "目标 exe 的 AddressOfEntryPoint 是 0（不是可执行映像？）";
        return false;
    }

    *oepOut = imageBase + entryRva;
    rep->note("目标映像基址 " + Hex(imageBase) + "，AddressOfEntryPoint " +
              Hex(entryRva) + " → 真正的 OEP " + Hex(*oepOut));
    rep->note("（对照：挂起线程当前 EIP=" + Hex(threadIp) +
              "，停在 ntdll 的加载器里，**不能**直接拿它当 OEP）");
    return true;
}

/**
 * 读主线程上下文、取出**原入口点地址**，并把执行入口改到我们的 shellcode。
 *
 * ══ 为什么必须这么做（而不是 CreateRemoteThread）══
 *
 * 约定要求："设置到**入口点前**执行 → Resume"。
 * 而 `CREATE_SUSPENDED` 时**整个进程都被冻住**——包括我们新起的远程线程：
 * 它连一次调度机会都没有，`ctx.done` 永远是 0，注入器只能超时。
 * （这不是猜的，是本项目实测到的第一个失败：
 *   `{"ok":false,"code":16,...,"errors":["读取目标进程的参数块失败"]}`。）
 *
 * 所以正确做法是改写**主线程的指令指针**：
 *   ① GetThreadContext 拿到主线程当前 CONTEXT
 *   ② 把 EIP/RIP 改到我们的 shellcode 入口
 *   ③ **同时记下当时的 rsp/esp** —— shellcode 的序言会把栈往下挪
 *      （x64 `push rbx`+`sub rsp,0x20` = 0x28；x86 `push esi` = 4），
 *      跳板必须靠这个记录值把栈**整个还原**成"内核准备调用入口点"的样子。
 *      不还原的后果见 shellcode_stub.cpp「尾部跳板」那一段：
 *      x86 侥幸能跑、x64 必崩（0xC0000005）。
 *   ④ SetThreadContext 写回
 * 之后注入器 ResumeThread，主线程就从我们的 shellcode 开始跑；
 * shellcode 干完活跳到镜像尾部的跳板，跳板恢复 rsp 后 jmp 回 oepResume。
 *
 * ⚠️ 注意 ① 里拿到的 EIP/RIP **不是入口点**（挂起态下它停在 ntdll 的
 *    加载器里），真正的入口点由 ComputeRemoteOep 从 PEB+PE 头推算。
 *    但 **rsp/esp 是可信的** —— 栈在加载器初始化入口点之前就已经建好了，
 *    它就是要交给入口点的那个栈（这点由 x64 的 16 字节对齐可交叉验证：
 *    `BaseThreadInitThunk` 在 call 入口点前保证 rsp%16==0）。
 *
 * **全程没有改动目标进程的任何一个字节代码** —— 只改了寄存器。
 * 所以"卸载后必须原样还原"这条铁律天然满足：我们本来就什么都没改。
 *
 * ctx 怎么传给 shellcode：**不走参数寄存器**，走镜像里的自举槽
 * （原因见 shellcode_stub.cpp 的 g_selfImageBase 说明：
 *   x86 参数在栈上、x64 序言会搬运，两条路都不可靠）。
 *
 * ⚠️ 为什么拆成 PeekThreadEntry / ApplyThreadEntry 两个函数：
 *   跳板要填的两个值里，`rsp`（原始栈指针）**必须由 GetThreadContext 现场取**，
 *   而它又必须写进 shellcode 镜像 —— 也就是"读上下文"要在"写镜像"之前发生。
 *   如果在同一次调用里"读上下文 → 写镜像 → 再写上下文"，
 *   中间那段写镜像的时间和目标状态无关（反正挂起着），但**代码顺序会变得难读**，
 *   而且没法把"镜像里该填什么"和"线程上下文怎么改"分开测试。
 *   拆开后职责很干净：
 *     PeekThreadEntry  —— 只读：给出 rsp、真入口点（不修改任何东西）
 *     ApplyThreadEntry —— 只写：把 EIP/RIP 指到 shellcode（不碰栈、不碰寄存器参数）
 */
struct ThreadEntryInfo {
    uint64_t originalSp = 0;    // 挂起时的 rsp/esp（跳板要用它还原栈）
    uint64_t threadIp = 0;      // 挂起时的 EIP/RIP（**不是**入口点，仅供日志对照）
    uint64_t realOep = 0;       // 从 PEB+PE 头推算出的真正入口点
};

/** 只读：取主线程的栈指针 + 推算真正的入口点。不修改目标任何状态。 */
bool PeekThreadEntry(HANDLE hProcess, HANDLE hThread, bool targetIs64,
                     ThreadEntryInfo* info, Reporter* rep, std::string* why) {
    CONTEXT actx{};
    actx.ContextFlags = CONTEXT_FULL;
    if (!GetThreadContext(hThread, &actx)) {
        *why = "读取目标主线程上下文失败（错误 " + std::to_string(GetLastError()) +
               "）。目标可能受保护，或注入器权限不足。";
        return false;
    }
#if defined(_M_X64) || defined(_M_ARM64)
    info->threadIp = actx.Rip;
    info->originalSp = actx.Rsp;
#else
    info->threadIp = actx.Eip;
    info->originalSp = actx.Esp;
#endif
    if (!ComputeRemoteOep(hProcess, targetIs64, info->threadIp, &info->realOep, rep, why)) {
        return false;
    }
    // 栈对齐自检：x64 的入口点按约定应当在 `rsp % 16 == 8`（call 压了返回地址后）
    // 或 `== 0`（尚未 call）的边界上。我们记录下来的这个值会**原样**交给入口点，
    // 所以这里先验一下有没有被别的东西搞歪；歪了就提前告警，别等目标崩了才查。
    if (targetIs64 && (info->originalSp & 0xF) != 0) {
        rep->note("⚠️ 原始 rsp " + Hex(info->originalSp) + " 不是 16 字节对齐（低 4 位 = " +
                  std::to_string(info->originalSp & 0xF) +
                  "）。x64 入口点可能使用对齐要求严格的 SSE 指令，存在崩溃风险。");
    } else {
        rep->note("原始栈指针 rsp/esp = " + Hex(info->originalSp) +
                  (targetIs64 ? "（16 字节对齐 ✓）" : "") + "，跳板会把它原样交还给入口点");
    }
    return true;
}

/** 只写：把 EIP/RIP 指到 shellcode。**不碰栈、不碰参数寄存器**（ctx 走自举槽）。 */
bool ApplyThreadEntry(HANDLE hThread, bool targetIs64, void* shellcodeEntry,
                      Reporter* rep, std::string* why) {
    CONTEXT actx{};
    actx.ContextFlags = CONTEXT_FULL;
    if (!GetThreadContext(hThread, &actx)) {
        *why = "再次读取目标主线程上下文失败（错误 " + std::to_string(GetLastError()) + "）";
        return false;
    }
#if defined(_M_X64) || defined(_M_ARM64)
    actx.Rip = reinterpret_cast<uint64_t>(shellcodeEntry);
#else
    actx.Eip = static_cast<DWORD>(reinterpret_cast<uintptr_t>(shellcodeEntry));
#endif
    if (!SetThreadContext(hThread, &actx)) {
        *why = "改写目标主线程上下文失败（错误 " + std::to_string(GetLastError()) + "）";
        return false;
    }
    rep->note("已把目标主线程入口改到 shellcode：" +
              Hex(reinterpret_cast<uint64_t>(shellcodeEntry)) +
              "（**只改了指令指针**，栈和其它寄存器原样不动）");
    return true;
}

/**
 * 在**已挂起**的进程里注入 DLL。
 *
 * 步骤（每一步都以"失败就给人话原因"为前提）：
 *   ① 读主线程上下文，取出原入口点（= 之后要跳回的地方）
 *   ② VirtualAllocEx 两块内存：ctx（参数/结果块） + code（shellcode 镜像）
 *   ③ 组装 ctx（含 oepResume / selfImageBase / oepMode=1），写进目标
 *   ④ 写镜像 + 应用绝对地址修正（含 OEP 跳板目标）
 *   ⑤ **改写主线程 EIP/RIP 指向 shellcode**（不是 CreateRemoteThread！）
 *   ⑥ 轮询 ctx.done（**不**等线程结束 —— 见文件头的时序说明）
 *
 * ★ 关键：整个函数**不 Resume 线程**。Resume 由调用方在拿到结果后统一做，
 *   这样"注入失败也必须恢复目标执行"这条不变式只有**一处**需要保证。
 */
bool InjectIntoProcess(HANDLE hProcess, HANDLE hThread, DWORD pid, bool targetIs64,
                       const std::wstring& dllPath,
                       const std::vector<ExportEntry>& dllExports,
                       const std::vector<std::string>& exportCandidates, int timeoutMs,
                       Reporter* rep, InjectResult* out) {
    out->pid = pid;

    const SIZE_T pageSize = 4096;
    const SIZE_T ctxSize = ((sizeof(ShellcodeCtx) + pageSize - 1) / pageSize) * pageSize;
    const SIZE_T codeSize =
        ((kShellcodeImageSize + 16 + pageSize - 1) / pageSize) * pageSize;

    // ① 先取主线程的**原始栈指针**和**真入口点** —— 两者都是后面要用的：
    //    · realOep       → 跳板最后跳回的地方
    //    · originalSp    → 跳板要还原的栈（**必须在写镜像之前拿到**，
    //                       因为跳板机器码里要把它填进去）
    ThreadEntryInfo entryInfo;
    {
        std::string why;
        if (!PeekThreadEntry(hProcess, hThread, targetIs64, &entryInfo, rep, &why)) {
            rep->fail(kInjectFailed, why);
            return false;
        }
        out->oepResume = entryInfo.realOep;
    }
    const uint64_t oepResume = entryInfo.realOep;
    const uint64_t oepResumeStack = entryInfo.originalSp;

    // ② 分配。参数块 RW；代码页需要 **RWX**（先写机器码再执行）
    void* remoteCtx = VirtualAllocEx(hProcess, nullptr, ctxSize, MEM_COMMIT | MEM_RESERVE,
                                     PAGE_READWRITE);
    if (!remoteCtx) {
        rep->fail(kInjectFailed, "在目标进程里分配参数块失败（错误 " +
                                     std::to_string(GetLastError()) +
                                     "）。目标可能受保护，或注入器权限不足。");
        return false;
    }

    // 代码页：内存的**末尾**留 16 字节对齐余量。
    // 为什么要对齐：x64 的 RIP 相对编码在目标未对齐时仍能工作，但把函数起始
    // 对齐到 16 字节能让指令边界更干净、也便于将来在镜像里插入 trampoline。
    void* remoteCode = VirtualAllocEx(hProcess, nullptr, codeSize, MEM_COMMIT | MEM_RESERVE,
                                      PAGE_EXECUTE_READWRITE);
    if (!remoteCode) {
        rep->fail(kInjectFailed, "在目标进程里分配代码页失败（错误 " +
                                     std::to_string(GetLastError()) +
                                     "）。常见原因：目标受保护 / 权限不足 / 被安全软件拦截。"
                                     "本工具不做任何绕过，遇到这种情况需要用户自行加白名单。");
        VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);
        return false;
    }
    rep->note("远端内存已分配：ctx=" + Hex(reinterpret_cast<uint64_t>(remoteCtx)) +
              "  code=" + Hex(reinterpret_cast<uint64_t>(remoteCode)));

    // ③ 组装 ctx
    ShellcodeCtx ctx{};
    if (dllPath.size() >= MAX_PATH) {
        rep->fail(kBadDll, "hook DLL 路径过长（" + std::to_string(dllPath.size()) + " 字符，上限 " +
                               std::to_string(MAX_PATH) + "）");
        return false;
    }
    wcsncpy(ctx.dllPath, dllPath.c_str(), MAX_PATH - 1);
    ctx.oepResume = oepResume;
    ctx.oepResumeStack = oepResumeStack;                          // ★ 跳板用它还原栈
    ctx.oepMode = 1;                                             // ★ OEP 模式
    ctx.selfImageBase = reinterpret_cast<uint64_t>(remoteCode);   // shellcode 用它算跳板地址
    ctx.trampolineAddr = reinterpret_cast<uint64_t>(remoteCode) +
                         kShellcodeTrampolineOffset;              // 尾部跳板的绝对地址

    // 入口导出：按候选名顺序找，找到哪个记哪个
    std::string chosen;
    for (const auto& c : exportCandidates) {
        if (c.empty()) continue;
        if (FindExportByNames(dllExports, {c})) {
            chosen = c;
            break;
        }
    }
    if (chosen.empty()) {
        std::string tried, actual;
        for (const auto& c : exportCandidates) {
            if (!c.empty()) { if (!tried.empty()) tried += ", "; tried += c; }
        }
        for (const auto& e : dllExports) {
            if (!actual.empty()) actual += ", ";
            actual += e.name;
        }
        rep->fail(kNoExport, "hook DLL 里找不到入口导出。试过的名字：" +
                                 (tried.empty() ? std::string("(无)") : tried) +
                                 "；DLL 实际导出：" +
                                 (actual.empty() ? std::string("(没有命名导出)") : actual));
        VirtualFreeEx(hProcess, remoteCode, 0, MEM_RELEASE);
        VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);
        return false;
    }
    strncpy(ctx.entryPoint, chosen.c_str(), sizeof(ctx.entryPoint) - 1);
    ctx.entryPointRva = FindExportByNames(dllExports, {chosen});
    ctx.rvaAdjust = 0;   // 同架构下 RVA 可直接用
    rep->note("入口导出：目标 DLL 里命中 \"" + chosen + "\"");

    if (!WriteProcessMemory(hProcess, remoteCtx, &ctx, sizeof(ctx), nullptr)) {
        rep->fail(kInjectFailed, "把参数块写进目标进程失败（错误 " + std::to_string(GetLastError()) + "）");
        VirtualFreeEx(hProcess, remoteCode, 0, MEM_RELEASE);
        VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);
        return false;
    }

    // ④ 写镜像 + 修正绝对地址（含 OEP 跳板的**入口点**与**栈指针**两个外部值）
    std::string why;
    if (!WriteImageWithFixes(hProcess, remoteCode, oepResume, oepResumeStack, rep, &why)) {
        rep->fail(kInjectFailed, why);
        VirtualFreeEx(hProcess, remoteCode, 0, MEM_RELEASE);
        VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);
        return false;
    }

    // ④b 填两个**自举槽** —— 这是 shellcode 找到 ctx 的唯一通道。
    //
    //     为什么要"填槽"而不是"寄存器传参"：OEP 模式下注入器只能改寄存器和栈，而
    //       · x86 的参数在**栈上**（cdecl/stdcall），改 EDX 根本传不进去
    //       · x64 虽是寄存器传参，但编译器序言会搬运/复用它们，**不可靠**
    //     两边都没有一条不依赖编译器行为的统一取参路。所以改成
    //     "注入器把值写进镜像里的已知偏移，shellcode 自己去读"。
    //
    //     ⚠️ 两个槽的**分工必须分清**（这里是最容易搞混的地方）：
    //       · g_selfImageBase（偏移 kShellcodeSelfBaseOffset）← 填
    //         **`&g_selfImageBase`（它自己的绝对地址）**，即"自指指针"
    //         shellcode 靠它做"位置自举"：知道自己现在被放在哪
    //       · g_bootCtxSlot（偏移 kShellcodeBootSlotOffset）← 填 **ctx 指针**
    //         shellcode 靠它拿到那个装满参数/结果的结构体
    //
    //     注意这两个变量**都在 `.bss` 里**（初值 0）—— 不是 `.data`。
    //     所以它们的字节在 .obj 里没有实体，镜像里是我们留的零填充空间；
    //     这里写进去的值就是运行时的唯一来源。
    {
        // ★ 填给 g_selfImageBase 的**不是**镜像基址，而是 `&g_selfImageBase` 的绝对地址。
        //
        //   为什么（这一处是整条自举链最反直觉的地方，写错了就直接 0xC0000005）：
        //     shellcode 里的算法是
        //         self = g_selfImageBase;                        // 取出值
        //         slotAddr = self + (&g_bootCtxSlot - &g_selfImageBase);
        //     而这个差值被编译器折叠成**常量 4**（= 0x784 - 0x780，只是两个变量
        //     在镜像里的相对距离，不含 g_selfImageBase 自己的偏移 0x780）。
        //     所以要让 slotAddr 落在真正的槽上，`self` 就必须等于
        //         &g_selfImageBase = 镜像基址 + kShellcodeSelfBaseOffset
        //     换句话说：**这个变量里装的应该是"它自己的地址"**，
        //     它就是一个"自指指针"（self-referential pointer）。
        //
        //   一开始这里填的是裸的镜像基址 remoteCode，结果 shellcode 算出
        //   slotAddr = 镜像基址 + 4 —— 落在镜像开头那条指令的中间，把它当 ctx
        //   指针解引用，目标进程当场 0xC0000005。诊断记录见 injector 文件头。
        const uint64_t selfBaseAddrValue =
            reinterpret_cast<uint64_t>(remoteCode) + kShellcodeSelfBaseOffset;
        const uint64_t ctxValue = reinterpret_cast<uint64_t>(remoteCtx);

        auto writeSlot = [&](uint32_t off, const char* what, uint64_t value, SIZE_T width) -> bool {
            const SIZE_T written = width;
            if (width == 8) {
                if (!WriteProcessMemory(hProcess,
                                        reinterpret_cast<uint8_t*>(remoteCode) + off,
                                        &value, 8, nullptr)) {
                    rep->fail(kInjectFailed, std::string("写自举槽失败（") + what +
                                                 "，错误 " + std::to_string(GetLastError()) + "）");
                    return false;
                }
            } else {
                const uint32_t v32 = static_cast<uint32_t>(value);
                if (!WriteProcessMemory(hProcess,
                                        reinterpret_cast<uint8_t*>(remoteCode) + off,
                                        &v32, 4, nullptr)) {
                    rep->fail(kInjectFailed, std::string("写自举槽失败（") + what +
                                                 "，错误 " + std::to_string(GetLastError()) + "）");
                    return false;
                }
            }
            (void)written;
            return true;
        };

        if (!writeSlot(kShellcodeSelfBaseOffset, "自举基址(&g_selfImageBase)",
                       selfBaseAddrValue, kShellcodeBootSlotSize)) {
            VirtualFreeEx(hProcess, remoteCode, 0, MEM_RELEASE);
            VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);
            return false;
        }
        if (!writeSlot(kShellcodeBootSlotOffset, "ctx 指针", ctxValue, kShellcodeBootSlotSize)) {
            VirtualFreeEx(hProcess, remoteCode, 0, MEM_RELEASE);
            VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);
            return false;
        }
        rep->note("自举槽已填：&g_selfImageBase=" + Hex(selfBaseAddrValue) +
                  "（镜像基址 " + Hex(reinterpret_cast<uint64_t>(remoteCode)) +
                  " + 0x" + Hex(kShellcodeSelfBaseOffset) + "）@+0x" +
                  Hex(kShellcodeSelfBaseOffset) + "，ctx=" + Hex(ctxValue) + " @+0x" +
                  Hex(kShellcodeBootSlotOffset));
    }

    // ⑤ 把主线程入口改到 shellcode（**不是** CreateRemoteThread，原因见函数上方注释）
    //    ★ 只改指令指针，**不碰栈、不碰参数寄存器** —— ctx 走自举槽（见上一步），
    //      栈由跳板在用完之后自己还原（用 ctx.oepResumeStack）。
    auto entry = reinterpret_cast<void*>(
        reinterpret_cast<uint8_t*>(remoteCode) + kShellcodeEntryOffset);
    if (!ApplyThreadEntry(hThread, targetIs64, entry, rep, &why)) {
        rep->fail(kInjectFailed, why);
        VirtualFreeEx(hProcess, remoteCode, 0, MEM_RELEASE);
        VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);
        return false;
    }

    // ⑥ ★ Resume 主线程 —— 这是 OEP 模式下**唯一**能让 shellcode 跑起来的方式。
    //
    //    ⚠️ 顺序不能错：必须"先 SetThreadContext 再 Resume"。
    //       反过来目标会在原入口点跑起来，我们就再也没机会插进去了。
    //
    //    ⚠️ 从这一刻起，**无论后面发生什么，线程都已经是"跑着的"** ——
    //       shellcode 一定会把它跳回原入口点（那是它在代码里写死的收尾动作），
    //       所以调用方**不需要**再补一次 Resume。这个设计让"恢复执行"这件事
    //       只有一处责任：shellcode 自己。注入器就算在这里被强杀，
    //       目标进程也已经不需要任何人帮忙了（另有看门狗兜底极端情况）。
    //
    //    为什么"失败也要 Resume"：如果 shellcode 跑失败了（比如 LoadLibrary 失败），
    //    它同样会跳回原入口点 —— 目标进程正常起来，只是没被注入钩子。
    //    **这比"让它永远挂起"好得多**：宁可游戏没汉化，也不能让用户的进程变僵尸。
    const DWORD prevSuspend = ResumeThread(hThread);
    if (prevSuspend == static_cast<DWORD>(-1)) {
        // Resume 都失败的话，shellcode 不可能执行；此时必须把镜像撤掉并报错
        const DWORD e = GetLastError();
        rep->fail(kInjectFailed, "恢复目标主线程失败（错误 " + std::to_string(e) +
                                     "）。目标进程可能已被其它工具接管或已退出。");
        VirtualFreeEx(hProcess, remoteCode, 0, MEM_RELEASE);
        VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);
        return false;
    }
    rep->note("已恢复目标主线程执行（之前挂起计数 " + std::to_string(prevSuspend) + "）");

    // ⑦ 轮询结果槽（shellcode 干完活会写 done=1，然后跳回原入口点）
    ShellcodeCtx observed{};
    const DWORD start = GetTickCount();
    const DWORD limit = static_cast<DWORD>(timeoutMs > 0 ? timeoutMs : 30000);
    bool completed = false;
    while (GetTickCount() - start < limit) {
        if (!ReadProcessMemory(hProcess, remoteCtx, &observed, sizeof(observed), nullptr)) {
            // 读不到了 = 进程大概率已经死了。**把死因捞出来**：退出码若是
            // 0xCxxxxxxx 形态，那就是崩溃（异常码），不是正常退出。
            const DWORD re = GetLastError();
            DWORD ec = 0;
            if (GetExitCodeProcess(hProcess, &ec) && ec != STILL_ACTIVE) {
                char buf[128];
                _snprintf_s(buf, _countof(buf), _TRUNCATE,
                            "读取目标进程的参数块失败（错误 %lu）。目标进程已退出，退出码 0x%08lX",
                            re, ec);
                rep->fail(kInjectFailed, buf);
                if (ec >= 0xC0000000u) {
                    rep->note("退出码落在异常区间 → 目标是在 shellcode 执行期间**崩溃**的，"
                              "不是正常退出。重点查：入口点跳转、自举槽取值、尾部跳板。");
                }
            } else {
                rep->fail(kInjectFailed, "读取目标进程的参数块失败（错误 " +
                                             std::to_string(re) + "），但进程仍存活");
            }
            // 崩溃现场信息尽量多留：ctx 里已有的字段是"死前写进去的"
            if (observed.magic == kShellcodeMagic) {
                rep->note("死前 ctx：stage=" + std::to_string(observed.stage) +
                          " done=" + std::to_string(observed.done) +
                          " lastError=" + std::to_string(observed.lastError) +
                          " badWhy=" + std::string(observed.badWhy));
            } else {
                rep->note("死前 ctx 的 magic 不对（读到 0x" +
                          [&] { char b[16]; _snprintf_s(b, _countof(b), _TRUNCATE, "%08lX",
                                                       (unsigned long)observed.magic); return std::string(b); }() +
                          "）—— 说明 shellcode **根本没跑到**写 ctx 的地方，"
                          "或者 ctx 指针本身就是错的");
            }
            return false;
        }
        if (observed.done == 1) {
            completed = true;
            break;
        }
        Sleep(20);
    }

    // 记录一下真实的模块基址（LoadLibrary 的返回值可能与 VirtualAlloc 不同）
    if (observed.moduleBase) rep->note("hook 模块基址：" + Hex(observed.moduleBase));
    if (observed.installAddr) rep->note("Install 地址：" + Hex(observed.installAddr));

    const bool stageFailed = (observed.stage == kStageFailed);
    const std::string badWhy = observed.badWhy;
    const DWORD remoteErr = observed.lastError;
    const DWORD installRes = observed.installResult;

    // 参数块功成身退，释放掉（Install 已经拿到它需要的东西）
    VirtualFreeEx(hProcess, remoteCode, 0, MEM_RELEASE);
    VirtualFreeEx(hProcess, remoteCtx, 0, MEM_RELEASE);

    if (!completed) {
        rep->fail(kTimeout, "等待注入结果超时（" + std::to_string(limit) +
                                " 毫秒）。目标进程可能正在被调试、或 shellcode 被拦截。");
        return false;
    }
    if (stageFailed) {
        rep->fail(kRemoteFailed, std::string("注入失败：") +
                                     (badWhy.empty() ? "(无原因)" : badWhy) +
                                     "，GetLastError=" + std::to_string(remoteErr));
        return false;
    }
    if (installRes != 1) {
        rep->fail(kInstallFailed,
                  std::string("hook DLL 已加载但 Install() 返回 FALSE") +
                      (badWhy.empty() ? "" : std::string("：") + badWhy) +
                      "（细节见 hook DLL 自己的日志文件）");
        return false;
    }

    out->ok = true;
    out->moduleBase = observed.moduleBase;
    out->installAddr = observed.installAddr;
    out->resolvedExport = observed.resolvedExport[0] ? observed.resolvedExport : chosen;
    return true;
}

// ── 参数解析 ───────────────────────────────────────────────────────────────

void PrintUsage() {
    const char* usage =
        "白的百宝箱 注入器 (N1)\n"
        "\n"
        "用法：\n"
        "  bbInject.exe --profile <profile.json>            按配置启动并注入\n"
        "  bbInject.exe --exe <目标.exe> --dll <hook.dll>   直接指定（自测用）\n"
        "  bbInject.exe --uninstall <pid> --dll <hook.dll>  让已注入的进程卸载 hook\n"
        "\n"
        "可选：\n"
        "  --cwd <目录>        目标进程工作目录（默认 = 目标 exe 所在目录）\n"
        "  --log <路径>        日志文件（默认写到 hook DLL 同目录的 bbinject.log）\n"
        "  --timeout <毫秒>    等待结果的超时（默认 30000）\n"
        "  --json              以 JSON 输出结果（供宿主解析）\n"
        "  --uninstall-entry <名>  卸载时调用的导出名（默认 Uninstall）\n"
        "  --help              显示本帮助\n"
        "\n"
        "退出码：0=成功 10=参数错 11=目标有问题 12=DLL 有问题 13=位数不匹配\n"
        "        14=找不到入口导出 15=创建进程失败 16=写入失败 17=远端执行失败\n"
        "        18=Install 返回 FALSE 19=超时\n"
        "        20=目标进程不存在 21=目标进程里没有我们的 DLL 22=卸载失败\n"
        "\n"
        "注意：32 位注入器注不进（也卸载不了）64 位进程，反之亦然 —— 请用对应位数的注入器。\n";
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD wrote = 0;
    if (h && h != INVALID_HANDLE_VALUE) {
        WriteFile(h, usage, static_cast<DWORD>(strlen(usage)), &wrote, nullptr);
    }
}

bool ParseArgs(int argc, wchar_t** argv, Options* o, Reporter* rep) {
    for (int i = 1; i < argc; ++i) {
        const std::wstring a = argv[i];
        auto next = [&](const char* what) -> std::wstring {
            if (i + 1 >= argc) {
                rep->fail(kBadArgs, std::string("参数 ") + what + " 后面缺值");
                return L"";
            }
            return argv[++i];
        };
        if (a == L"--profile") o->profilePath = next("--profile");
        else if (a == L"--exe") o->exePath = next("--exe");
        else if (a == L"--dll") o->dllPath = next("--dll");
        else if (a == L"--cwd") o->workDirOverride = next("--cwd");
        else if (a == L"--log") o->logPath = next("--log");
        else if (a == L"--timeout") o->timeoutMs = _wtoi(next("--timeout").c_str());
        else if (a == L"--json") o->jsonOut = true;
        // ── 卸载模式 ──
        //   --uninstall <pid>     让已注入进程执行 hook DLL 的 Uninstall()
        //   --uninstall-entry <名> 指定导出名（默认 Uninstall）
        else if (a == L"--uninstall") {
            o->uninstallPid = static_cast<DWORD>(_wtoi(next("--uninstall").c_str()));
            o->uninstall = true;
        } else if (a == L"--uninstall-entry") o->uninstallEntry = WideToUtf8(next("--uninstall-entry"));
        //   --call <pid>           在已注入进程里调用任意导出（宿主发命令用）
        //   --entry <名字>         要调用的导出名（与 --call 搭配）
        else if (a == L"--call") {
            o->remoteCallPid = static_cast<DWORD>(_wtoi(next("--call").c_str()));
            o->remoteCall = true;
        } else if (a == L"--entry") o->remoteCallEntry = WideToUtf8(next("--entry"));
        else if (a == L"--help" || a == L"-h") { PrintUsage(); exit(0); }
        else {
            rep->fail(kBadArgs, "不认识的参数：" + WideToUtf8(a));
            return false;
        }
        if (rep->code != kOk) return false;
    }
    // 卸载模式只要 pid，不需要（也不能）要 --exe：目标已经在跑了。
    if (o->uninstall) {
        if (o->uninstallPid == 0) {
            rep->fail(kBadArgs, "--uninstall 需要一个有效的进程 pid（>0）");
            return false;
        }
        if (o->dllPath.empty()) {
            rep->fail(kBadArgs,
                      "--uninstall 还需要 --dll 指明要找哪个 hook DLL"
                      "（用它来在目标进程的模块列表里认人）");
            return false;
        }
        return true;
    }
    // --call 只需要 pid + dll + 导出名（目标已经在跑，不启动新进程）
    if (o->remoteCall) {
        if (o->remoteCallPid == 0) {
            rep->fail(kBadArgs, "--call 需要一个有效的进程 pid（>0）");
            return false;
        }
        if (o->dllPath.empty()) {
            rep->fail(kBadArgs, "--call 还需要 --dll 指明要在哪个模块里找导出");
            return false;
        }
        if (o->remoteCallEntry.empty()) {
            rep->fail(kBadArgs, "--call 还需要 --entry 指明要调用哪个导出名");
            return false;
        }
        return true;
    }
    if (o->profilePath.empty() && (o->exePath.empty() || o->dllPath.empty())) {
        rep->fail(kBadArgs, "必须给 --profile，或者同时给 --exe 与 --dll（加 --help 看用法）");
        return false;
    }
    return true;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

/**
 * 看门狗：保证目标进程**绝不会**因为我们而僵死。
 *
 * 验收第 5 条："注入过程中途 kill 掉注入器，目标进程不能变成僵尸或崩溃。"
 *
 * ★ 这里有个容易做错的点，值得写下来：
 *   "在注入器里起一个看门狗线程"是**假保险** —— 那个线程属于注入器进程，
 *   注入器被任务管理器强杀时它一起消失，什么也救不了。
 *
 * 所以真正的做法是**两步**：
 *   ① 主流程无论成败都**一定**走 ResumeThread（覆盖正常/异常退出）
 *   ② 另外起一个**独立的看门狗进程**（不属于注入器）—— 注入器被强杀它还在，
 *      它能看见目标主线程"还挂着"，于是代为 Resume。
 *
 * 独立看门狗进程极小、只在注入过程中存活、完成即退，代价可以忽略。
 * ⚠️ 这个线程版只是**自测用**的壳（`--watchdog-thread` 里用），
 *    生产路径必须是**独立进程** —— 理由见下面 RunWatchdogProcess 的大段说明。
 */
struct WatchdogArg {
    DWORD injectorPid;
    DWORD pid;
    DWORD tid;
    int timeoutMs;
};

int RunWatchdogProcess(DWORD injectorPid, DWORD pid, DWORD tid, int timeoutMs);

DWORD WINAPI WatchdogProc(LPVOID param) {
    auto* wa = static_cast<WatchdogArg*>(param);
    return static_cast<DWORD>(
        RunWatchdogProcess(wa->injectorPid, wa->pid, wa->tid, wa->timeoutMs));
}

/**
 * 看门狗进程主体：只做一件事 —— 盯着注入器，它一走就确认目标没被挂着。
 *
 * 判断逻辑（两条线索配合，完整说明见函数定义处）：
 *   ① 注入器进程还活着吗？  —— 决定"该不该开始抢救"
 *        退出 → 立刻去查目标（**不等长超时**，否则游戏会僵住几十秒）
 *   ② 目标主线程被挂着吗？  —— 决定"要不要 Resume"
 *        SuspendThread 返回的 prev 为 0 → 没挂着 → 什么都不做
 *        prev >= 1                      → 挂着   → 代为清零挂起计数
 *
 * 两个线索缺一不可：
 *   · 只看 ① 会在注入器**正常收尾**时也去乱动目标（虽然无害，但没必要）
 *   · 只看 ② 会在注入器还活着、注入正在进行时误判"已经挂着很久了"而抢先 Resume
 *
 * 这个探测有副作用（多挂起一次），但我们立刻 Resume 回去，净效果为零。
 */
/**
 * ★★ 看门狗 —— 一个**独立进程**，不是线程 ★★
 *
 * 职责：注入器如果在收尾前被强杀（任务管理器结束、调试器终止、宿主崩了），
 *       我们要保证**目标进程不会永远挂着**。看门狗负责替注入器把它 Resume。
 *
 * ══ 为什么必须是独立进程，线程不行 ══
 *   "线程版看门狗"是假保险：注入器被 `TerminateProcess` 时，
 *   它**所有线程**（包括看门狗线程）会一起被杀掉，根本没机会干活。
 *   只有**独立进程**才能在父进程死后继续运行。所以注入器
 *   用 `CreateProcessW` 把自己再拉一份（同一 exe，带 `--watchdog` 参数），
 *   由那个副本承担看门狗职责。这也是为什么注入器要判断自己
 *   "是被当注入器用还是被当看门狗用" —— 见 `wmain` 里对 `--watchdog` 的处理。
 *
 * ══ 怎么判断"注入器已经收尾了" ══
 *   不能靠"注入器进程还在不在" —— 它死了就代表**没**收尾，正是我们要救的场景。
 *   改用两个客观事实配合判断：
 *
 *     (A) **注入器进程是否还活着** —— 这是"该不该救"的首要信号。
 *         父进程正常收尾后会立刻退出；被强杀也是退出。两种情况我们
 *         都不该再等下去。所以监控注入器进程的句柄：
 *           · 它还活着  → 说明注入还在进行中（或正在做收尾），我们等
 *           · 它已退出  → **立刻**去看目标挂着没有，该救就救
 *         这比"死等一个超时"好得多：注入器被强杀时，目标是**立刻**被恢复的，
 *         不会让游戏卡住几十秒。（早期版本只用一个长超时，游戏会僵住
 *         45 秒，体验上等同于卡死。）
 *
 *     (B) **目标主线程的挂起计数** —— 这是"救不救得着"的依据：
 *         · `SuspendThread(t)` 会把挂起计数 +1，返回**之前**的计数
 *         · 若返回 >= 1，说明线程原本就被挂着（注入器还没 Resume）
 *         · 若返回 0，说明线程原本在跑（注入器已 Resume 或者根本不需要 Resume）
 *       每次探测都"先加再减"，所以对目标状态**零副作用**：
 *         · `SuspendThread` → 记下 prev
 *         · `ResumeThread`  → 立刻把刚加的那一次减掉
 *         · prev == 0 → 原本没挂着 → 无事可做
 *         · prev >= 1 → 原本挂着 → 需要（且只需）一次 Resume
 *
 *   ⚠️ 实测踩到的坑：`SuspendThread` 偶尔会失败（返回 -1），
 *      这通常意味着**线程正在跑**（或正在退出）。那时候我们绝不能
 *      再去 Resume —— 多 Resume 一次会把挂起计数搞乱。
 *      所以失败就当作"线程没被挂着"处理。
 *
 * @param injectorPid 注入器自己的 pid（看门狗睁开眼第一件事就是盯住它）
 * @param timeoutMs   兜底上限：万一注入器进程句柄也拿不到，最多守这么久
 * @return 0 = 正常结束（无论有没有代为 Resume）；2 = 打不开目标/线程（无从下手）
 */
/**
 * ★★ 看门狗自测 —— 把"注入器被强杀"这一刻**确定性地**造出来 ★★
 *
 * 验收第 5 条要求："注入过程中途 kill 掉注入器，目标进程不能变成僵尸或崩溃。"
 *
 * 这条最难验的地方在于：注入器真正"挂着目标"的窗口只有微秒级
 * （从 ResumeThread 之前到 ResumeThread 之后），外部脚本根本撞不上。
 * 早先试过"起注入器，sleep 1ms，taskkill" —— 那 1ms 里注入早就做完了，
 * 测到的其实是"注入成功的正常路径"，不能证明看门狗有用。
 *
 * 所以改成**反过来做**，让本进程**扮演**一个被中途强杀的注入器：
 *   ⓪ 用 `CREATE_SUSPENDED` 启动玩具目标 —— 这天然就是
 *      "注入器已把进程建起来、还没 Resume"的状态（主线程挂起计数 = 1）。
 *   ① 拉起**真看门狗**（独立进程），让它盯住本进程（= 那个"注入器"）。
 *   ② `TerminateProcess` 把自己杀掉 —— 不给任何收尾机会，
 *      等价于被任务管理器强杀。
 *
 * 真注入器被强杀走的就是 ② 这条路。看门狗若正常，会在本进程消失的那一刻
 * 发现"注入器没了 + 目标还挂着（计数 1）"，于是代为 Resume。
 *
 * ★ 为什么自测要**自己**启动目标，而不是让脚本把 pid/tid 传进来：
 *   因为创建进程的人才知道主线程 tid（`PROCESS_INFORMATION.dwThreadId`）。
 *   让外部脚本去 tasklist/wmic 里刨 tid 既不可靠（格式随系统版本变），
 *   又容易在"探测 tid"的过程中把目标状态搞乱。自测自建自有，一步到位。
 *
 * ★ 自测**必须**在挂目标之前先把看门狗拉起来。顺序反了的话，
 *   万一拉看门狗失败，目标就真被永远挂住了 —— 自测程序把自己变成事故。
 *
 * 产出一个报告文件 `<目标exe>.wdtest.txt`，写明目标 pid/tid 与各阶段结果，
 * 供外部脚本判定（自测进程随后就自杀，stdout 不能保证刷出去）。
 *
 * @param toyPath 玩具目标 exe 的完整路径
 * @param launchWatchdog 是否真的拉起看门狗。
 *        ★ 传 false 是**阴性对照**：同样挂起启动目标、同样自杀，但不拉看门狗。
 *        这时目标应当**一直挂着**（挂起计数 ≥1、不产生自述文件）。
 *        如果阴性对照下目标居然被恢复了，说明我们的判定条件测的不是看门狗
 *        （比如有别的什么机制顺手 Resume 了），这个测试就没有鉴别力。
 * @return 正常情况**永远不会返回**（函数末尾会把自己杀掉）。
 *         真返回了说明前面某步失败，返回非 0 便于外部看出异常。
 */
int RunWatchdogSelfTest(const wchar_t* toyPath, bool launchWatchdog) {
    if (!toyPath || !*toyPath) {
        wprintf(L"[自测] 没给目标 exe 路径\n");
        return 2;
    }

    // 目标用它自己的目录当工作目录，行为最接近真实注入
    std::wstring toy = toyPath;
    std::wstring workDir = toy;
    const size_t slash = workDir.find_last_of(L"\\/");
    if (slash != std::wstring::npos) workDir.resize(slash);

    // 报告文件：和目标 exe 同目录，名字可预期，脚本好找
    std::wstring reportPath = toy + L".wdtest.txt";

    // 小工具：把宽字符串按 UTF-8 追加写入报告文件。
    // ★ 一律用二进制 "ab" + 手工 WideCharToMultiByte —— 复用踩过坑的经验：
    //   文本模式 + 宽字符格式化很容易踩 0xC0000409（无效参数导致进程被杀）。
    auto report = [&](const std::wstring& line) {
        FILE* f = nullptr;
        if (_wfopen_s(&f, reportPath.c_str(), L"ab") != 0 || !f) return;
        std::wstring s = line + L"\r\n";
        const int need = WideCharToMultiByte(CP_UTF8, 0, s.c_str(),
                                             static_cast<int>(s.size()),
                                             nullptr, 0, nullptr, nullptr);
        if (need > 0) {
            std::string buf(static_cast<size_t>(need), '\0');
            WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                                buf.data(), need, nullptr, nullptr);
            fwrite(buf.data(), 1, buf.size(), f);
        }
        fclose(f);
    };

    // 清掉上一轮的报告，避免脚本读到陈旧结果
    _wremove(reportPath.c_str());
    report(L"=== 看门狗自测报告 ===");
    report(L"注入器(自测进程) pid = " + std::to_wstring(GetCurrentProcessId()));

    // ── ⓪ 以挂起方式启动目标：这就是"改了 EIP 还没 Resume"的状态 ──
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> cmdLine(toy.begin(), toy.end());
    cmdLine.push_back(L'\0');
    if (!CreateProcessW(toy.c_str(), cmdLine.data(), nullptr, nullptr, FALSE,
                        CREATE_SUSPENDED, nullptr,
                        workDir.empty() ? nullptr : workDir.c_str(), &si, &pi)) {
        report(L"结果: 失败 —— 启动目标失败 err=" + std::to_wstring(GetLastError()));
        wprintf(L"[自测] 启动目标失败（错误 %lu）\n", GetLastError());
        return 3;
    }
    report(L"目标 pid     = " + std::to_wstring(pi.dwProcessId));
    report(L"目标主线程 tid = " + std::to_wstring(pi.dwThreadId));
    report(L"目标初始挂起计数 = 1（CREATE_SUSPENDED）");
    wprintf(L"[自测] 目标已挂起启动：pid=%lu tid=%lu\n", pi.dwProcessId, pi.dwThreadId);

    // ── ① 拉起真看门狗，让它盯住本进程 ──
    if (!launchWatchdog) {
        report(L"看门狗       = **未启动**（阴性对照：预期目标会一直被挂着）");
        wprintf(L"[自测] 阴性对照模式：不拉看门狗\n");
        Sleep(400);
        report(L"即将自杀（阴性对照）：注入器 pid=" + std::to_wstring(GetCurrentProcessId()) +
               L"，目标仍挂着（计数 1），**无看门狗**应当无人抢救");
        TerminateProcess(GetCurrentProcess(), 0xDEAD);
    }
    {
        wchar_t selfPath[1024] = {0};
        const DWORD n = GetModuleFileNameW(nullptr, selfPath, _countof(selfPath));
        if (n == 0 || n >= _countof(selfPath)) {
            report(L"结果: 失败 —— 拿不到自身路径，无法拉起看门狗");
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return 4;
        }
        const DWORD selfPid = GetCurrentProcessId();
        const wchar_t* fmt = L"\"%ls\" --watchdog %lu %lu %lu %d";
        const int need = _scwprintf(fmt, selfPath, selfPid, pi.dwProcessId,
                                    pi.dwThreadId, 60000);
        if (need <= 0) {
            report(L"结果: 失败 —— 拼看门狗命令行失败");
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return 5;
        }
        std::vector<wchar_t> wcmd(static_cast<size_t>(need) + 2);
        _snwprintf_s(wcmd.data(), wcmd.size(), _TRUNCATE, fmt, selfPath, selfPid,
                     pi.dwProcessId, pi.dwThreadId, 60000);

        STARTUPINFOW wsi{};
        wsi.cb = sizeof(wsi);
        wsi.dwFlags = STARTF_USESHOWWINDOW;
        wsi.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION wpi{};
        if (!CreateProcessW(nullptr, wcmd.data(), nullptr, nullptr, FALSE,
                            CREATE_NO_WINDOW, nullptr, nullptr, &wsi, &wpi)) {
            report(L"结果: 失败 —— 拉起看门狗失败 err=" + std::to_wstring(GetLastError()));
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return 6;
        }
        report(L"看门狗 pid   = " + std::to_wstring(wpi.dwProcessId) +
               L"（正在盯住注入器 pid=" + std::to_wstring(selfPid) + L"）");
        CloseHandle(wpi.hThread);
        CloseHandle(wpi.hProcess);   // 不等它；它会在我们死后干活然后自己退出
        wprintf(L"[自测] 看门狗已启动：pid=%lu\n", wpi.dwProcessId);
    }

    // 给看门狗时间把目标进程/线程句柄都打开
    Sleep(400);
    report(L"即将自杀：注入器 pid=" + std::to_wstring(GetCurrentProcessId()) +
           L"，目标仍挂着（计数 1）");
    wprintf(L"[自测] 0.4 秒后杀掉自己，看门狗应当立刻抢救目标…\n");
    Sleep(400);

    // ── ② 真死 —— 没有收尾、没有 CloseHandle，等价于被任务管理器强杀 ──
    TerminateProcess(GetCurrentProcess(), 0xDEAD);

    // 理论上到不了这里
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 7;
}

/**
 * 探测目标主线程的挂起计数（验收脚本用）。
 *
 * 输出一行 `SUSPEND_COUNT=<n>`：n=0 表示线程在跑（已被恢复），
 * n>=1 表示仍被挂着（看门狗失职）。
 *
 * ★ 对目标**零副作用**：先 `SuspendThread`（计数 +1、返回原值 prev），
 *   读到 prev 后立刻 `ResumeThread` 把刚加的那次减掉，净效果为零。
 * ★ 拿不到句柄时**绝不**报 0 —— 那样脚本会把"探测失败"误读成"已恢复"，
 *   反而漏掉真 bug。失败就输出 PROBE_ERROR 并返回非 0。
 */
int RunProbeSuspend(DWORD pid, DWORD tid) {
    (void)pid;
    HANDLE ht = OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION, FALSE, tid);
    if (!ht) {
        wprintf(L"PROBE_ERROR=cannot-open-thread err=%lu\n", GetLastError());
        return 2;
    }
    const DWORD prev = SuspendThread(ht);
    if (prev == static_cast<DWORD>(-1)) {
        wprintf(L"PROBE_ERROR=cannot-suspend err=%lu\n", GetLastError());
        CloseHandle(ht);
        return 3;
    }
    ResumeThread(ht);   // 还原：把我们刚加的那一次减掉
    CloseHandle(ht);
    wprintf(L"SUSPEND_COUNT=%lu\n", prev);
    return 0;
}

int RunWatchdogProcess(DWORD injectorPid, DWORD pid, DWORD tid, int timeoutMs) {
    HANDLE hThread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION, FALSE, tid);
    HANDLE hProcess = OpenProcess(SYNCHRONIZE, FALSE, pid);
    // 注入器进程：只用 SYNCHRONIZE 等它退出，不需要别的权限
    HANDLE hInjector = injectorPid ? OpenProcess(SYNCHRONIZE, FALSE, injectorPid) : nullptr;
    if (!hThread || !hProcess) {
        if (hThread) CloseHandle(hThread);
        if (hProcess) CloseHandle(hProcess);
        if (hInjector) CloseHandle(hInjector);
        return 2;
    }

    const DWORD start = GetTickCount();
    const DWORD limit = static_cast<DWORD>(timeoutMs > 0 ? timeoutMs : 60000);
    bool injectorGone = false;
    bool targetGone = false;

    for (;;) {
        Sleep(50);

        // 目标自己退了（正常退出或崩溃）→ 没有任何事需要我们做
        if (WaitForSingleObject(hProcess, 0) == WAIT_OBJECT_0) {
            targetGone = true;
            break;
        }

        // (A) 注入器还在吗？不在了就不再等 —— 这是"立即抢救"的关键。
        if (hInjector) {
            if (WaitForSingleObject(hInjector, 0) == WAIT_OBJECT_0) {
                injectorGone = true;
                break;
            }
        } else if (GetTickCount() - start >= limit) {
            // 连注入器句柄都没拿到，只能靠兜底超时
            injectorGone = true;
            break;
        }
    }

    // (B) 注入器走了（或被强杀）→ 看目标是不是还被挂着，是就救。
    //     注意：这里**不是**无条件 Resume，而是先确认"确实挂着"才动 ——
    //     注入器正常收尾的情况下，目标是没挂着的，我们一个字节都不碰。
    if (injectorGone && !targetGone) {
        const DWORD beforeSuspend = SuspendThread(hThread);
        if (beforeSuspend == static_cast<DWORD>(-1)) {
            // 挂不上 → 线程在跑 → 没被挂着 → 什么都不用做
        } else {
            // 我们的 Suspend 已经把计数 +1 了，先看看它原来是不是 0
            if (beforeSuspend == 0) {
                // 原本在跑，那这次是我们自己加的 —— 减掉，收工
                ResumeThread(hThread);
            } else {
                // 原本就被挂着（beforeSuspend >= 1）。现在总计数 = beforeSuspend + 1，
                // 我们要把它还原成"没被挂着"：需要 Resume (beforeSuspend + 1) 次。
                // 为什么是"全清"而不是"减一"：注入器可能因为异常路径留下了
                // 多次挂起，让它带着残留挂起计数跑起来后果同样是卡死。
                // 既然目标此时还没开始执行（被挂着），把计数清零是安全的。
                BB_WARN(L"看门狗：注入器已退出但目标主线程仍被挂起（原挂起计数 %lu），"
                        L"代为恢复执行", beforeSuspend);
                for (DWORD i = 0; i <= beforeSuspend; ++i) {
                    if (ResumeThread(hThread) == static_cast<DWORD>(-1)) break;
                }
            }
        }
    }

    CloseHandle(hProcess);
    CloseHandle(hThread);
    if (hInjector) CloseHandle(hInjector);
    return 0;
}

// ── 卸载（--uninstall）──────────────────────────────────────────────────────
//
// 干什么：对着一个**已经在跑、且已经注入过**的进程，让它的 hook DLL 执行
// `Uninstall()` —— 也就是"点卸载，日文立刻变回来"。
//
// ── 为什么不能简单粗暴地 FreeLibrary ──
//   FreeLibrary 只是减引用计数，**不会**撤销 MinHook 装上去的 detour：
//   已经写进 MultiByteToWideChar 开头的 5 字节跳转还在，但 detour 函数所在的
//   DLL 代码段已经被卸载 → 下一次游戏查词就是**跳到已释放内存**（必崩）。
//   所以顺序必须是"先让 DLL 自己把 hook 拆干净（Uninstall），再考虑卸载模块"。
//   本命令只做前半步，也是**更安全**的那半步 —— 模块留在进程里不影响功能。
//
// ── 怎么调到 Uninstall（不使用我们那套 OEP shellcode）──
//   OEP shellcode 是给"进程还没跑起来"的场景设计的，尾巴是一条
//   `mov rsp, 原始栈; jmp 入口点` 的跳板 —— 那是为了让主线程交还给 OEP。
//   在"进程正常运行"时我们从**新线程**进入，根本没有"要交还的入口点"，
//   跳板会把新线程的栈设成一个无意义的旧值。
//   所以这里走另一条更直接的路：
//     ① 枚举目标进程已加载模块，按文件名找到我们的 DLL → 拿到它的基址
//     ② 从远端读该模块的 PE 头 + 导出表，算出 `Uninstall` 的绝对地址
//     ③ `CreateRemoteThread` 直接以该地址为起点
//   不需要写任何代码到目标里，也不需要知道 DLL 路径（模块已经在了）。
//
// ── x86 上的一个小细节（如实说明）──
//   线程入口的签名是 `DWORD WINAPI f(LPVOID)`（1 个参数），而 `Uninstall`
//   是 0 参数 stdcall（`ret 0`）。多压的那个参数不会被清掉。
//   实践中无害：`BaseThreadInitThunk` 调用完后立刻走 `ExitThread`，
//   中途用寄存器/帧指针寻址，不等这个栈平衡。我们不为它引入更复杂的机制，
//   但要把它记在日志里，免得将来有人怀疑"为什么 x86 上栈看着不干净"。

/** 在目标进程的模块列表里按文件名找模块基址（找不到返回 0） */
uint64_t FindRemoteModuleBase(DWORD pid, const std::wstring& dllPath, Reporter* rep) {
    const std::wstring want = BaseNameOf(dllPath);
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snap == INVALID_HANDLE_VALUE) {
        // 这里最常见的失败原因是**位数不匹配**：32 位进程枚举不了 64 位进程的模块，
        // 反之亦然。给一句能直接对上号的话，而不是一个裸错误码。
        const DWORD e = GetLastError();
        rep->fail(kNotInjected,
                  "枚举目标进程的模块列表失败（错误 " + std::to_string(e) + "）。" +
                  (e == ERROR_PARTIAL_COPY || e == ERROR_BAD_LENGTH
                       ? "这通常意味着**注入器位数和目标进程不一致** —— "
                         "32 位的注入器无法枚举 64 位进程的模块。请换对应位数的 bbInject。"
                       : "请确认目标进程仍在运行且有足够权限。"));
        return 0;
    }

    uint64_t base = 0;
    MODULEENTRY32W me{};
    me.dwSize = sizeof(me);
    if (Module32FirstW(snap, &me)) {
        do {
            if (_wcsicmp(me.szModule, want.c_str()) == 0) {
                base = reinterpret_cast<uint64_t>(me.modBaseAddr);
                rep->note("在目标进程里找到模块：" + WideToUtf8(me.szModule) + " 基址 " + Hex(base));
                break;
            }
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    return base;
}

/**
 * 由一个"干净基名"生成它的候选导出名。
 *
 * ★ 为什么需要：x86 的 `__stdcall` 会把导出名**修饰**掉 ——
 *   `BOOL WINAPI Uninstall()` 在 x86 上导出的名字是 `_Uninstall@0`
 *   （下划线前缀 + @ + 参数字节数），而 x64 上就是干净的 `Uninstall`。
 *   如果只按干净名去查，x86 上永远找不到（本轮实测就是这么失败的：
 *   x64 卸载成功、x86 报"没有导出 Uninstall"）。
 *   这里把几种常见修饰形式都列出来，按顺序试 —— 和注入路径解析
 *   Install 导出时用的是同一套思路，保持一致。
 */
std::vector<std::string> DecoratedExportCandidates(const std::string& base) {
    std::vector<std::string> v;
    v.push_back(base);                              // 干净名（x64 就是它）
    v.push_back(std::string("_") + base + "@0");    // x86 stdcall，0 参数 ← Uninstall
    v.push_back(std::string("_") + base + "@4");    // x86 stdcall，1 个 32 位参数
    v.push_back(std::string("_") + base);           // x86 cdecl
    v.push_back(base + "@0");
    v.push_back(base + "@4");
    return v;
}

/**
 * 从远端模块（已映射在目标进程里）的导出表里找一个导出的绝对地址。
 *
 * 全程用 ReadProcessMemory，不改目标任何内存。
 * ★ 这里必须自己做 RVA→远端地址的加法（`modBase + rva`），
 *   因为我们读到的不是磁盘上的文件镜像，而是**已映射的镜像**，
 *   节对齐已经按 SectionAlignment 做好了 —— 好消息是导出表里存的就是 RVA，
 *   直接加模块基址即可，不需要再做 FileAlignment→SectionAlignment 的换算。
 *
 * @param candidates 候选导出名，按顺序试（第一个命中的就返回）
 */
uint64_t FindRemoteExport(HANDLE hProcess, uint64_t modBase,
                          const std::vector<std::string>& candidates, Reporter* rep) {
    auto read = [&](uint64_t addr, void* buf, SIZE_T n) -> bool {
        SIZE_T got = 0;
        return ReadProcessMemory(hProcess, reinterpret_cast<LPCVOID>(addr), buf, n, &got) &&
               got == n;
    };

    uint8_t hdr[0x1000] = {0};
    if (!read(modBase, hdr, sizeof(hdr))) {
        rep->fail(kNotInjected, "读取远端模块头失败（错误 " + std::to_string(GetLastError()) + "）");
        return 0;
    }
    if (hdr[0] != 'M' || hdr[1] != 'Z') {
        rep->fail(kNotInjected, "远端模块头不是 MZ（模块基址可能不对）");
        return 0;
    }
    uint32_t e_lfanew = 0;
    memcpy(&e_lfanew, hdr + 0x3C, 4);
    if (e_lfanew + 24 > sizeof(hdr)) {
        rep->fail(kNotInjected, "远端模块的 e_lfanew 越界");
        return 0;
    }
    uint16_t magic = 0;
    memcpy(&magic, hdr + e_lfanew + 24, 2);
    const bool pe32plus = (magic == 0x20B);
    // DataDirectory[0]（导出表）在可选头里的偏移：PE32 = +96，PE32+ = +112
    const uint32_t ddOff = e_lfanew + 24 + (pe32plus ? 112 : 96);
    uint32_t exportRva = 0;
    if (ddOff + 4 > sizeof(hdr)) {
        rep->fail(kNotInjected, "远端模块可选头越界，读不到导出表地址");
        return 0;
    }
    memcpy(&exportRva, hdr + ddOff, 4);
    if (exportRva == 0) {
        rep->fail(kNotInjected, "远端模块没有导出表");
        return 0;
    }

    // 导出目录表（IMAGE_EXPORT_DIRECTORY，40 字节）
    uint8_t dir[40] = {0};
    if (!read(modBase + exportRva, dir, sizeof(dir))) {
        rep->fail(kNotInjected, "读取远端导出目录失败（错误 " + std::to_string(GetLastError()) + "）");
        return 0;
    }
    auto u32 = [&](const uint8_t* p, size_t off) {
        uint32_t v = 0;
        memcpy(&v, p + off, 4);
        return v;
    };
    const uint32_t numberOfNames = u32(dir, 24);
    const uint32_t addressOfFunctions = u32(dir, 28);
    const uint32_t addressOfNames = u32(dir, 32);
    const uint32_t addressOfNameOrdinals = u32(dir, 36);

    // 逐个名字比对（导出数一般几十到几千，线性扫足够；不做二分以免多一种出错方式）
    // 外层扫候选名、内层扫导出表：命中的候选名会**按优先级**先被采纳。
    char nameBuf[256];
    for (const auto& want : candidates) {
        for (uint32_t i = 0; i < numberOfNames; ++i) {
            uint32_t nameRva = 0;
            if (!read(modBase + addressOfNames + i * 4, &nameRva, 4)) continue;
            if (!read(modBase + nameRva, nameBuf, sizeof(nameBuf) - 1)) continue;
            nameBuf[sizeof(nameBuf) - 1] = '\0';
            if (want != nameBuf) continue;

            uint16_t ordinal = 0;
            if (!read(modBase + addressOfNameOrdinals + i * 2, &ordinal, 2)) continue;
            uint32_t funcRva = 0;
            if (!read(modBase + addressOfFunctions + ordinal * 4, &funcRva, 4)) continue;
            if (funcRva == 0) continue;
            if (want != candidates.front()) {
                rep->note("导出名在 x86 上被 stdcall 修饰成了 \"" + want +
                          "\"，已按修饰名命中");
            }
            return modBase + funcRva;
        }
    }

    std::string tried;
    for (const auto& c : candidates) {
        if (!tried.empty()) tried += ", ";
        tried += c;
    }
    rep->fail(kNoExport, "目标进程里的 hook DLL 没有这些导出：" + tried +
                             " —— 无法卸载（可能版本不匹配）");
    return 0;
}

/**
 * 在**已在运行**的目标进程里调用 hook DLL 的某个导出函数。
 *
 * 两个入口共用这一套机制：
 *   · `--uninstall <pid>`            → 调 `Uninstall`（拆掉 hook）
 *   · `--call <pid> --entry <名字>`   → 调任意导出（宿主给被注入侧发命令用，
 *                                        例如 N2 的 `RestoreAll`）
 *
 * 机制：枚举目标模块找到 DLL 基址 → 从远端 PE 导出表算出目标函数地址 →
 * `CreateRemoteThread` 直接以它为入口（**不往目标写任何代码**）。
 * 详见函数上方的长注释。
 *
 * @param action 给用户看的动作名（"卸载" / "调用"），只影响措辞
 * @return 退出码（kOk / kNoProcess / kNotInjected / kNoExport / kUninstallFailed）
 */
int RunRemoteExportCall(DWORD pid, const std::wstring& dllPath, const std::string& entryName,
                        int timeoutMs, const std::string& action, Reporter* rep) {
    BB_TRACE(L"REMOTE-CALL: pid=%lu dll=%s entry=%S action=%S", pid, dllPath.c_str(),
             entryName.c_str(), action.c_str());

    // 先确认进程存在，并**顺手拿到它的位数**：位数不同时后面的
    // CreateToolhelp32Snapshot 会失败，但那时报出来的错很含糊，
    // 不如在这里就给出准确的诊断（和注入路径一样的"位数必须先检查"原则）。
    HANDLE hProbe = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProbe) {
        rep->fail(kNoProcess, "打不开进程 pid=" + std::to_string(pid) +
                                  "（错误 " + std::to_string(GetLastError()) +
                                  "）—— 进程可能已经退出，或权限不足。");
        return rep->code;
    }
    BOOL isWow64 = FALSE;
    const bool gotWow = IsWow64Process(hProbe, &isWow64) != 0;
    CloseHandle(hProbe);
    if (gotWow) {
        // 64 位系统上：isWow64=true → 目标 32 位；false → 目标 64 位
        const int targetBits = isWow64 ? 32 : 64;
        if (targetBits != SelfBits()) {
            rep->fail(kArchMismatch,
                      "位数不匹配：注入器是 " + std::to_string(SelfBits()) +
                          " 位，而目标进程 pid=" + std::to_string(pid) + " 是 " +
                          std::to_string(targetBits) + " 位。请换对应位数的 bbInject 卸载。");
            return rep->code;
        }
    }

    HANDLE hProcess = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                                      PROCESS_VM_READ | PROCESS_VM_OPERATION,
                                  FALSE, pid);
    if (!hProcess) {
        rep->fail(kNoProcess, "打开进程 pid=" + std::to_string(pid) +
                                  " 以执行卸载失败（错误 " + std::to_string(GetLastError()) + "）");
        return rep->code;
    }

    int rc = kOk;
    do {
        const uint64_t modBase = FindRemoteModuleBase(pid, dllPath, rep);
        if (!modBase) {
            if (rep->code == kOk) {
                rep->fail(kNotInjected,
                          "目标进程 pid=" + std::to_string(pid) + " 里没有加载 " +
                              WideToUtf8(BaseNameOf(dllPath)) +
                              " —— 它没有被注入过（或者注入的是别的 DLL）。");
            }
            rc = rep->code;
            break;
        }

        const std::vector<std::string> cands = DecoratedExportCandidates(entryName);
        const uint64_t fn = FindRemoteExport(hProcess, modBase, cands, rep);
        if (!fn) {
            rc = rep->code;
            break;
        }
        rep->note("Uninstall 地址：" + Hex(fn));

        // ★ 直接以 Uninstall 的地址为新线程入口。
        //   传入的第 4 个参数（线程参数）为 nullptr —— Uninstall 不接受参数。
        HANDLE hThread = CreateRemoteThread(hProcess, nullptr, 0,
                                            reinterpret_cast<LPTHREAD_START_ROUTINE>(fn),
                                            nullptr, 0, nullptr);
        if (!hThread) {
            rep->fail(kUninstallFailed, "在目标进程里创建" + action + "线程失败（错误 " +
                                            std::to_string(GetLastError()) + "）");
            rc = rep->code;
            break;
        }
        const DWORD wait = WaitForSingleObject(hThread, static_cast<DWORD>(timeoutMs));
        if (wait == WAIT_TIMEOUT) {
            rep->fail(kUninstallFailed, action + "线程在 " + std::to_string(timeoutMs) +
                                            " 毫秒内没有结束（被调函数里可能卡住了）");
            rc = rep->code;
        } else {
            DWORD tcode = 0;
            GetExitCodeProcess(hThread, &tcode);   // 这里其实拿的是线程退出码
            rep->note(action + "线程已结束（线程退出码 " + std::to_string(tcode) + "）");
            if (action == "卸载") {
                rep->note("已请求目标进程 pid=" + std::to_string(pid) +
                          " 执行 Uninstall —— hook 应当已拆掉，游戏回到原文");
            } else {
                rep->note("已请求目标进程 pid=" + std::to_string(pid) + " 执行 " + entryName);
            }
            rc = kOk;
        }
        CloseHandle(hThread);
    } while (false);

    CloseHandle(hProcess);
    return rc;
}

int Run(const Options& optIn, Reporter* rep) {
    // ★ 这几行**必须在最前面**：Run 里任何一步崩了，我们都要能从日志看出走到哪。
    //   所以先把日志开起来（用 stderr 路径兜底），再做别的事。
    {
        std::wstring logPath = optIn.logPath;
        if (logPath.empty()) logPath = L"bbinject-trace.log";   // 当前目录，最不可能失败
        bb::Log::open(logPath);
        BB_TRACE(L"RUN 进入：exe=%s dll=%s profile=%s", optIn.exePath.c_str(),
                 optIn.dllPath.c_str(), optIn.profilePath.c_str());
    }

    Options opt = optIn;

    BB_TRACE(L"STEP 1: 载入 profile");
    // ── 1) 载入 profile（如果有）──
    InjectProfile prof;
    if (!opt.profilePath.empty()) {
        std::string text;
        if (!ReadFileBytes(opt.profilePath, &text)) {
            rep->fail(kBadArgs, "读不到 profile 文件：" + WideToUtf8(opt.profilePath));
            return rep->code;
        }
        if (!ParseProfile(text, &prof)) {
            rep->fail(kBadArgs, "profile 不是合法 JSON 对象：" + WideToUtf8(opt.profilePath));
            return rep->code;
        }
        rep->note("已读入注入配置：" + WideToUtf8(opt.profilePath));
        for (const auto& u : prof.unsupported) {
            rep->note("⚠️  配置里的 " + u + " **本版本尚未实现**，已忽略（明确告警，不静默忽略）");
        }
        if (!prof.gameExe.empty() && opt.exePath.empty()) opt.exePath = Utf8ToWide(prof.gameExe);
        if (!prof.dllPath.empty() && opt.dllPath.empty()) opt.dllPath = Utf8ToWide(prof.dllPath);
        if (opt.workDirOverride.empty() && !prof.cwd.empty()) {
            opt.workDirOverride = Utf8ToWide(prof.cwd);
        }
        if (prof.largeAddressAware) {
            rep->note("largeAddressAware 已开启：会给目标 exe 打大地址感知标志（**改前先备份 .bak**）");
        }
        if (prof.makeLaunchBat) {
            rep->note("makeLaunchBat 已开启：注入成功后会生成「_注入启动.bat」启动脚本");
        }
        if (!prof.argAppend.empty()) {
            rep->note("argAppend（给游戏追加命令行参数）本版本尚未实现，已忽略：" + prof.argAppend);
        }
    }

    if (opt.exePath.empty() || opt.dllPath.empty()) {
        rep->fail(kBadArgs, "目标 exe 或 hook DLL 路径为空（profile 里没写、命令行也没给）");
        return rep->code;
    }

    opt.exePath = Absolute(opt.exePath);
    opt.dllPath = Absolute(opt.dllPath);

    // ── 2) 日志：**尽早打开**，后面所有步骤都留痕 ──
    {
        std::wstring logPath = opt.logPath;
        if (logPath.empty()) logPath = DirOf(opt.dllPath) + L"\\bbinject.log";
        bb::Log::open(logPath);
        BB_LOG(L"===== 白的百宝箱 注入器启动 =====");
        BB_LOG(L"注入器自身: %d 位, pid=%lu", SelfBits(), GetCurrentProcessId());
        BB_LOG(L"目标: %s", opt.exePath.c_str());
        BB_LOG(L"DLL : %s", opt.dllPath.c_str());
        BB_LOG(L"shellcode: %u 字节镜像, 入口偏移 0x%x, 符号 %u 个, 修正记录 %u 处",
               kShellcodeImageSize, kShellcodeEntryOffset, kShellcodeSymbolCount,
               kShellcodeFixCount);
        rep->note("日志：" + WideToUtf8(logPath));
    }

    BB_TRACE(L"STEP 3: 校验目标 exe");
    // ── 3) 校验目标 exe ──
    if (!FileExists(opt.exePath)) {
        rep->fail(kBadTarget, "目标程序不存在：" + WideToUtf8(opt.exePath));
        return rep->code;
    }
    std::string exeBytes;
    if (!ReadFileBytes(opt.exePath, &exeBytes)) {
        rep->fail(kBadTarget, "读不到目标程序（可能没有读权限）：" + WideToUtf8(opt.exePath));
        return rep->code;
    }
    const PeInfo exePe = ParsePe(exeBytes, "目标程序");
    if (!exePe.valid) {
        rep->fail(kBadTarget, exePe.why + "：" + WideToUtf8(opt.exePath));
        return rep->code;
    }
    if (exePe.kind == PeKind::Dll) {
        rep->fail(kBadTarget, "目标是个 DLL 而不是可执行文件：" + WideToUtf8(opt.exePath));
        return rep->code;
    }

    // ── 3b) largeAddressAware：给目标 exe 打大地址感知标志（改前先备份）──
    //   ★ 放在这里、启动进程**之前**：因为要改的是磁盘上的 exe 文件，
    //     已经启动的进程不会重新读取；而且失败时我们还没启动任何东西，好收场。
    if (prof.largeAddressAware) {
        BB_TRACE(L"STEP 3b: largeAddressAware");
        if (!ApplyLargeAddressAware(opt.exePath, exePe, rep)) {
            return rep->code;   // 明确的 fail 已经在里面写好了
        }
    }

    BB_TRACE(L"STEP 4: 校验 hook DLL + 位数检查");
    // ── 4) 校验 hook DLL + 位数检查（★ 必须在启动进程**之前**）──
    if (!FileExists(opt.dllPath)) {
        rep->fail(kBadDll, "hook DLL 不存在：" + WideToUtf8(opt.dllPath));
        return rep->code;
    }
    std::string dllBytes;
    if (!ReadFileBytes(opt.dllPath, &dllBytes)) {
        rep->fail(kBadDll, "读不到 hook DLL：" + WideToUtf8(opt.dllPath));
        return rep->code;
    }
    const PeInfo dllPe = ParsePe(dllBytes, "hook DLL");
    if (!dllPe.valid) {
        rep->fail(kBadDll, dllPe.why + "：" + WideToUtf8(opt.dllPath));
        return rep->code;
    }
    if (dllPe.kind != PeKind::Dll) {
        rep->fail(kBadDll, "hook 文件是个 exe 而不是 DLL：" + WideToUtf8(opt.dllPath));
        return rep->code;
    }

    // ★ 位数一致性三连检查（验收第 3 条："位数不匹配要明确报错"）
    if (exePe.bits() != SelfBits()) {
        rep->fail(kArchMismatch,
                  "位数不匹配：注入器是 " + std::to_string(SelfBits()) + " 位，目标程序是 " +
                      std::to_string(exePe.bits()) + " 位。" +
                      (SelfBits() == 32 ? "64 位目标请用 bbInject64.exe。"
                                        : "32 位目标请用 bbInject32.exe。") +
                      "（32 位注入器注不进 64 位进程，反之亦然 —— 这是 Windows 的硬限制）");
        return rep->code;
    }
    if (dllPe.bits() != exePe.bits()) {
        rep->fail(kArchMismatch,
                  "位数不匹配：hook DLL 是 " + std::to_string(dllPe.bits()) + " 位，目标程序是 " +
                      std::to_string(exePe.bits()) + " 位，加载必定失败。请用与目标位数一致的 hook DLL。");
        return rep->code;
    }
    rep->note("位数检查通过：注入器 " + std::to_string(SelfBits()) + " 位 / 目标 " +
              std::to_string(exePe.bits()) + " 位 / DLL " + std::to_string(dllPe.bits()) + " 位");

    BB_TRACE(L"STEP 5: 解析 DLL 导出");
    // ── 5) 解析 DLL 导出，准备候选名 ──
    //
    // 候选名顺序：配置指定 → 干净名 → stdcall 修饰名 → 带前缀名。
    // 为什么要多候选：x86 的 stdcall 会修饰成 `_Install@4`，
    // 而**实测 .def 做别名映射并不可靠**（本仓库的 toyHook.x86.def 就没生效），
    // 所以注入器必须自己兜住这几种命名。
    std::vector<ExportEntry> exports;
    uint32_t ordBase = 0, nFunc = 0;
    bool ordinalOnly = false;
    ParseExports(dllBytes, &exports, &ordBase, &nFunc, &ordinalOnly);

    std::vector<std::string> candidates;
    {
        const std::string ep = prof.entryPoints;
        size_t start = 0;
        while (start < ep.size()) {
            const size_t comma = ep.find(',', start);
            std::string one =
                ep.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
            while (!one.empty() && one.front() == ' ') one.erase(one.begin());
            while (!one.empty() && one.back() == ' ') one.pop_back();
            if (!one.empty()) candidates.push_back(one);
            if (comma == std::string::npos) break;
            start = comma + 1;
        }
        for (const char* base : {"Install", "DllInstall"}) {
            candidates.push_back(base);
            candidates.push_back(std::string("_") + base + "@4");   // stdcall + 1 个 32 位参数
            candidates.push_back(std::string("_") + base + "@0");
            candidates.push_back(std::string(base) + "@4");
        }
    }
    rep->note("DLL 命名导出 " + std::to_string(exports.size()) + " 个" +
              (ordinalOnly ? "（**只有序号导出**，没有名字 —— 无法按名字调用）" : ""));
    {
        std::string list;
        for (const auto& e : exports) {
            if (!list.empty()) list += ", ";
            list += e.name;
            if (list.size() > 400) { list += " …"; break; }
        }
        if (!list.empty()) rep->note("DLL 导出：" + list);
    }

    BB_TRACE(L"STEP 6: needEnglishPath");
    // ── 6) needEnglishPath：ASCII 工作目录 ──
    std::wstring workDir = opt.workDirOverride.empty() ? DirOf(opt.exePath) : opt.workDirOverride;
    std::wstring launchExe = opt.exePath;

    if (prof.needEnglishPath) {
        const std::wstring realDir = DirOf(opt.exePath);
        if (IsAscii(realDir) && IsAscii(BaseNameOf(opt.exePath))) {
            rep->note("needEnglishPath 已开启，但真实路径本身就是纯 ASCII，跳过联接创建");
        } else {
            wchar_t localApp[MAX_PATH] = {0};
            if (GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, MAX_PATH) == 0) {
                rep->fail(kCreateFailed, "needEnglishPath 开启但拿不到 %LOCALAPPDATA%");
                return rep->code;
            }
            const uint32_t h = Fnv1a(opt.exePath);
            char hashHex[16];
            snprintf(hashHex, sizeof(hashHex), "%08x", h);
            const std::wstring asciiRoot =
                std::wstring(localApp) + L"\\baibao\\ascii\\" + Utf8ToWide(hashHex);
            const std::wstring asciiDir = asciiRoot + L"\\game";

            if (!EnsureDir(asciiRoot)) {
                rep->fail(kCreateFailed, "无法创建 ASCII 工作根目录：" + WideToUtf8(asciiRoot));
                return rep->code;
            }
            if (!CreateJunction(asciiDir, realDir, rep)) return rep->code;

            // exe 名若含非 ASCII，用 **hardlink** 造一个 ASCII 别名。
            // （junction 只能指向目录，不能指向文件，所以文件名要单独处理。）
            const std::wstring exeName = BaseNameOf(opt.exePath);
            std::wstring effectiveName = exeName;
            if (!IsAscii(exeName)) {
                const size_t dot = exeName.find_last_of(L'.');
                const std::wstring ext = dot == std::wstring::npos ? L".exe" : exeName.substr(dot);
                char nameBuf[64];
                snprintf(nameBuf, sizeof(nameBuf), "game_%08x", h);
                effectiveName = Utf8ToWide(nameBuf) + ext;

                const std::wstring linkExe = asciiDir + L"\\" + effectiveName;
                if (!FileExists(linkExe)) {
                    if (!CreateHardLinkW(linkExe.c_str(), opt.exePath.c_str(), nullptr)) {
                        rep->note("⚠️  无法为 exe 建 ASCII 别名（CreateHardLinkW 错误 " +
                                  std::to_string(GetLastError()) +
                                  "，通常是因为跨盘符）。exe 路径仍含非 ASCII ——"
                                  "建议把游戏整个移到纯 ASCII 目录，needEnglishPath 才能完全生效。");
                        effectiveName = exeName;
                    } else {
                        rep->note("已为 exe 建立 ASCII 硬链接：" + WideToUtf8(effectiveName));
                    }
                }
            }
            launchExe = asciiDir + L"\\" + effectiveName;
            workDir = asciiDir;
            rep->note("将以 ASCII 路径启动：" + WideToUtf8(launchExe));
            if (!IsAscii(workDir)) {
                rep->note("⚠️  工作目录仍含非 ASCII 字符 —— needEnglishPath 未能完全生效");
            }
        }
    }

    BB_TRACE(L"STEP 7: 拼命令行");
    // ── 7) 拼命令行 + 环境变量 ──
    std::wstring cmdLine = L"\"" + launchExe + L"\"";
    if (!prof.argAppend.empty()) cmdLine += L" " + Utf8ToWide(prof.argAppend);

    std::vector<wchar_t> envBlock;
    if (!prof.envAppend.empty()) {
        // 复制当前环境块再覆盖/追加 —— 传 nullptr 会用父进程环境，我们要改就必须自己拼
        LPWCH rawEnv = GetEnvironmentStringsW();
        if (rawEnv) {
            const wchar_t* p = rawEnv;
            std::vector<std::wstring> items;
            while (*p) {
                const std::wstring item(p);
                items.push_back(item);
                p += item.size() + 1;
            }
            FreeEnvironmentStringsW(rawEnv);

            for (const auto& kv : prof.envAppend) {
                const std::wstring key = Utf8ToWide(kv.first);
                const std::wstring val = Utf8ToWide(kv.second);
                bool replaced = false;
                for (auto& item : items) {
                    const size_t eq = item.find(L'=');
                    if (eq == std::wstring::npos) continue;
                    if (_wcsicmp(item.substr(0, eq).c_str(), key.c_str()) == 0) {
                        item = key + L"=" + val;
                        replaced = true;
                        break;
                    }
                }
                if (!replaced) items.push_back(key + L"=" + val);
                rep->note("环境变量追加：" + kv.first + "=" + kv.second);
            }
            for (const auto& item : items) {
                envBlock.insert(envBlock.end(), item.begin(), item.end());
                envBlock.push_back(L'\0');
            }
            envBlock.push_back(L'\0');
        }
    }

    BB_TRACE(L"STEP 8: 挂起启动");
    // ── 8) 挂起启动 ──
    rep->note("以挂起方式启动目标进程（CREATE_SUSPENDED）");
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOW;
    PROCESS_INFORMATION pi{};

    std::vector<wchar_t> mutCmd(cmdLine.begin(), cmdLine.end());
    mutCmd.push_back(L'\0');
    LPVOID envPtr = envBlock.empty() ? nullptr : envBlock.data();

    // ★ 传自定义环境块时**必须**带 CREATE_UNICODE_ENVIRONMENT。
    //   漏了它的后果很隐蔽：`CreateProcessW` 会把我们那份**宽字符**环境块
    //   当成 ANSI 字节串去解析 —— 宽字符里的 0x00 高字节被当字符串结束符，
    //   整个块立刻变成"非法的环境块"，于是返回 ERROR_INVALID_PARAMETER(87)，
    //   而你盯着命令行和工作目录怎么看都是对的。
    //   （本轮实测踩到：日志显示"启动目标进程失败：见系统错误码 87"，
    //     命令与工作目录全部正常，根因就是漏了这个标志。）
    DWORD flags = CREATE_SUSPENDED;
    if (envPtr) flags |= CREATE_UNICODE_ENVIRONMENT;

    const BOOL created =
        CreateProcessW(launchExe.c_str(), mutCmd.data(), nullptr, nullptr, FALSE, flags,
                       envPtr, workDir.c_str(), &si, &pi);
    if (!created) {
        const DWORD e = GetLastError();
        std::string hint;
        switch (e) {
            case ERROR_FILE_NOT_FOUND: hint = "找不到文件（检查 --exe 与工作目录）"; break;
            case ERROR_ACCESS_DENIED: hint = "拒绝访问（可能需要管理员权限，或被安全软件拦截）"; break;
            case 740: hint = "需要提升权限（该程序要求管理员）"; break;
            case ERROR_BAD_EXE_FORMAT: hint = "不是有效的可执行文件（位数不符？文件损坏？）"; break;
            case ERROR_INVALID_PARAMETER:
                hint = "参数无效（87）。若配置里有 envAppend，检查是否漏了 "
                       "CREATE_UNICODE_ENVIRONMENT；否则检查命令行里的引号是否配对";
                break;
            default: hint = "见系统错误码 " + std::to_string(e);
        }
        rep->fail(kCreateFailed, "启动目标进程失败：" + hint + "。命令：" + WideToUtf8(cmdLine) +
                                     "，工作目录：" + WideToUtf8(workDir));
        return rep->code;
    }
    rep->note("目标已挂起启动：pid=" + std::to_string(pi.dwProcessId) +
              "，主线程 tid=" + std::to_string(pi.dwThreadId));

    // 看门狗：起一个**独立进程**（不是线程！）守住"目标主线程必须被恢复"这件事。
    // 见 RunWatchdogProcess 的注释 —— 线程版是假保险，进程版才顶用。
    //
    // ★ 关键设计：把**注入器自己的 pid** 也告诉看门狗。
    //   看门狗靠"注入器进程是否已退出"来决定何时开始抢救，所以注入器
    //   被强杀时目标是**立刻**被恢复的，不用干等几十秒。
    //   （早期版本只有一个长超时，游戏会僵住 timeout+15 秒，体验等同卡死。）
    {
        // ★ 注意缓冲要按 MAX_PATH*2 + 余量给：MAX_PATH 只是**文件名**上限，
        //   完整路径可以更长（\\?\ 形式）。写成 512 就可能在长路径下溢出，
        //   而 /GS 会直接以 0xC0000409 结束进程 —— 表现是"注入器无声退出"。
        wchar_t selfPath[1024] = {0};
        const DWORD n = GetModuleFileNameW(nullptr, selfPath, _countof(selfPath));
        if (n == 0 || n >= _countof(selfPath)) {
            rep->note("⚠️  拿不到注入器自身路径，跳过看门狗（主流程仍会 Resume）");
        } else {
            const DWORD selfPid = GetCurrentProcessId();
            std::vector<wchar_t> cmd;
            const wchar_t* fmt = L"\"%ls\" --watchdog %lu %lu %lu %d";
            int need = _scwprintf(fmt, selfPath, selfPid, pi.dwProcessId, pi.dwThreadId,
                                  opt.timeoutMs + 15000);
            if (need <= 0) {
                rep->note("⚠️  拼看门狗命令行失败，跳过看门狗");
            } else {
                cmd.resize(static_cast<size_t>(need) + 2);
                _snwprintf_s(cmd.data(), cmd.size(), _TRUNCATE, fmt, selfPath, selfPid,
                             pi.dwProcessId, pi.dwThreadId, opt.timeoutMs + 15000);
                STARTUPINFOW wsi{};
                wsi.cb = sizeof(wsi);
                wsi.dwFlags = STARTF_USESHOWWINDOW;
                wsi.wShowWindow = SW_HIDE;
                PROCESS_INFORMATION wpi{};
                if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                                   nullptr, nullptr, &wsi, &wpi)) {
                    CloseHandle(wpi.hThread);
                    CloseHandle(wpi.hProcess);
                    rep->note("看门狗进程已启动（注入器一退出它就检查目标有没有被挂着，"
                              "有就立刻代为恢复）");
                } else {
                    rep->note("⚠️  看门狗进程启动失败（错误 " + std::to_string(GetLastError()) +
                              "）—— 主流程仍会 Resume；只有在注入器被强杀时目标可能残留挂起");
                }
            }
        }
    }

    BB_TRACE(L"STEP 9: 注入");
    // ── 9) 注入 ──
    //
    // ★ 关于 Resume 的归属（这里改过一次设计，值得写清楚）：
    //
    //   旧设计：注入器"只改上下文，不 Resume"，由外层统一 Resume。
    //   新设计：**注入函数自己在 SetThreadContext 之后立即 Resume**。
    //
    //   为什么改：OEP 模式下 Resume 是"让 shellcode 跑起来"的**必要步骤**，
    //   不是"收尾动作"。如果放在外层，就成了"注入函数在等一个永远不会
    //   开始执行的东西"——顺序上根本没法自洽。
    //   改完之后，"恢复执行"这件事只剩一个责任方：**shellcode 自己跳回入口点**。
    //   所以下面外层**不再重复 Resume**，只在"注入函数连 Resume 都没走到"
    //   这种极端情况下才兜底一次（幂等：ResumeThread 对未挂起的线程返回 0）。
    InjectResult result;
    const bool ok = InjectIntoProcess(pi.hProcess, pi.hThread, pi.dwProcessId, exePe.is64,
                                      opt.dllPath, exports, candidates, opt.timeoutMs, rep,
                                      &result);

    BB_TRACE(L"STEP 10: 确认执行状态");
    // ── 10) 兜底：确认目标确实在跑 ──
    //
    // 正常情况下 shellcode 已经把它自己跳回了原入口点，这里只是**验证**一下。
    // 万一注入函数在 Resume 之前就返回了（例如读上下文失败），目标还是挂起的，
    // 这时必须补一刀 —— 否则用户看到的是"进程占着内存打不开还杀不掉"。
    {
        const DWORD prev = ResumeThread(pi.hThread);   // 未挂起时返回 0（幂等，安全）
        if (prev == static_cast<DWORD>(-1)) {
            rep->note("⚠️  恢复目标主线程失败（错误 " + std::to_string(GetLastError()) +
                      "），目标可能仍处于挂起状态");
        } else if (prev > 0) {
            rep->note("兜底恢复：目标主线程原本还有 " + std::to_string(prev) +
                      " 次挂起未释放，已代为恢复");
        }
    }

    if (ok) {
        rep->note("注入成功：模块基址 " + Hex(result.moduleBase) + "，入口导出 " +
                  result.resolvedExport + "，Install 地址 " + Hex(result.installAddr));
        rep->note("目标进程 pid=" + std::to_string(pi.dwProcessId) + " 已带着 hook 继续运行");

        // ── makeLaunchBat：生成双击即用的启动脚本 ──
        //   ★ 放在**注入成功之后**：脚本的意义是"以后能一键复现这次成功的启动"，
        //     注入都没成功就生成脚本等于给用户一个坏掉的入口。
        //   ★ 它不修改游戏本体，只是往游戏目录丢一个 .bat，删掉即还原。
        if (prof.makeLaunchBat) {
            MakeLaunchBat(opt.exePath, opt.dllPath, opt.profilePath, rep);
        }
    }

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return ok ? kOk : rep->code;
}

// ── 结果输出（人类可读 + 可选 JSON，给宿主解析）────────────────────────────
//
// 抽成独立函数是为了让"注入"和"卸载"两条路径共用同一份输出格式 ——
// 宿主 Node 侧解析 JSON 时只需要一套逻辑。
void PrintResult(const Reporter& rep, int code, bool jsonOut) {
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    std::string text;
    const char* what = rep.verb.empty() ? "操作" : rep.verb.c_str();
    auto esc = [](const std::string& s) {
        std::string o;
        for (char c : s) {
            if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(c); }
            else if (c == '\n') o += "\\n";
            else if (c == '\r') o += "\\r";
            else if (c == '\t') o += "\\t";
            else o.push_back(c);
        }
        return o;
    };
    if (jsonOut) {
        text = "{\"ok\":" + std::string(code == kOk ? "true" : "false") +
               ",\"code\":" + std::to_string(code) + ",\"codeName\":\"" +
               esc(ExitCodeName(code)) + "\",\"errors\":[";
        for (size_t i = 0; i < rep.errors.size(); ++i) {
            if (i) text += ",";
            text += "\"" + esc(rep.errors[i]) + "\"";
        }
        text += "],\"notes\":[";
        for (size_t i = 0; i < rep.notes.size(); ++i) {
            if (i) text += ",";
            text += "\"" + esc(rep.notes[i]) + "\"";
        }
        text += "]}\n";
    } else {
        text = code == kOk ? std::string("[成功] ") + what + "完成\n"
                           : std::string("[失败] ") + ExitCodeName(code) + "\n";
        for (const auto& e : rep.errors) text += "  ✗ " + e + "\n";
        for (const auto& n : rep.notes) text += "  · " + n + "\n";
    }
    DWORD wrote = 0;
    if (h && h != INVALID_HANDLE_VALUE) {
        WriteFile(h, text.data(), static_cast<DWORD>(text.size()), &wrote, nullptr);
    }
}

} // namespace bb

// ── 入口 ───────────────────────────────────────────────────────────────────

int wmain(int argc, wchar_t** argv) {
    using namespace bb;

    // ── 内部模式：独立看门狗（由主流程自己拉起来，用户不用管）──
    //   格式：bbInject.exe --watchdog <注入器pid> <目标pid> <目标主线程tid> <超时毫秒>
    //   必须**最先**处理，避免被其它参数解析干扰。
    //
    // ★ 参数有 4 个（不是 3 个）：注入器 pid 是**必需**的 ——
    //   看门狗靠"注入器进程是否已退出"来决定何时开始抢救（见 RunWatchdogProcess）。
    //   少了它，注入器被强杀时看门狗只能干等到超时，游戏会僵住几十秒。
    //   这里曾经漏改过：命令行的格式化串已经发了 4 个参数，解析却只读 3 个，
    //   结果是 targetPid/targetTid/timeoutMs 全部错位（把注入器 pid 当成了目标 pid）。
    if (argc >= 6 && std::wstring(argv[1]) == L"--watchdog") {
        const DWORD wWatchdogOwner = static_cast<DWORD>(_wtoi(argv[2]));
        const DWORD wpid = static_cast<DWORD>(_wtoi(argv[3]));
        const DWORD wtid = static_cast<DWORD>(_wtoi(argv[4]));
        const int wto = _wtoi(argv[5]);
        return RunWatchdogProcess(wWatchdogOwner, wpid, wtid, wto);
    }

    // ── 内部模式：看门狗自测（验收第 5 条用）──
    //   格式：bbInject.exe --watchdog-test <注入器pid> <目标pid> <目标主线程tid>
    //   目的：把"注入器被强杀"这一刻**确定性地**造出来，而不是靠外部抢时序。
    //   做法：本进程（扮演注入器）先把目标主线程 SuspendThread 挂住 ——
    //         模拟"改完 EIP、还没 Resume"的窗口，然后把**自己**杀掉。
    //         看门狗若正常，会在我们死掉的那一刻立刻把目标恢复执行。
    //   注意：这里"杀掉自己"必须是真死（TerminateProcess），
    //         否则函数返回后我们还能自己把目标 Resume，测不出看门狗。
    // ── 内部模式：看门狗自测（验收第 5 条用）──
    //   格式：bbInject.exe --watchdog-test <玩具目标exe路径> [--no-watchdog]
    //   自测进程**自己**挂起启动目标、自己拉起看门狗、然后自杀，
    //   全过程写进 `<目标exe>.wdtest.txt`。详见 RunWatchdogSelfTest 的说明。
    //   加 `--no-watchdog` 走**阴性对照**（不拉看门狗，目标应当一直挂着），
    //   用来证明这套判定确实能区分"看门狗干了活"和"没干"。
    if (argc >= 3 && std::wstring(argv[1]) == L"--watchdog-test") {
        bool launchWatchdog = true;
        for (int i = 3; i < argc; ++i) {
            if (std::wstring(argv[i]) == L"--no-watchdog") launchWatchdog = false;
        }
        return RunWatchdogSelfTest(argv[2], launchWatchdog);
    }

    // ── 内部模式：探测目标主线程的挂起计数（验收脚本用）──
    //   格式：bbInject.exe --probe-suspend <pid> <tid>
    //   输出 `SUSPEND_COUNT=<n>`（n=0 表示线程在跑）。零副作用，详见函数说明。
    if (argc >= 4 && std::wstring(argv[1]) == L"--probe-suspend") {
        const DWORD ppid = static_cast<DWORD>(_wtoi(argv[2]));
        const DWORD ptid = static_cast<DWORD>(_wtoi(argv[3]));
        return RunProbeSuspend(ppid, ptid);
    }

    Options opt;
    Reporter rep;

    if (!ParseArgs(argc, argv, &opt, &rep)) {
        PrintUsage();
        return rep.code;
    }

    // ── 卸载模式走独立分支：目标进程已经在跑，不启动新进程 ──
    if (opt.uninstall) {
        rep.verb = "卸载";
        opt.dllPath = Absolute(opt.dllPath);
        {
            std::wstring logPath = opt.logPath;
            if (logPath.empty()) logPath = DirOf(opt.dllPath) + L"\\bbinject.log";
            bb::Log::open(logPath);
            BB_LOG(L"===== 白的百宝箱 卸载 (N1) =====");
            BB_LOG(L"目标 pid : %lu", opt.uninstallPid);
            BB_LOG(L"DLL      : %s", opt.dllPath.c_str());
            BB_LOG(L"导出名   : %S", opt.uninstallEntry.c_str());
        }
        const int ucode = RunRemoteExportCall(opt.uninstallPid, opt.dllPath,
                                              opt.uninstallEntry, opt.timeoutMs, "卸载", &rep);
        PrintResult(rep, ucode, opt.jsonOut);
        return ucode;
    }

    // ── 远程调用模式：在已注入进程里调任意导出（宿主给被注入侧发命令）──
    if (opt.remoteCall) {
        rep.verb = "调用";
        opt.dllPath = Absolute(opt.dllPath);
        {
            std::wstring logPath = opt.logPath;
            if (logPath.empty()) logPath = DirOf(opt.dllPath) + L"\bbinject.log";
            bb::Log::open(logPath);
            BB_LOG(L"===== 白的百宝箱 远程调用 (N2) =====");
            BB_LOG(L"目标 pid : %lu", opt.remoteCallPid);
            BB_LOG(L"DLL      : %s", opt.dllPath.c_str());
            BB_LOG(L"导出名   : %S", opt.remoteCallEntry.c_str());
        }
        const int ccode = RunRemoteExportCall(opt.remoteCallPid, opt.dllPath, opt.remoteCallEntry,
                                              opt.timeoutMs, "调用", &rep);
        PrintResult(rep, ccode, opt.jsonOut);
        return ccode;
    }

    const int code = Run(opt, &rep);
    PrintResult(rep, code, opt.jsonOut);

    if (code != kOk) {
        BB_ERR(L"===== 注入失败，退出码 %d (%s) =====", code, Utf8ToWide(ExitCodeName(code)).c_str());
        for (const auto& e : rep.errors) BB_ERR(L"  %s", Utf8ToWide(e).c_str());
    } else {
        BB_LOG(L"===== 注入成功，退出码 0 =====");
    }
    bb::Log::close();
    return code;
}
