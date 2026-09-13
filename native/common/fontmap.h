// ============================================================================
// 字体替换与缺字兜底（N2.4）
// ============================================================================
//
// 字体替换有三种手段，按优先级：
//   ① **替换游戏的字体文件**（最彻底：游戏自己加载的字体就是中文字体）
//   ② hook `CreateFontIndirectA/W` 改字体族名（配置项 `fixFontName`，默认"黑体"）
//       —— 不改磁盘文件，只在运行时把"创建字体"的请求改掉
//   ③ **缺字时用内嵌的 CJK 字体做 fallback**
//
// ── 我们这一版做到哪 ──
//   ② 与 ③ 的**决策与状态管理**在本文件（纯逻辑、可自检）；
//   ② 的实际 hook 装在 hook DLL 里（`hooks/toy/toyHook.cpp`）；
//   ① 需要分发字体文件，本版本只做**"登记 + 可还原"的框架**，
//      不实际复制/替换字体文件 —— 因为分发字体涉及授权，
//      在没确认字体许可证之前不该往游戏目录里塞文件。
//      （这一点在日志里明确说明，不假装支持。）
//
// ── 关键设计：**任何替换都必须可一键还原** ──
//   验收第 4 条就是"提供'全部还原'命令，字体和字号都回到原始状态"。
//   所以这里把"原始字体"和"当前生效的覆盖"分开存，
//   `Restore()` 直接把覆盖丢掉即可 —— 不存在"还原得不干净"。
#pragma once

#include <string>
#include <vector>

#include "measure.h"

namespace bb {

struct FontResolveOptions {
    /**
     * 替换用的字体族名。
     *
     * 配置项名是 `fixFontName`，默认值 **"黑体"**。
     * 为什么默认黑体：它是 Windows 自带、覆盖 GB2312+ 常用字、
     * 且字形在低分辨率下比宋体清楚（游戏字号通常不大）。
     */
    std::wstring fixFontName = L"黑体";

    /**
     * 缺字兜底字体（对应"内嵌 CJK 字体 fallback"）。
     *
     * 本版本用系统里的"宋体"扮演这个角色：它扫描范围比黑体更全
     * （生僻字覆盖更广），适合做最后的兜底。
     * 将来接上内嵌的 Noto Sans CJK SC 子集时，把这个字段换成内嵌字体即可，
     * 上层的决策逻辑一行都不用改。
     */
    std::wstring fallbackFace = L"宋体";

    /** 是否**强制**替换（不看有没有缺字，一律换成 fixFontName） */
    bool forceReplace = false;

    /** 每行最大字数（透传给排版，不属于字体决策，但一起带着方便）
     *  —— 这里不存，避免职责混杂；排版参数在 wrap.h 的 WrapOptions 里。*/
};

struct FontSubstitution {
    bool substituted = false;   // 是否发生了替换
    FontSpec chosen;            // 最终该用哪套字体
    int method = 0;             // 0=不换 1=fixFontName 2=fallbackFace
    std::string reason;         // 人话原因（写日志 / 显示给用户）

    const char* MethodName() const {
        switch (method) {
            case 1: return "fixFontName（按配置换字体）";
            case 2: return "fallback（缺字兜底字体）";
            default: return "不替换";
        }
    }
};

/**
 * 字体决策器。
 *
 * 无状态（不持有覆盖），只回答"给定文本该用哪套字体"。
 * 状态在 `FontOverrideState` 里，这样"决策"和"生效/还原"可以分开测。
 */
class FontResolver {
public:
    /** 找出文本里在当前字体下缺字形的字符（按出现顺序去重） */
    std::vector<wchar_t> FindMissingGlyphs(TextMeasure& m, const FontSpec& font,
                                           const std::wstring& text) const {
        std::vector<wchar_t> missing;
        for (wchar_t c : text) {
            if (c == L'\r' || c == L'\n') continue;
            bool seen = false;
            for (wchar_t x : missing) {
                if (x == c) { seen = true; break; }
            }
            if (seen) continue;
            if (!m.HasGlyph(font, c)) missing.push_back(c);
        }
        return missing;
    }

