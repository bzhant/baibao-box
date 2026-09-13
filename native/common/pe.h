// 最小 PE 解析 —— 只读头部，不用来加载。
//
// 我们只需要回答四个问题（都是"注不进去"的常见根因）：
//   1. 这文件是 PE 吗？（不是 → 明说"不是 PE 文件"，别静默失败）
//   2. 是 exe 还是 dll？
//   3. 多少位？（32/64 与目标进程不匹配 → 直接放弃，否则注进去必崩）
//   4. DLL 导出表里有没有我们要的那个函数？（x86 的 stdcall 会修饰名字）
//
// 为什么不自己写 PE 手动映射（manual mapping）：
//   有两条可选路径 —— 全手动映射，或 LoadLibraryW + 极小 shellcode。
//   我们**实测后选了后者**（理由见 native/README.md "注入方式" 一节）：
//     · 手动映射要自己处理重定位、导入表、TLS 回调、SEH 表、CFG 表，
//       漏一个就是"偶发崩溃"；而我们的 hook DLL 依赖 MSVC 运行库 + MinHook + ws2_32，
//       手工搬进来的成本远大于收益。
//     · LoadLibraryW 由 loader 走完整加载流程，DLL 里可以正常用 CRT。
//     · 我们**不用**老式的 "把 DLL 路径写进目标内存再 CreateRemoteThread(LoadLibraryW)"
//       —— 那样目标进程会死等 loader 锁（见 injector.cpp 的注释）。
//       我们改成"注入一段自己会 LoadLibrary + GetProcAddress + 调 Install + 报错回家"的 shellcode。
#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace bb {

enum class PeKind { NotPe, Exe, Dll };

struct PeInfo {
    PeKind kind = PeKind::NotPe;
    bool is64 = false;          // 只对 PE 有意义
    bool valid = false;
    /** 解析失败的人话原因（valid=false 时填） */
    std::string why;

    /**
     * COFF 文件头里 `Characteristics` 字段在**文件中的字节偏移**。
     *
     * ★ 为什么把这个偏移算好存下来，而不是让调用方自己数：
     *   它 = e_lfanew + 4(签名) + 18。中间隔着 Machine(2)、NumberOfSections(2)、
     *   TimeDateStamp(4)、PointerToSymbolTable(4)、NumberOfSymbols(4)、
     *   SizeOfOptionalHeader(2) 共 18 字节。这种"数结构体字段"的算术
     *   一旦写错就是**静默改坏目标 exe 的其它字段**（不报错、但文件坏了），
     *   所以在解析 PE 的地方一次算对、存成显式字段最安全。
     */
    uint32_t characteristicsOffset = 0;

    /** 是否已带 IMAGE_FILE_LARGE_ADDRESS_AWARE（0x0020）—— largeAddressAware 用 */
    bool largeAddressAware = false;

    int bits() const { return is64 ? 64 : 32; }
};

/** 只读方式把整个文件读进内存（失败返回空） */
inline bool ReadFileBytes(const std::wstring& path, std::string* out) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        out->clear();
        return false;
    }
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(h, &size) || size.QuadPart <= 0 || size.QuadPart > (256LL << 20)) {
        CloseHandle(h);
        out->clear();
        return false;
    }
    out->resize(static_cast<size_t>(size.QuadPart));
    DWORD read = 0;
    const BOOL ok = ReadFile(h, &(*out)[0], static_cast<DWORD>(out->size()), &read, nullptr);
    CloseHandle(h);
    if (!ok) {
        out->clear();
        return false;
    }
    out->resize(read);
    return true;
}

/**
 * 解析 PE 头。`what` 只用于生成人话错误信息（"目标程序"/"hook DLL"）。
 */
inline PeInfo ParsePe(const std::string& buf, const char* what) {
    PeInfo info;

    // MZ
    if (buf.size() < 0x40 || buf[0] != 'M' || buf[1] != 'Z') {
        info.why = std::string(what) + "不是 PE 文件（缺 MZ 头）";
        return info;
    }
    uint32_t e_lfanew = *reinterpret_cast<const uint32_t*>(buf.data() + 0x3C);
    if (e_lfanew + 4 + 20 > buf.size()) {
        info.why = std::string(what) + "的 PE 头偏移越界（文件可能被截断）";
        return info;
    }
    const char* p = buf.data() + e_lfanew;
    if (!(p[0] == 'P' && p[1] == 'E' && p[2] == 0 && p[3] == 0)) {
        info.why = std::string(what) + "不是 PE 文件（缺 PE\\0\\0 签名）";
        return info;
    }

    const uint16_t machine = *reinterpret_cast<const uint16_t*>(p + 4);
    switch (machine) {
        case 0x014C: info.is64 = false; break;  // IMAGE_FILE_MACHINE_I386
        case 0x8664: info.is64 = true;  break;  // IMAGE_FILE_MACHINE_AMD64
        case 0xAA64: info.is64 = true;  break;  // ARM64（本机用不到，但别误判成 32 位）
        default:
            info.why = std::string(what) + "的机器类型未知（machine=0x" +
                       std::to_string(machine) + "）";
            return info;
    }

    const uint16_t characteristics = *reinterpret_cast<const uint16_t*>(p + 22);
    info.kind = (characteristics & 0x2000) ? PeKind::Dll : PeKind::Exe;
    // Characteristics 文件偏移 = e_lfanew + 4(PE\0\0) + 18（见字段注释）
    info.characteristicsOffset = e_lfanew + 4 + 18;
    info.largeAddressAware = (characteristics & 0x0020) != 0;
    info.valid = true;
    return info;
}

