// ============================================================================
// 玩具目标的「对话框」几何约定（N2）
// ============================================================================
//
// 为什么单独一个头、且**玩具与被注入的 hook 都要包含它**：
//
//   N2 要验的是"固定宽度的对话框里塞 3 倍长度中文，必须自动折行且不溢出"。
//   折行必须发生在**绘制那一刻**（hook 在 TextOutW 里把文本重排），
//   而"对话框有多宽"这个信息只有玩具自己知道 —— hook 靠的是**双方约定**。
//
//   真实工具里这个宽度来自引擎配置（或者 hook 去查引擎的控件尺寸）；
//   玩具场景下用一个共享常量最简单、也最不容易出错：
//   两边包含同一个头，就不会出现"玩具画 380 宽、hook 按 300 折行"这种
//   看着像 bug 其实是配置不一致的问题。
#pragma once

namespace bb {
namespace toylayout {

// 对话框在客户区里的位置与**固定宽度**（这是本组验收的核心约束）
constexpr int kDialogX = 30;
constexpr int kDialogY = 170;
constexpr int kDialogW = 380;   // ← 固定宽度：文本必须折进这个宽度
constexpr int kDialogH = 150;   // 固定高度：折出的行数太多会被裁掉

// 内边距
constexpr int kPadX = 8;
constexpr int kPadY = 6;

/** 文本可用的实际宽度/高度 */
constexpr int InnerWidth() { return kDialogW - kPadX * 2; }
constexpr int InnerHeight() { return kDialogH - kPadY * 2; }

/**
 * 玩具用来演示排版的原始字号（基准字号）。
 *
 * 故意选得偏大：基准字号下这段文本**放不下**，
 * 于是必须靠"字号自适应"降级才能完整显示 —— 这正是验收第 2 条要看的。
 */
constexpr int kBaseFontHeight = -22;   // GDI 约定：负值 = 字符高度

/**
 * 玩具用来演示"缺字兜底"的字体。
 *
 * 用 **MS Gothic（日文字体）**：它不含「龘」这类生僻汉字。
 * 于是中文文本里的「龘」在原始字体下必然是豆腐块，
 * 必须靠字体替换（或 fallback）才能画出来 —— 这正是验收第 3 条要看的。
 */
#define BB_TOY_ORIGINAL_FACE L"MS Gothic"

} // namespace toylayout
} // namespace bb
