// 日志 —— 注入类工具的"救命稻草"。
//
// 为什么要单独一套：hook 运行在**别人的进程**里，没有控制台、不能 printf 调试。
// 出问题时唯一能看的就是日志文件。工程约定也把"所有 hook 安装过程必须写结构化日志"
// 列为工程铁律。
//
// ══════════════════════════════════════════════════════════════════════════
//  ★★★ 两个实测踩到的坑，必须写下来（否则每个人都会再踩一次）★★★
// ══════════════════════════════════════════════════════════════════════════
//
// 【坑 1】窄字符 vfprintf + %ls → 稳定崩溃 0xC0000409
//
//   最初用窄字符 `vfprintf`，调用点写 `BB_LOG("%ls", wstring.c_str())` 想打印宽字符串。
//   MSVC 的 `vfprintf` 遇到 `%ls` 走 `wctomb_s` 这条窄转换路径，而 `%s` / `%ls`
//   的宽度处理在这个组合下不可靠（不同 CRT 版本行为还不同）→ `/GS` cookie 破裂。
//
//   → 结论：**日志永远走宽字符格式化**，调用点用 `%s` 传 `wchar_t*`。
//     另：`%zu` 在 MSVC 宽字符格式化里也不稳，统一 `%u` + static_cast。
//
// 【坑 2】`_wfopen(path, L"a+, ccs=UTF-8")` 之后 `fwrite` 原始 UTF-8 字节 → 崩溃 0xC0000409
//
//   这是**最阴的一个**，因为它只在写"非 ASCII 的 UTF-8 多字节序列"时才炸：
//     · 用 `ccs=UTF-8` 打开 → CRT 给这个 FILE 装了一套**编码转换状态**（wide-oriented）
//     · 此时 `fwrite` 的字节被 CRT 当成"待转换的字符流"处理，而不是原样落盘
//     · 写纯 ASCII 恰好能过（所以日志头看起来正常，给了假象）
//     · 一旦写中文/日文的 UTF-8 字节 → 走 CRT 内部 `wctomb` 路径 → 越界 → 0xC0000409
//
//   实测证据（`native/_repro_log.cpp`，可复现）：
//     A: 程序启动
//     B: _wfopen(ccs=UTF-8) OK
//     C: fwprintf + fflush 完成
//     D: _snwprintf_s 返回 33
//     E: fwrite("纯 ASCII") 完成        ← 过
//     F: WC2MB 返回 19
//     ✗ 崩在 fwrite(UTF-8 多字节)        ← 就是这里
//
//   → 结论：**日志文件用纯二进制模式 `"ab"` 打开，所有写入一律走 `fwrite`**。
//     绝不用 `ccs=` 编码模式，也不混用 `fwprintf` / `fwrite`。
//     宽 → UTF-8 的转换**自己用 WideCharToMultiByte 做**，只有一行、完全可控、不会崩。
//
// 【坑 3】宽格式化里的 `%S`（窄字符串）会按**系统 ANSI 代码页**去解码
//
//   约定是"`%s` 传 `wchar_t*`"（见坑 1 的结论），但偶尔会有人用 `%S` 传窄字符串。
//   MSVC 在宽格式化里遇到 `%S`，会用**当前 locale**（默认 "C"）把窄字节转成宽字符，
//   而那实际就是 **ANSI 代码页**（简体中文机器上是 GBK）。
//   于是：传进去的 UTF-8 日文/中文被当成 GBK 解 → 解出的乱码再写成 UTF-8 →
//   日志里出现"二次编码"的乱码（字节形如 C3 A3 C2 83 …，用文本编辑器看是 ã©ã³…）。
//
//   实测踩到：运行时取词的日志用 `%S` 传了 UTF-8 原文，验收脚本按日文去 grep
//   **一条都匹配不上**，看起来像"功能没生效" —— 差点去查一个并不存在的功能 bug。
//
//   → 结论：**要打 UTF-8 的窄字符串，先自己转成宽字符，再用 `%s` 传。**
//     宽→宽这条路不经过任何 locale 转换，是安全的。
//
// 【本文件因此遵守的两条硬性规则】
//   ① 格式化只在**内存里**做（`_vsnwprintf_s`），落盘只走 `fwrite`。
//   ② 文件永远以 `"ab"`（二进制追加）打开，不设任何 `ccs=`。
// ══════════════════════════════════════════════════════════════════════════
#pragma once

#include <windows.h>
#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <string>

