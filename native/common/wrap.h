// ============================================================================
// 自动折行 + 字号自适应（N2.2 + N2.3）
// ============================================================================
//
// 为什么需要（问题背景）：
//   日文换成中文后，**字符宽度、行高、折行位置全变了**。
//   直接把字符串换掉会导致文字溢出对话框、错位、被裁掉。
//   所以"内容"和"版面"必须同时处理。
//
// ── 这一层做的事 ──
//   ① 折行：给定区域宽度，按**中文排版规则**重新断行
//   ② 字号自适应：放不下就逐级降字号重排，直到放得下
//
// ── 明确不做的事 ──
//   本项目**禁止**"整体缩小 UI 缩放比例"这种偷懒方案（会毁掉游戏画面）。
//   我们只动**文本自己的字号与断行**，绝不碰任何全局缩放。
//
// ── 中文断行为什么不能简单地"每行塞满 N 个字" ──
//   中文排版有**禁则处理**（避头点/避尾点）：
//     · 行首禁则：`，。、；：？！）】》」』…—` 等**不能出现在一行开头**
//       —— 否则读者会看到一个标点孤零零挂在行首，非常难看且影响理解
//     · 行尾禁则：`（【《「『` 等**不能出现在一行结尾**
//       —— 开引号被留在行尾、内容跑到下一行，视觉上是断开的
//   这两条是中文排版的基本要求，不做的话即使"没溢出"也算不上可用。
#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

#include "measure.h"