    /**
     * 决定该用哪套字体。
     *
     * 决策顺序（按既定优先级）：
     *   ① 配置要求强制替换 → 换 `fixFontName`
     *   ② 原字体有缺字 → 先试 `fixFontName`（顺手把日文字体也换掉），
     *      若它仍然缺字 → 再用 `fallbackFace` 兜底
     *   ③ 都不缺 → 不换（**不制造无谓的改动**）
     */
    FontSubstitution Resolve(TextMeasure& m, const FontSpec& gameFont, const std::wstring& text,
                             const FontResolveOptions& opt) const {
        FontSubstitution r;
        r.chosen = gameFont;

        // ① 强制替换
        if (opt.forceReplace) {
            FontSpec f = gameFont;
            f.face = opt.fixFontName;
            // ★ charset 必须跟着改：原字体是 SHIFTJIS_CHARSET 时，
            //   拿它去建中文字体，GDI 会去"日文字体里找中文字形"，多半找不到。
            f.charset = DEFAULT_CHARSET;
            r.substituted = true;
            r.chosen = f;
            r.method = 1;
            r.reason = "配置要求强制替换（forceReplace）";
            return r;
        }

        const auto missing = FindMissingGlyphs(m, gameFont, text);
        if (missing.empty()) {
            r.reason = "原字体覆盖完整，不替换";
            return r;
        }

        // ② 原字体缺字 → 试 fixFontName
        {
            FontSpec f = gameFont;
            f.face = opt.fixFontName;
            f.charset = DEFAULT_CHARSET;
            const auto miss2 = FindMissingGlyphs(m, f, text);
            if (miss2.empty()) {
                r.substituted = true;
                r.chosen = f;
                r.method = 1;
                r.reason = "原字体缺 " + std::to_string(missing.size()) + " 个字形，改用 " +
                           Utf8(opt.fixFontName) + " 后完整覆盖";
                return r;
            }
        }

        // ③ 兜底字体
        {
            FontSpec f = gameFont;
            f.face = opt.fallbackFace;
            f.charset = DEFAULT_CHARSET;
            const auto miss3 = FindMissingGlyphs(m, f, text);
            if (miss3.empty()) {
                r.substituted = true;
                r.chosen = f;
                r.method = 2;
                r.reason = "fixFontName 仍缺字，改用兜底字体 " + Utf8(opt.fallbackFace);
                return r;
            }
        }

        // 都不行：明确说清楚，不假装换好了
        r.reason = "试过 " + Utf8(opt.fixFontName) + " 与 " + Utf8(opt.fallbackFace) +
                   " 后仍有缺字（需要内嵌 CJK 字体子集来兜）";
        return r;
    }

    /** 宽串 → UTF-8（日志/JSON 用；本文件的 reason 里要拼中文） */
    static std::string Utf8(const std::wstring& w) {
        if (w.empty()) return "";
        const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                                          nullptr, 0, "?", nullptr);
        std::string s(static_cast<size_t>(n), '\0');
        WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), s.data(), n, "?",
                            nullptr);
        return s;
    }
};

/**
 * 字体覆盖状态：记录"原始字体"，支持设置覆盖与一键还原。
 *
 * ★ 为什么把"原始"和"覆盖"分开存，而不是"改了就改回不来"：
 *   验收第 4 条明确要求"全部还原"。分开存的实现里，
 *   还原 = 把覆盖清掉，**不需要记住改过什么**，所以不可能还原不干净。
 */
class FontOverrideState {
public:
    /** 用原始字体初始化（重复调用不覆盖已记录的原始值） */
    void Apply(const FontSpec& original) {
        if (!hasOriginal_) {
            original_ = original;
            hasOriginal_ = true;
        }
        override_ = original;
        active_ = false;
    }

    /** 设置生效中的覆盖字体 */
    void SetOverride(const FontSpec& f) {
        override_ = f;
        active_ = true;
    }

    /** 一键还原：丢掉覆盖，回到原始字体 */
    void Restore() {
        override_ = original_;
        active_ = false;
    }

    /** 当前实际该用的字体 */
    FontSpec Current() const { return active_ ? override_ : original_; }
    const FontSpec& Override() const { return override_; }
    const FontSpec& Original() const { return original_; }
    bool IsOverridden() const { return active_; }
    bool HasOriginal() const { return hasOriginal_; }

    /** 供日志/自述文件：一行说清当前状态 */
    std::string Describe() const {
        return std::string("原始=") + FontResolver::Utf8(original_.face) + "(" +
               std::to_string(-original_.height) + "px)  当前=" +
               FontResolver::Utf8(Current().face) + "(" + std::to_string(-Current().height) +
               "px)  " + (active_ ? "**已覆盖**" : "未覆盖");
    }

private:
    FontSpec original_;
    FontSpec override_;
    bool hasOriginal_ = false;
    bool active_ = false;
};

} // namespace bb
