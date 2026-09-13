// 注入配置（profile.json）—— **字段为固定规格**，不自行设计。
//
// 一份与游戏绑定的注入配置如下：
//   { "injectAtOEP":true, "makeLaunchBat":true, "lazyInject":false,
//     "injectOnTheFly":false, "waitExternalInject":false,
//     "largeAddressAware":false, "argAppend":"",
//     "constArgs":{ "gameExe":"", "dllPath":"", "is64Bit":true,
//                   "needEnglishPath":false, "needEnglishExe":false,
//                   "engPathRegxp":null, "envAppend":{} } }
//
// 我们**全部解析**（兼容优先：外部工具生成的 profile 也能直接读进来对照），
// 但只**实现**当前里程碑需要的字段，未实现的字段解析出来标记 unsupported 并告警 ——
// 而不是假装支持（静默忽略配置是最坑人的做法）。
#pragma once

#include <string>
#include <vector>
#include "json.h"
#include "log.h"

namespace bb {

struct InjectProfile {
    // 顶层
    bool injectAtOEP = true;
    bool makeLaunchBat = false;
    bool lazyInject = false;
    bool injectOnTheFly = false;
    bool waitExternalInject = false;
    bool largeAddressAware = false;
    std::string argAppend;

    // constArgs
    std::string gameExe;
    std::string dllPath;
    bool is64Bit = true;
    bool needEnglishPath = false;
    bool needEnglishExe = false;
    std::string engPathRegxp;      // 空 = null
    bool hasEngPathRegxp = false;
    std::vector<std::pair<std::string, std::string>> envAppend;

    // 本项目自己的扩展（可选；标准 profile 里没有）
    /** hook DLL 里要在目标进程里调的导出名，逗号分隔。空则按默认候选名找。 */
    std::string entryPoints;
    /** 目标进程的工作目录（相对 gameExe 所在目录）。空 = gameExe 所在目录 */
    std::string cwd;

    /** 解析时发现"认识但没实现"的开关，逐条列出，打印告警 */
    std::vector<std::string> unsupported;
};

/** 从 JSON 文本解析 profile。返回 false 表示不是合法 JSON 对象。 */
inline bool ParseProfile(const std::string& text, InjectProfile* out) {
    json::Value root;
    if (!json::parseOk(text, &root) || !root.isObject()) return false;

    auto b = [&](const char* k, bool d) {
        const json::Value* v = root.find(k);
        return (v && v->isBool()) ? v->asBool() : d;
    };
    auto s = [&](const char* k, const std::string& d) {
        const json::Value* v = root.find(k);
        return (v && v->isString()) ? v->asString() : d;
    };

    out->injectAtOEP = b("injectAtOEP", true);
    out->makeLaunchBat = b("makeLaunchBat", false);
    out->lazyInject = b("lazyInject", false);
    out->injectOnTheFly = b("injectOnTheFly", false);
    out->waitExternalInject = b("waitExternalInject", false);
    out->largeAddressAware = b("largeAddressAware", false);
    out->argAppend = s("argAppend", "");
    out->entryPoints = s("entryPoints", "");
    out->cwd = s("cwd", "");

    if (const json::Value* ca = root.find("constArgs"); ca && ca->isObject()) {
        auto cb = [&](const char* k, bool d) {
            const json::Value* v = ca->find(k);
            return (v && v->isBool()) ? v->asBool() : d;
        };
        out->gameExe = ca->getString("gameExe", "");
        out->dllPath = ca->getString("dllPath", "");
        out->is64Bit = cb("is64Bit", true);
        out->needEnglishPath = cb("needEnglishPath", false);
        out->needEnglishExe = cb("needEnglishExe", false);
        if (const json::Value* r = ca->find("engPathRegxp"); r && r->isString()) {
            out->engPathRegxp = r->asString();
            out->hasEngPathRegxp = true;
        }
        if (const json::Value* env = ca->find("envAppend"); env && env->isObject()) {
            for (const auto& kv : *env->obj) {
                out->envAppend.emplace_back(kv.first, kv.second.asString());
            }
        }
    }

    // 明确标出"认识但本里程碑还没做"的开关 —— 不静默忽略
    if (out->lazyInject) out->unsupported.push_back("lazyInject（延迟注入）");
    if (out->injectOnTheFly) out->unsupported.push_back("injectOnTheFly（运行时按需注入）");
    if (out->waitExternalInject) out->unsupported.push_back("waitExternalInject（等待外部注入）");
    if (out->needEnglishExe) out->unsupported.push_back("needEnglishExe（英文副本 exe）");

    return true;
}

} // namespace bb