namespace bb {

// ── 中文标点禁则表 ──────────────────────────────────────────────────────────

/**
 * 行首禁则：这些字符**不允许**成为一行的第一个字符。
 *
 * 分类：收尾类标点（句号/逗号/顿号/分号/冒号/问号/叹号）、
 *       右半边括号引号、省略号、破折号、以及日文的对应符号。
 */
inline bool IsLineStartForbidden(wchar_t c) {
    switch (c) {
        // 中文标点
        case L'，': case L'。': case L'、': case L'；': case L'：':
        case L'？': case L'！': case L'）': case L'】': case L'》':
        case L'」': case L'』': case L'〕': case L'〉': case L'｝':
        case L'…': case L'—': case L'～':
        case L'”': case L'’': case L'％': case L'℃':
        // 日文标点（同一套排版规则，只是码位不同）
        case L'｡': case L'､': case L'･': case L'｣':
        case L'ー':   // 长音符放在行首观感很差
            return true;
        default:
            return false;
    }
}

/**
 * 行尾禁则：这些字符**不允许**成为一行的最后一个字符。
 *
 * 主要是"开"类：左括号、左引号 —— 它们必须和后面的内容在一起。
 */
inline bool IsLineEndForbidden(wchar_t c) {
    switch (c) {
        case L'（': case L'【': case L'《': case L'「': case L'『':
        case L'〔': case L'〈': case L'｛':
        case L'“': case L'‘':
        case L'＄': case L'￥': case L'＃':
            return true;
        default:
            return false;
    }
}

/** 是不是"西文词字符"（英文/数字/下划线）—— 这类要整词处理，不能从中间拆 */
inline bool IsWordChar(wchar_t c) {
    return (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') ||
           c == L'_' || c == L'\'' || c == L'-';
}

/** 是不是空白（空白处理成"词之间的分隔"，不作为可见字符参与折行） */
inline bool IsSpace(wchar_t c) { return c == L' ' || c == L'\t'; }

// ── 折行 ────────────────────────────────────────────────────────────────────

struct WrapOptions {
    /**
     * 每行最大字数上限（0 = 不限）。
     *
     * 为什么要有这个"兜底"：有些引擎的文本框根本不是按像素排版的
     * （比如按"每行几个字"来切），或者字体度量不可信。
     * 给引擎侧留一个硬上限，宽度约束失灵时至少不会排成一柱天梯。
     */
    int maxCharsPerLine = 0;

    /**
     * 允许标点悬挂（行尾多出一个标点、略微超出区域宽）。
     *
     * 中文排版的标准做法是"标点悬挂"：当断点正好落在标点前时，
     * 允许把这个标点**挤在行尾**（超出宽度一点点），而不是把它推到下一行的行首。
     * 我们默认**关闭**，改用"把上一个字一起挪到下一行"的保守做法 ——
     * 因为验收标准是"绝不溢出"，悬挂会打破这条。需要时可由调用方打开。
     */
    bool allowHangingPunctuation = false;
};

struct WrappedText {
    std::vector<std::wstring> lines;

    /** 行数 */
    size_t Count() const { return lines.size(); }
    /** 拼回一整段（用于"不丢字"校验） */
    std::wstring Joined() const {
        std::wstring s;
        for (const auto& l : lines) s += l;
        return s;
    }
};

namespace detail {

/** 折行单段落（不含换行符）。返回逐行结果（已经把首尾空白去掉）。 */
inline std::vector<std::wstring> WrapParagraph(TextMeasure& m, const FontSpec& font,
                                               const std::wstring& para, int boxWidth,
                                               const WrapOptions& opt) {
    std::vector<std::wstring> lines;
    const size_t n = para.size();
    if (n == 0) return lines;

    // 预取每个字的宽度（GDI 调用有开销，循环里反复问会慢）
    std::vector<int> cw(n);
    for (size_t i = 0; i < n; ++i) cw[i] = m.CharWidth(font, para[i]);

    size_t start = 0;
    while (start < n) {
        // ── 贪心：在宽度与字数上限内尽量多塞 ──
        int w = 0;
        size_t end = start;
        while (end < n) {
            const int c = cw[end];
            if (w + c > boxWidth) break;
            if (opt.maxCharsPerLine > 0 &&
                static_cast<int>(end - start + 1) > opt.maxCharsPerLine) {
                break;
            }
            w += c;
            ++end;
        }

        // 一个字都放不下（单个字比区域还宽）→ 至少放一个，避免死循环
        bool hardOverflow = false;
        if (end == start) {
            end = start + 1;
            hardOverflow = true;
        }

        // 行尾不能再是空白（否则行长看着对、实际右边悬空）
        while (end > start + 1 && end <= n && IsSpace(para[end - 1])) --end;

        if (!hardOverflow && end < n) {
            // ── ① 行首禁则：断点后第一个字是收尾类标点 → 把它留给上一行 ──
            //    做法是"往前收一格"，于是标点跟着上一行末尾走，不落到行首。
            while (end > start + 1 && end < n && IsLineStartForbidden(para[end])) {
                --end;
            }

            // ── ② 行尾禁则：行尾是开括号类 → 把它推到下一行 ──
            while (end > start + 1 && IsLineEndForbidden(para[end - 1])) {
                --end;
            }

            // ── ③ 西文整词：断点落在单词中间 → 退到单词开头 ──
            //    只有"整行只放得下这半个词"时才允许硬切（否则会死循环）。
            if (IsWordChar(para[end]) && IsWordChar(para[end - 1])) {
                size_t wordStart = end;
                while (wordStart > start && IsWordChar(para[wordStart - 1])) --wordStart;
                if (wordStart > start) {
                    end = wordStart;   // 整个词推给下一行
                }
                // wordStart == start 说明这个词从行首就开始了、且放不下 →
                // 保持 end 不动（硬切），否则这个超长单词永远排不进去
            }

            // 上面的调整可能又把行尾搞成空白或禁则，再收一次
            while (end > start + 1 && (IsSpace(para[end - 1]) || IsLineEndForbidden(para[end - 1]))) {
                --end;
            }
        }

        if (end <= start) end = start + 1;   // 最终兜底，保证有推进

        std::wstring line = para.substr(start, end - start);
        // 去掉行首空白（行首禁则里空白不算可见字符，但读起来会错位）
        size_t b = 0;
        while (b < line.size() && IsSpace(line[b])) ++b;
        if (b > 0) line.erase(0, b);
        if (!line.empty()) lines.push_back(line);

        start = end;
        // 跳过紧接着的空白（不让它们在下一行变成行首空白）
        while (start < n && IsSpace(para[start])) ++start;
    }
    return lines;
}

} // namespace detail

/**
 * 把文本按区域宽度折行。
 *
 * 会先按 `\n` 切成段落（硬换行必须尊重），每段再各自贪心折行。
 */
inline WrappedText WrapText(TextMeasure& m, const FontSpec& font, const std::wstring& text,
                            int boxWidth, const WrapOptions& opt = WrapOptions{}) {
    WrappedText out;
    if (boxWidth <= 0) boxWidth = 1;   // 防御：非正宽度会让贪心一步都走不动

    std::wstring para;
    auto flush = [&]() {
        auto ls = detail::WrapParagraph(m, font, para, boxWidth, opt);
        for (auto& l : ls) out.lines.push_back(std::move(l));
        para.clear();
    };
    for (size_t i = 0; i < text.size(); ++i) {
        const wchar_t c = text[i];
        if (c == L'\r') continue;
        if (c == L'\n') {
            flush();
            continue;
        }
        para.push_back(c);
    }
    if (!para.empty()) flush();
    return out;
}

// ── 字号档位（既定档位表原样落地）────────────────────────────

/**
 * 各引擎的字号相对偏移。
 *
 * 这是一组**相对偏移**（典型值 -3）：引擎有自己的默认字号，
 * 我们不改它的代码，只在"计算回填用字号"时叠加这个偏移。
 * 值为负数表示"比默认小几级"，因为中文通常比日文同字号更"占地方"。
 *
 * ★ 之所以按引擎分开配，是因为不同引擎的字号单位不一样
 *   （有的是像素、有的是 pt、有的是自身的档位索引），
 *   同一个偏移在它们身上效果不同，必须各调各的。
 */
struct FontSizeLadder {
    /**
     * 按引擎 id 取默认的相对偏移。
     *
     * id 用固定配置项名（去掉 `fontSize` 前缀、首字母小写），
     * 例如 `Vx` / `KRKR2` / `mv` / `renpy`。认不出来就给 0（不动），
     * **不猜**——猜错会让所有文本都变小或变大，是很难查的排版问题。
     */
    static int DefaultOffset(const std::string& engineId) {
        struct Entry { const char* id; int offset; };
        // 数值沿用既定档位表
        static const Entry kTable[] = {
            {"Vx", -3},
            {"KRKR2", -3},
            {"Wolf", 0},
            {"SRPG", -3},
            {"GI", -3},
            {"AGTK", -3},
            {"tyrano", -3},
            {"VNMakero", -3},
            {"bakin", -3},
            {"kmy", -3},
            {"mv", -3},
            {"renpy", -3},
        };
        for (const auto& e : kTable) {
            if (engineId == e.id) return e.offset;
        }
        return 0;
    }

    /** 偏移表里有没有这个引擎（用于"配置里写了但引擎未知"时告警，而不是静默给 0） */
    static bool Known(const std::string& engineId) {
        static const char* kIds[] = {"Vx",  "KRKR2", "Wolf",   "SRPG", "GI",    "AGTK",
                                     "tyrano", "VNMakero", "bakin", "kmy", "mv", "renpy"};
        for (const char* id : kIds) {
            if (engineId == id) return true;
        }
        return false;
    }
};

// ── 字号自适应 ──────────────────────────────────────────────────────────────

struct AutoFitOptions {
    /** 字号下限（GDI 负值约定，如 -8 表示不小于 8px）。到底了还放不下就放弃 */
    int minHeight = -8;
    /** 最多降几级（防止病态输入下反复缩小到看不清） */
    int maxShrinkSteps = 24;
    /** 透传给折行的"每行最大字数"兜底 */
    int maxCharsPerLine = 0;
    /** 行距（额外像素，加在行高之上） */
    int lineGap = 0;
    /** 是否允许继续降字号；false = 只折行不降字号（用于"只验证折行"的用例） */
    bool allowShrink = true;
};

struct AutoFitResult {
    bool ok = false;             // 宽和高都放得下
    bool widthFits = false;
    bool heightFits = false;
    int shrinkSteps = 0;         // 实际降了几级
    FontSpec font;               // 最终采用的字体（含最终字号）
    WrappedText wrapped;         // 最终折行结果
    int usedHeight = 0;          // 最终占用的总高度（像素）

    /**
     * 回写配置用的**最终字号偏移**。
     *
     * 语义：`初始偏移 - 降级级数`。例如引擎档位默认 -3、又降了 2 级 → -5。
     * 负得越多字号越小，与配置项语义一致。
     */
    int finalOffset = 0;

    /** 一行放不下的诊断：最宽那行有多宽（放不下时便于定位） */
    int widestLine = 0;
};

/**
 * 字号自适应：在给定区域里，找一个"能完整放下这段文本"的字号。
 *
 * 流程：用基准字号试排 → 量总高 → 放不下就把字号**降 1 级**重排 → 直到放下或到下限。
 *
 * ★ 为什么是"逐级 ±1"而不是"一次性算出合适字号"：
 *   文字高度是离散的（整数像素），字号与行数**不是连续函数** ——
 *   字号小一点点可能刚好让某行少一个字、从而少一行，高度骤降。
 *   一次算出来的"理论值"往往就差一像素放不下。逐级试是可控且必然收敛的。
 */
inline AutoFitResult AutoFitFontSize(TextMeasure& m, const FontSpec& baseFont,
                                     const std::wstring& text, int boxWidth, int boxHeight,
                                     const AutoFitOptions& opt = AutoFitOptions{},
                                     int initialOffset = 0) {
    AutoFitResult out;
    out.font = baseFont;
    out.finalOffset = initialOffset;

    const int baseHeight = baseFont.height;
    const int limit = opt.allowShrink ? opt.maxShrinkSteps : 0;

    for (int step = 0; step <= limit; ++step) {
        // 字号用"负值 = 字符高度"，降级就是让绝对值变小（更接近 0）
        FontSpec f = baseFont;
        const int h = baseHeight + step;      // 例如 -24 → -23 → …
        if (h > -1) break;                     // 防御：别走到 0 或正数
        f.height = h;
        if (opt.allowShrink && h > opt.minHeight && step > 0) {
            // 超过下限了，别继续缩
            break;
        }

        WrapOptions wo;
        wo.maxCharsPerLine = opt.maxCharsPerLine;
        WrappedText w = WrapText(m, f, text, boxWidth, wo);

        // 行高取"这套字体自己的高度"，比用 |height| 更贴近真实渲染
        int lineH = m.Extent(f, L"字").height;
        if (lineH <= 0) lineH = -h;
        lineH += opt.lineGap;

        int widest = 0;
        for (const auto& line : w.lines) {
            const int lw = m.Extent(f, line.c_str()).width;
            if (lw > widest) widest = lw;
        }
        const int total = static_cast<int>(w.lines.size()) * lineH;

        out.font = f;
        out.wrapped = w;
        out.usedHeight = total;
        out.widestLine = widest;
        out.shrinkSteps = step;
        out.finalOffset = initialOffset - step;
        out.widthFits = (widest <= boxWidth);
        out.heightFits = (total <= boxHeight);
        out.ok = out.widthFits && out.heightFits;

        if (out.ok) return out;
        if (!opt.allowShrink) return out;   // 明确不要缩，就把这一轮结果交出去
    }
    return out;   // 到下限仍放不下：ok=false，但 font/wrapped 是最小字号的结果
}

} // namespace bb
