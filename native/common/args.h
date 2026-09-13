// 极简命令行参数解析（**不引任何第三方**）。
//
// 唯一值得写下来的点：**Windows 的 wmain 拿到的 argv 与 main 不同** ——
// 它是按宽字符 split 过的，空格与引号的处理和 CRT 的 ANSI 版本有细微差别。
// 我们不做花哨的转义解析，只支持 `--key value` 与 `--flag` 两种形式，
// 这样跨架构、跨 CRT 版本的行为完全一致。
//
// 本文件目前只提供 main/wmain 的包装与 UTF-8 输出辅助，解析逻辑在各程序内。
#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>

namespace bb {

/** 把宽字符串输出到控制台（若没有控制台则忽略） */
inline void WriteOutW(const std::wstring& w) {
    if (w.empty()) return;
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!h || h == INVALID_HANDLE_VALUE) return;
    DWORD wrote = 0;
    WriteConsoleW(h, w.c_str(), static_cast<DWORD>(w.size()), &wrote, nullptr);
}

/** 把 UTF-8 字符串按原样写 stdout（调用方保证编码） */
inline void WriteOut(const std::string& s) {
    if (s.empty()) return;
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!h || h == INVALID_HANDLE_VALUE) return;
    DWORD wrote = 0;
    WriteFile(h, s.data(), static_cast<DWORD>(s.size()), &wrote, nullptr);
}

} // namespace bb
