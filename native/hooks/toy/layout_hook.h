// ============================================================================
// 绘制时的排版 hook（N2.2 + N2.3 + N2.4）
// ============================================================================
//
// 干什么：在目标进程**绘制文本的那一刻**把文本重排。
//
// ── 为什么必须挂在"绘制"这一步，而不是更早 ──
//   译文换进去之后，问题不在"文字对不对"，而在"版面放不放得下"。
//   而"放不放得下"只有**拿到真实 HDC + 真实字体**才能算得准。
//   所以拦截点选在 `TextOutW`：此时调用方已经把字体选进 DC 了，
//   我们直接问 DC 要字体信息即可，不用猜。
//
// ── 这一层做的三件事（正好对应 N2 的三条要求）──
//   ① 折行：按对话框宽度重排（中文禁则规则在 common/wrap.h）
//   ② 字号自适应：折完还是放不下就降字号重排（common/wrap.h 的 AutoFitFontSize）
//   ③ 缺字兜底：原字体画不出的字，换一套覆盖它的字体（common/fontmap.h）
//
// ── 两个容易踩的坑，都写在这里 ──
//
//   坑 1：**不能在 detour 里再调被 hook 的 API**。
//         我们要画多行就得多次 TextOutW，如果调的是被 hook 的 `TextOutW`，
//         就会递归进自己的 detour —— 每次都重新折行、重新降字号，
//         直到栈溢出或死循环。所以 detour 里必须调**原始函数指针**
//        （`RealTextOutW`），这一点由调用方保证：本文件只接收一个
//        "画一行"的回调，绝不去碰 TextOutW。
//
//   坑 2：**只处理"需要重排"的文本**。
//         如果把界面上所有文字都拿来重排（连一行标题、按钮文字都不放过），
//         既浪费又没有意义，还会把本来正常的小文本搞乱。
//         判据用"这段文本在当前字体下是否放得下"——
//         放得下就原样交给原始函数，一个字节都不动。
#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

// ⚠️ 用相对路径 `../../common/...`：`#include "x.h"` 是相对**当前文件**所在目录
//    解析的（本文件在 hooks/toy/，而 common/ 在 native/common/）。
//    写成 "fontmap.h" 会找不到 —— 本项目在 N0 阶段踩过同一个坑。
#include "../../common/fontmap.h"
#include "../../common/layout_config.h"
#include "../../common/log.h"
#include "../../common/measure.h"
#include "../../common/wrap.h"

namespace bb {

/** 一次排版的结果（既用于绘制，也用于日志/自述，便于外部断言） */
struct LayoutOutcome {
    bool handled = false;          // 是否被我们接管重排
    bool ok = false;               // 重排后是否完整放得下
    int lines = 0;
    int widestLine = 0;            // 最宽那行的像素宽
    int boxWidth = 0;              // 区域宽（用于断言"不溢出"）
    int usedHeight = 0;            // 占用总高
    int boxHeight = 0;
    int finalFontHeight = 0;       // 最终字号（GDI 负值取绝对值前的原值）
    int shrinkSteps = 0;           // 降了几级字号
    bool fontSubstituted = false;  // 是否换了字体
    std::string fontFace;          // 最终用的字体族名（UTF-8）
    std::string reason;            // 人话说明
    std::vector<std::wstring> wrappedLines;
};

/**
 * 排版 hook 的核心逻辑（不含任何 hook API，纯逻辑，可自检）。
 *
 * 调用方负责：给 HDC、给"画一行"的回调、给要画的文本。
 */
class LayoutHook {
public:
    struct Options {
        std::wstring fixFontName = L"黑体";   // 配置项 fixFontName 的默认值
        std::wstring fallbackFace = L"宋体";  // 缺字兜底字体
        int maxCharsPerLine = 0;              // 引擎侧"每行最大字数"兜底（0=不限）
        int minFontHeight = -9;               // 字号下限
        int maxShrinkSteps = 20;
        bool enabled = true;                  // 总开关（还原时关掉）
    };

    const Options& GetOptions() const { return opt_; }
    void SetOptions(const Options& o) { opt_ = o; }

