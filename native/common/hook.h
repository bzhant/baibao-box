// MinHook 薄封装。
//
// 工程铁律（参考项目宪法）：**任何 hook 都必须能干净卸载** ——
// 用户点"卸载"后游戏要立刻恢复正常，内存里的补丁要能原样还原。
// 所以这里把 attach/detach 成对管理，卸载时按**逆序**还原。
#pragma once

#include <windows.h>
#include <string>
#include <vector>
#include "MinHook.h"
#include "log.h"

namespace bb {

class HookEngine {
public:
    static bool install() {
        if (started()) return true;
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) {
            BB_ERR(L"MH_Initialize 失败: %d (%S)", int(st), statusText(st));
            return false;
        }
        started() = true;
        BB_LOG(L"MinHook 初始化完成");
        return true;
    }

    /** 挂一个 hook。成功返回 true，original 拿到原始函数指针。 */
    static bool attach(const char* name, LPVOID target, LPVOID detour, LPVOID* original) {
        if (!target) {
            BB_ERR(L"hook [%S] 失败：目标函数不存在（GetProcAddress 返回空）", name);
            return false;
        }
        MH_STATUS st = MH_CreateHook(target, detour, original);
        if (st != MH_OK) {
            BB_ERR(L"hook [%S] MH_CreateHook 失败: %d (%S)", name, int(st), statusText(st));
            return false;
        }
        st = MH_EnableHook(target);
        if (st != MH_OK) {
            BB_ERR(L"hook [%S] MH_EnableHook 失败: %d (%S)", name, int(st), statusText(st));
            return false;
        }
        installed().push_back({name, target});
        BB_LOG(L"hook [%S] 安装成功 @ %p → detour %p", name, target, detour);
        return true;
    }

    /** 卸载单个 hook */
    static bool detach(LPVOID target) {
        MH_STATUS st = MH_DisableHook(target);
        if (st != MH_OK) {
            BB_WARN(L"MH_DisableHook 失败: %d (%S)", int(st), statusText(st));
        }
        st = MH_RemoveHook(target);
        if (st != MH_OK) {
            BB_ERR(L"MH_RemoveHook 失败: %d (%S)", int(st), statusText(st));
            return false;
        }
        return true;
    }

    /** 卸载全部（**逆序**还原），并反初始化 MinHook */
    static void uninstallAll() {
        for (auto it = installed().rbegin(); it != installed().rend(); ++it) {
            if (detach(it->target)) BB_LOG(L"hook [%S] 已卸载", it->name.c_str());
            else                  BB_ERR(L"hook [%S] 卸载失败", it->name.c_str());
        }
        installed().clear();
        if (started()) {
            MH_Uninitialize();
            started() = false;
            BB_LOG(L"MinHook 已反初始化");
        }
    }

    /** 目标进程里没有这个导出？记录下来，便于排障（而不是静默失败） */
    static LPVOID resolve(const wchar_t* module, const char* proc) {
        HMODULE mod = GetModuleHandleW(module);
        if (!mod) {
            BB_WARN(L"模块 %s 未加载", module);
            return nullptr;
        }
        LPVOID p = reinterpret_cast<LPVOID>(GetProcAddress(mod, proc));
        if (!p) BB_WARN(L"模块 %s 里找不到导出 %S", module, proc);
        return p;
    }

private:
    struct Entry { std::string name; LPVOID target; };
    static std::vector<Entry>& installed() { static std::vector<Entry> v; return v; }
    static bool& started() { static bool b = false; return b; }

    static const char* statusText(MH_STATUS st) {
        switch (st) {
            case MH_OK: return "OK";
            case MH_ERROR_ALREADY_INITIALIZED: return "ALREADY_INITIALIZED";
            case MH_ERROR_NOT_INITIALIZED: return "NOT_INITIALIZED";
            case MH_ERROR_ALREADY_CREATED: return "ALREADY_CREATED";
            case MH_ERROR_NOT_CREATED: return "NOT_CREATED";
            case MH_ERROR_ENABLED: return "ENABLED";
            case MH_ERROR_DISABLED: return "DISABLED";
            case MH_ERROR_NOT_EXECUTABLE: return "NOT_EXECUTABLE";
            case MH_ERROR_UNSUPPORTED_FUNCTION: return "UNSUPPORTED_FUNCTION";
            case MH_ERROR_MEMORY_ALLOC: return "MEMORY_ALLOC";
            case MH_ERROR_MEMORY_PROTECT: return "MEMORY_PROTECT";
            case MH_ERROR_MODULE_NOT_FOUND: return "MODULE_NOT_FOUND";
            case MH_ERROR_FUNCTION_NOT_FOUND: return "FUNCTION_NOT_FOUND";
            default: return "UNKNOWN";
        }
    }
};

} // namespace bb