// ── 导出表解析（为了拿到 DllMain 的加载基址 + 按多候选名找导出）───────────

struct ExportEntry {
    std::string name;
    uint32_t rva = 0;
};

/**
 * 读导出表。
 *
 * 注意：dll 可能**只有序号导出、没有名字** —— 这种情况下 `named=false`，
 * 注入器仍可以通过序号（ordinal）去找。真实世界的 hook DLL 导出名五花八门，
 * 我们不能假设自己写的那两个名字一定在。
 */
inline bool ParseExports(const std::string& buf, std::vector<ExportEntry>* names,
                         uint32_t* ordinalBase, uint32_t* numberOfFunctions,
                         bool* anyOrdinalOnly) {
    names->clear();
    *ordinalBase = 0;
    *numberOfFunctions = 0;
    *anyOrdinalOnly = false;

    if (buf.size() < 0x40) return false;
    uint32_t e_lfanew = *reinterpret_cast<const uint32_t*>(buf.data() + 0x3C);
    if (e_lfanew + 24 > buf.size()) return false;

    const char* nt = buf.data() + e_lfanew;
    const uint16_t optMagic = *reinterpret_cast<const uint16_t*>(nt + 24);
    const bool pe32Plus = (optMagic == 0x20B);

    // 数据目录 #0 = 导出表。PE32 的目录起始偏移 96，PE32+ 是 112。
    const size_t dirOff = e_lfanew + 24 + (pe32Plus ? 112 : 96);
    if (dirOff + 8 > buf.size()) return false;

    const uint32_t expRva = *reinterpret_cast<const uint32_t*>(buf.data() + dirOff);
    const uint32_t expSize = *reinterpret_cast<const uint32_t*>(buf.data() + dirOff + 4);
    if (expRva == 0 || expSize == 0) return false;   // 没有导出表

    // RVA → 文件偏移：遍历节表
    const uint16_t numSections = *reinterpret_cast<const uint16_t*>(nt + 6);
    const uint16_t optSize = *reinterpret_cast<const uint16_t*>(nt + 20);
    const size_t secOff = e_lfanew + 24 + optSize;

    auto rvaToOff = [&](uint32_t rva, size_t need) -> bool {
        for (int i = 0; i < numSections; ++i) {
            const size_t so = secOff + static_cast<size_t>(i) * 40;
            if (so + 40 > buf.size()) break;
            const uint32_t vsize = *reinterpret_cast<const uint32_t*>(buf.data() + so + 8);
            const uint32_t vaddr = *reinterpret_cast<const uint32_t*>(buf.data() + so + 12);
            const uint32_t rawSize = *reinterpret_cast<const uint32_t*>(buf.data() + so + 16);
            const uint32_t rawPtr = *reinterpret_cast<const uint32_t*>(buf.data() + so + 20);
            const uint32_t span = vsize > rawSize ? vsize : rawSize;
            if (rva < vaddr || rva >= vaddr + span) continue;
            const size_t off = rawPtr + (rva - vaddr);
            return off + need <= buf.size();
        }
        return false;
    };

    // IMAGE_EXPORT_DIRECTORY
    size_t dir = 0;
    if (!rvaToOff(expRva, 40)) return false;
    dir = 0;
    for (int i = 0; i < numSections; ++i) {
        const size_t so = secOff + static_cast<size_t>(i) * 40;
        const uint32_t vsize = *reinterpret_cast<const uint32_t*>(buf.data() + so + 8);
        const uint32_t vaddr = *reinterpret_cast<const uint32_t*>(buf.data() + so + 12);
        const uint32_t rawSize = *reinterpret_cast<const uint32_t*>(buf.data() + so + 16);
        const uint32_t rawPtr = *reinterpret_cast<const uint32_t*>(buf.data() + so + 20);
        const uint32_t span = vsize > rawSize ? vsize : rawSize;
        if (expRva >= vaddr && expRva < vaddr + span) {
            dir = rawPtr + (expRva - vaddr);
            break;
        }
    }
    if (dir == 0 || dir + 40 > buf.size()) return false;

    const uint32_t base = *reinterpret_cast<const uint32_t*>(buf.data() + dir + 16);
    const uint32_t nFunc = *reinterpret_cast<const uint32_t*>(buf.data() + dir + 20);
    const uint32_t nName = *reinterpret_cast<const uint32_t*>(buf.data() + dir + 24);
    const uint32_t addrFuncRva = *reinterpret_cast<const uint32_t*>(buf.data() + dir + 28);
    const uint32_t addrNameRva = *reinterpret_cast<const uint32_t*>(buf.data() + dir + 32);
    const uint32_t addrOrdRva = *reinterpret_cast<const uint32_t*>(buf.data() + dir + 36);

    *ordinalBase = base;
    *numberOfFunctions = nFunc;
    if (nName > 0 && rvaToOff(addrNameRva, nName * 4u) && rvaToOff(addrOrdRva, nName * 2u) &&
        rvaToOff(addrFuncRva, nFunc * 4u)) {
        size_t nameOff = 0, ordOff = 0, funcOff = 0;
        for (int i = 0; i < numSections; ++i) {
            const size_t so = secOff + static_cast<size_t>(i) * 40;
            const uint32_t vsize = *reinterpret_cast<const uint32_t*>(buf.data() + so + 8);
            const uint32_t vaddr = *reinterpret_cast<const uint32_t*>(buf.data() + so + 12);
            const uint32_t rawSize = *reinterpret_cast<const uint32_t*>(buf.data() + so + 16);
            const uint32_t rawPtr = *reinterpret_cast<const uint32_t*>(buf.data() + so + 20);
            const uint32_t span = vsize > rawSize ? vsize : rawSize;
            if (addrNameRva >= vaddr && addrNameRva < vaddr + span) nameOff = rawPtr + (addrNameRva - vaddr);
            if (addrOrdRva >= vaddr && addrOrdRva < vaddr + span) ordOff = rawPtr + (addrOrdRva - vaddr);
            if (addrFuncRva >= vaddr && addrFuncRva < vaddr + span) funcOff = rawPtr + (addrFuncRva - vaddr);
        }
        for (uint32_t i = 0; i < nName; ++i) {
            const uint32_t nrva = *reinterpret_cast<const uint32_t*>(buf.data() + nameOff + i * 4);
            const uint16_t ord = *reinterpret_cast<const uint16_t*>(buf.data() + ordOff + i * 2);
            if (ord >= nFunc) continue;
            const uint32_t frva = *reinterpret_cast<const uint32_t*>(buf.data() + funcOff + ord * 4);
            size_t no = 0;
            for (int k = 0; k < numSections; ++k) {
                const size_t so = secOff + static_cast<size_t>(k) * 40;
                const uint32_t vsize = *reinterpret_cast<const uint32_t*>(buf.data() + so + 8);
                const uint32_t vaddr = *reinterpret_cast<const uint32_t*>(buf.data() + so + 12);
                const uint32_t rawSize = *reinterpret_cast<const uint32_t*>(buf.data() + so + 16);
                const uint32_t rawPtr = *reinterpret_cast<const uint32_t*>(buf.data() + so + 20);
                const uint32_t span = vsize > rawSize ? vsize : rawSize;
                if (nrva >= vaddr && nrva < vaddr + span) { no = rawPtr + (nrva - vaddr); break; }
            }
            if (no == 0 || no >= buf.size()) continue;
            const char* s = buf.data() + no;
            size_t maxLen = buf.size() - no;
            std::string name;
            for (size_t c = 0; c < maxLen && s[c]; ++c) name.push_back(s[c]);
            names->push_back({name, frva});
        }
    }
    if (names->empty() && nFunc > 0) *anyOrdinalOnly = true;
    return true;
}

/**
 * 按**多候选名**找导出。返回 0 表示没找到。
 *
 * 候选名的顺序即优先级。x86 的 stdcall 会有 `_Install@4` 这种修饰，
 * 我们**没有依赖 .def 一定能改名成功**（实测过 x86 上 .def 别名不生效），
 * 所以调用方要一次给全候选名。
 */
inline uint32_t FindExportByNames(const std::vector<ExportEntry>& names,
                                  const std::vector<std::string>& candidates) {
    for (const auto& want : candidates) {
        for (const auto& e : names) {
            if (e.name == want) return e.rva;
        }
    }
    return 0;
}

} // namespace bb