    /** 一键还原：关掉重排、清掉字体覆盖统计 */
    /**
     * 清掉统计与节流状态（供"全部还原"调用）。
     *
     * ★ 这里**绝不碰** `opt_.enabled`。
     *   第一版我在这里写了 `opt_.enabled = true`（本意是"回到默认配置"），
     *   结果把调用方刚设好的"关掉排版"又给打开了 ——
     *   表现是"全部还原"执行成功、日志也写了，但排版照样在接管，
     *   字体和字号**根本没有还原**（验收第 4 条直接不过）。
     *   开关该由调用方决定：本函数只负责"把记忆清干净"。
     */
    void Restore() {
        substituted_ = false;
        handledCount_ = 0;
        // 节流表也要清：还原后重新开启排版时，结果可能需要重新记一遍
        lastSigByText_.clear();
        BB_LOG(L"[排版] 已还原：字体覆盖与字号自适应统计清零");
    }

    const char* LastFaceUtf8() const { return lastFace_.c_str(); }
    bool EverSubstituted() const { return substituted_; }
    int HandledCount() const { return handledCount_; }

    /**
     * 尝试重排并绘制。
     *
     * @param hdc        目标 DC（字体已经由调用方 SelectObject 好了）
     * @param x,y        绘制起点
     * @param text       文本
     * @param len        长度（-1 表示 NUL 结尾）
     * @param drawLine   回调：画一行。**必须调用原始 TextOutW**（见文件头坑 1）
     * @return true = 已接管并完成绘制（调用方不要再调原始函数）
     *         false = 不需要重排，调用方照常调原始函数
     */
    template <typename DrawLineFn>
    bool TryLayoutAndDraw(HDC hdc, int x, int y, const wchar_t* text, int len, DrawLineFn drawLine,
                          LayoutOutcome* outc = nullptr) {
        LayoutOutcome out;
        out.boxWidth = toylayout::InnerWidth();
        out.boxHeight = toylayout::InnerHeight();

        if (!opt_.enabled || !text) {
            // ★ 如果**上一刻还在接管、现在不接管了**，说明有人调了"全部还原"
            //   （或关掉了排版）。这个状态变化必须留一条日志 ——
            //   否则验收脚本没法从日志判断"还原到底生效没有"：
            //   之后再也不会有 LAYOUT 行了，你会分不清
            //   "还原成功" 和 "目标根本没在重绘"。
            if (wasHandling_) {
                wasHandling_ = false;
                BB_LOG(L"LAYOUT handled=0 reason=layout-disabled（已还原：文本按原始字体与字号绘制）");
            }
            if (outc) *outc = out;
            return false;
        }

        const int n = (len < 0) ? static_cast<int>(wcslen(text)) : len;
        if (n <= 0) {
            if (outc) *outc = out;
            return false;
        }
        const std::wstring s(text, static_cast<size_t>(n));

        // ── 从 DC 问出当前字体（不猜、不缓存，就是调用方真正选的那个）──
        FontSpec font;
        if (!ReadFontFromDc(hdc, &font)) {
            if (outc) *outc = out;
            return false;   // 读不到字体就别乱动，交给原始函数
        }

        TextMeasure& m = Measure();

        // ── 先判断"原样放得下吗"。放得下就完全不管 ──
        //    （见文件头坑 2：不处理正常的小文本）
        const TextExtent plain = m.Extent(font, s.c_str());
        if (plain.ok && plain.width <= out.boxWidth && n <= 40) {
            if (outc) *outc = out;
            return false;
        }

        out.handled = true;
        handledCount_++;

        // ── ③ 缺字兜底：先确定用哪套字体 ──
        FontResolver resolver;
        FontResolveOptions ro;
        ro.fixFontName = opt_.fixFontName;
        ro.fallbackFace = opt_.fallbackFace;
        const FontSubstitution sub = resolver.Resolve(m, font, s, ro);
        FontSpec useFont = sub.chosen;
        out.fontSubstituted = sub.substituted;
        out.fontFace = WideToUtf8(useFont.face);
        out.reason = sub.reason;
        if (sub.substituted) {
            substituted_ = true;
            lastFace_ = out.fontFace;
            BB_LOG(L"[排版] 字体替换：%s → %s（%s）", font.face.c_str(), useFont.face.c_str(),
                   Utf8ToWideSimple(sub.reason).c_str());
        }

        // ── ①② 折行 + 字号自适应 ──
        AutoFitOptions ao;
        ao.minHeight = opt_.minFontHeight;
        ao.maxShrinkSteps = opt_.maxShrinkSteps;
        ao.maxCharsPerLine = opt_.maxCharsPerLine;

        const AutoFitResult r =
            AutoFitFontSize(m, useFont, s, out.boxWidth, out.boxHeight, ao);

        out.ok = r.ok;
        out.lines = static_cast<int>(r.wrapped.lines.size());
        out.widestLine = r.widestLine;
        out.usedHeight = r.usedHeight;
        out.finalFontHeight = r.font.height;
        out.shrinkSteps = r.shrinkSteps;
        out.wrappedLines = r.wrapped.lines;
        if (r.ok) {
            out.reason += "；折行 " + std::to_string(out.lines) + " 行，最宽 " +
                          std::to_string(out.widestLine) + "px ≤ " +
                          std::to_string(out.boxWidth) + "px，字号 " +
                          std::to_string(-useFont.height) + "→" + std::to_string(-r.font.height) +
                          "px";
        } else {
            out.reason += "；**仍放不下**（最宽 " + std::to_string(out.widestLine) + "px > " +
                          std::to_string(out.boxWidth) + "px 或高 " +
                          std::to_string(out.usedHeight) + "px > " +
                          std::to_string(out.boxHeight) + "px）";
        }

        // ── 用最终字体建一个 HFONT，逐行画 ──
        HFONT hFont = CreateFontW(r.font.height, 0, 0, 0, r.font.weight, r.font.italic ? TRUE : FALSE,
                                  FALSE, FALSE, r.font.charset, OUT_TT_PRECIS,
                                  CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                  DEFAULT_PITCH | FF_DONTCARE, r.font.face.c_str());
        HGDIOBJ oldFont = hFont ? SelectObject(hdc, hFont) : nullptr;

        // 行高：用真实字体的字符高度（比 |lfHeight| 更贴近渲染）
        int lineH = m.Extent(r.font, L"字").height;
        if (lineH <= 0) lineH = -r.font.height;

        int dy = y;
        for (const auto& line : r.wrapped.lines) {
            drawLine(hdc, x, dy, line.c_str(), static_cast<int>(line.size()));
            dy += lineH;
        }

        if (oldFont) SelectObject(hdc, oldFont);
        if (hFont) DeleteObject(hFont);

        // ★ 日志节流：只在**这段文本的排版结果发生变化**时才打 KEY=value 那一行。
        //   为什么必须做：游戏是每帧重绘的，这段代码每帧都会被调用。
        //   不节流的话日志会被同一条记录刷爆（实测 200ms 一次的定时器
        //   几秒钟就写了几十行完全相同的记录），既掩盖真正有用的信息，
        //   也让验收脚本难以判断"到底稳定在什么结果上"。
        //
        //   ⚠️ 节流的键必须是**每段文本各自**的，不能是一个全局变量。
        //      界面上一帧要画好几个文本（长对白 + 一行提示 + …），
        //      全局键会随着"A、B、A、B"交替而每次都判成"变了"，
        //      节流完全失效 —— 实测就是这个现象：2.5 秒写了 44 行。
        const std::string sig = std::to_string(out.ok ? 1 : 0) + "/" + std::to_string(out.lines) +
                                "/" + std::to_string(out.widestLine) + "/" +
                                std::to_string(out.usedHeight) + "/" +
                                std::to_string(out.finalFontHeight) + "/" +
                                std::to_string(out.shrinkSteps) + "/" +
                                std::to_string(out.fontSubstituted ? 1 : 0) + "/" + out.fontFace;
        const uint32_t key = Fnv1a32(s);
        auto it = lastSigByText_.find(key);
        if (it == lastSigByText_.end() || it->second != sig) {
            lastSigByText_[key] = sig;
            BB_LOG(L"[排版] 接管文本 %d 字 → %d 行（最宽 %d/%dpx，高 %d/%dpx，字号 %dpx，降 %d 级，"
                   L"字体 %s%s）",
                   n, out.lines, out.widestLine, out.boxWidth, out.usedHeight, out.boxHeight,
                   -r.font.height, out.shrinkSteps, r.font.face.c_str(),
                   out.fontSubstituted ? L"（已替换）" : L"");
            LogOutcomeAsKeyValues(out);
        }
        wasHandling_ = true;

        if (outc) *outc = out;
        return true;
    }