namespace bb {

/**
 * 以**纯二进制追加**方式打开日志文件，并在文件为空时写 UTF-8 BOM。
 *
 * 为什么单独抽出来、且用 `_wfsopen(_SH_DENYWR)` 而不是 `_wfopen`：
 *   · 注入类工具会被**多个进程同时**打开同一份日志（注入器 + 被注入的 hook DLL）
 *     或同一进程多线程写 → 共享追加是必须的（`_wfopen` 默认就是共享，够用）
 *   · 关键是**不用 `ccs=UTF-8`**（见文件头【坑 2】）
 *   · BOM 只在新建文件时写一次，否则记事本打开会串码
 */
inline void bb_detail_openFile(FILE*& out, const wchar_t* path) {
    out = nullptr;
    // "ab" = 追加 + 二进制。没有 ccs=，CRT 不会插入任何编码转换层。
    if (_wfopen_s(&out, path, L"ab") != 0 || out == nullptr) {
        out = nullptr;
        return;
    }
    // 只在空文件时补 BOM
    if (ftell(out) == 0) {
        static const unsigned char kBom[3] = {0xEF, 0xBB, 0xBF};
        fwrite(kBom, 1, sizeof(kBom), out);
    }
    fseek(out, 0, SEEK_END);
}

class Log {
public:
    // 打开日志文件。path 建议放在宿主能读到的地方（如 %TEMP%\baibao\xxx.log）。
    static void open(const std::wstring& path) {
        std::lock_guard<std::mutex> lk(mu());
        if (fp()) return;

        // ★ 纯二进制追加模式（**不写 ccs=**，见文件头【坑 2】）
        bb_detail_openFile(fp(), path.c_str());
        if (!fp()) return;

        SYSTEMTIME st; GetLocalTime(&st);
        wchar_t head[256];
        _snwprintf_s(head, _countof(head), _TRUNCATE,
                     L"\n===== %04d-%02d-%02d %02d:%02d:%02d 日志开始 =====",
                     st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
        writeLine(head);
    }

    static void close() {
        std::lock_guard<std::mutex> lk(mu());
        if (fp()) { fclose(fp()); fp() = nullptr; }
    }

    /** 立刻把缓冲区刷到磁盘（崩溃前保命用） */
    static void flush() {
        std::lock_guard<std::mutex> lk(mu());
        if (fp()) fflush(fp());
    }

    static bool enabled() { return fp() != nullptr; }

    /**
     * 写一条日志。fmt 与参数都是**宽字符语义**：
     *   %s  → const wchar_t*      <<< 注意！不是 char*（宽字符上下文里 %s 就是宽串）
     *   %S  → const char*         <<< 窄串要用**大写** S
     *   %u / %d / %x → 整数（size_t 请自己 static_cast 成 unsigned）
     *   %p  → 指针
     *
     * 实现上先在**内存里**格式化（_vsnwprintf_s），再转 UTF-8 落盘（见文件头两条规则）。
     */
    static void write(const wchar_t* level, const wchar_t* fmt, ...) {
        std::lock_guard<std::mutex> lk(mu());
        if (!fp()) return;

        wchar_t line[4096];
        SYSTEMTIME st; GetLocalTime(&st);
        int n = _snwprintf_s(line, _countof(line), _TRUNCATE,
            L"[%02d:%02d:%02d.%03d][pid=%lu][%s] ",
            st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
            static_cast<unsigned long>(GetCurrentProcessId()), level);
        if (n < 0) n = 0;

        va_list ap; va_start(ap, fmt);
        const int m = _vsnwprintf_s(line + n, _countof(line) - static_cast<size_t>(n), _TRUNCATE,
                                    fmt, ap);
        va_end(ap);
        if (m > 0) n += m;
        if (n >= static_cast<int>(_countof(line)) - 1) {
            // 被截断了，加个标记让人知道
            line[_countof(line) - 6] = L'…';
            line[_countof(line) - 5] = L'\n';
            line[_countof(line) - 4] = L'\0';
        }
        writeLine(line);
    }

private:
    static FILE*& fp() { static FILE* f = nullptr; return f; }
    static std::mutex& mu() { static std::mutex m; return m; }

    /** 宽串 → UTF-8 字节 → fwrite。**不用 CRT 的编码转换**（见【坑 2】） */
    static void writeLine(const wchar_t* text) {
        FILE* f = fp();
        if (!f) return;

        char utf8[16384];
        const int bytes = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8,
                                              sizeof(utf8) - 1, "?", nullptr);
        if (bytes <= 1) { // 只有结尾 0（或失败）→ 至少保证换行
            fputc('\n', f);
            fflush(f);
            return;
        }
        fwrite(utf8, 1, static_cast<size_t>(bytes - 1), f);  // -1 去掉结尾 0
        fputc('\n', f);
        fflush(f);
    }
};

} // namespace bb

// ── 调用点宏 ────────────────────────────────────────────────────────────────
//
// ★ 格式串**必须自己带 L**（宽字符字面量），宏**不做** L## 拼接。
//   为什么不用 `L##fmt` 那种写法：那样只能收裸字面量，一旦调用点写 `L"..."`，
//   宏展开就成了 `LL"..."` —— 编译报 "LL: 未声明的标识符"，非常难看出原因。
//   反过来要求调用点自己带 L，好处是：
//     ① 类型在**调用点**就看得见（编译器也能直接对着字面量做参数检查）
//     ② 需要动态格式串时（`const wchar_t* fmt = ...`）也能直接用，不被宏卡住
//
// 参数语义（宽字符上下文）：
//   %s  → const wchar_t*      <<< 注意！不是 char*
//   %S  → const char*         <<< 窄串要用大写 S
//   %u / %d / %x → 整数（size_t 请自己 static_cast<unsigned>）
//   %p  → 指针
//
// 这些规则**故意**搞得很显眼：把类型搞错时编译就报错，而不是留到运行时崩
// —— 这正是我们踩过 0xC0000409 之后的选择。

#define BB_LOG(fmt, ...)  ::bb::Log::write(L"INFO",  fmt, ##__VA_ARGS__)
#define BB_WARN(fmt, ...) ::bb::Log::write(L"WARN",  fmt, ##__VA_ARGS__)
#define BB_ERR(fmt, ...)  ::bb::Log::write(L"ERROR", fmt, ##__VA_ARGS__)

/**
 * 排障用的"路径点"日志：**先落盘再继续**。
 *
 * 为什么需要单独的宏：如果程序在下一步就崩了（缓冲区溢出 / 空指针），
 * 缓冲区里的日志**一起没了** —— 你只能看到"日志文件是空的"，
 * 完全不知道它走到哪一步。所以在关键路径上用这个，宁可多几次 fflush。
 */
#define BB_TRACE(fmt, ...)                                                          \
    do {                                                                            \
        ::bb::Log::write(L"TRACE", fmt, ##__VA_ARGS__);                              \
        ::bb::Log::flush();                                                          \
    } while (0)