    /** 从 DC 读回当前选中的 LOGFONT（拿不到就返回 false） */
    static bool ReadFontFromDc(HDC hdc, FontSpec* out) {
        if (!hdc || !out) return false;
        // GetCurrentObject + GetObjectW 是标准做法，且**不会**创建字体（无副作用）
        HGDIOBJ obj = GetCurrentObject(hdc, OBJ_FONT);
        if (!obj) return false;
        LOGFONTW lf{};
        if (GetObjectW(obj, sizeof(lf), &lf) == 0) return false;
        out->face = lf.lfFaceName;
        out->height = lf.lfHeight;
        out->weight = lf.lfWeight;
        out->italic = lf.lfItalic != 0;
        out->underline = lf.lfUnderline != 0;
        out->charset = lf.lfCharSet;
        return true;
    }

    /**
     * 把最近一次排版结果写成一行**脚本可断言**的键值对（写进日志）。
     *
     * 为什么要专门做这个：验收要断言"不溢出"，而"不溢出"是发生在
     * 目标进程内部的事 —— 外部脚本既看不到 HDC 也看不到文本框。
     * 所以让被注入的一侧自己把事实报出来，日志就是证据。
     */
    static void LogOutcomeAsKeyValues(const LayoutOutcome& o) {
        BB_LOG(L"LAYOUT handled=%d ok=%d lines=%d widest=%d boxw=%d usedh=%d boxh=%d "
               L"fonth=%d shrink=%d substituted=%d face=%s",
               o.handled ? 1 : 0, o.ok ? 1 : 0, o.lines, o.widestLine, o.boxWidth, o.usedHeight,
               o.boxHeight, o.finalFontHeight, o.shrinkSteps, o.fontSubstituted ? 1 : 0,
               Utf8ToWideSimple(o.fontFace).c_str());
    }

private:
    static std::wstring Utf8ToWideSimple(const std::string& s) {
        if (s.empty()) return L"";
        const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                                          nullptr, 0);
        if (n <= 0) return L"";
        std::wstring w(static_cast<size_t>(n), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &w[0], n);
        return w;
    }
    static std::string WideToUtf8(const std::wstring& w) {
        if (w.empty()) return "";
        const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                                          nullptr, 0, "?", nullptr);
        std::string s(static_cast<size_t>(n), '\0');
        WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &s[0], n, "?",
                            nullptr);
        return s;
    }

    Options opt_;
    bool substituted_ = false;
    int handledCount_ = 0;
    std::string lastFace_;
    /** 每段文本 → 上次已写日志的结果签名（键 = 文本内容的 FNV-1a 哈希） */
    std::unordered_map<uint32_t, std::string> lastSigByText_;
    /** 上一刻是否处于"接管中"状态 —— 用于把"已还原"这个转变记一次日志 */
    bool wasHandling_ = false;

    /** 文本内容哈希（只用于日志节流的键，不需要抗碰撞） */
    static uint32_t Fnv1a32(const std::wstring& s) {
        uint32_t h = 2166136261u;
        for (wchar_t c : s) {
            h = (h ^ static_cast<uint32_t>(c & 0xFF)) * 16777619u;
            h = (h ^ static_cast<uint32_t>((c >> 8) & 0xFF)) * 16777619u;
        }
        return h;
    }
};

} // namespace bb
