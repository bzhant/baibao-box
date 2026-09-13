// ============================================================================
// 文本度量代理（N2.1）
// ============================================================================
//
// 职责：给"一段文本 + 一套字体信息"，返回它的**像素宽高**，以及判断
//       "某个字在这套字体里到底有没有字形"（缺字检测）。
//
// 为什么必须有这一层：日文换成中文后**字符宽度变了** —— 同一个对话框，
// 原来一行放得下的日文，换成中文就溢出/错位/被裁掉。
// 想"自动折行"和"自动降字号"，前提都是**能算出一个字有多宽**。
// 没有度量能力，后面的排版全部无从谈起。
//
// ── 两条路径，各管一段 ──
//
//   ① 主路径：**GDI**（`GetTextExtentPoint32W` / `GetGlyphOutlineW`）
//      · 这是最终**真正会被画出来**的那个字体，量出来的就是渲染结果，最准
//      · Windows 上永远可用，所以是主路径
//
//   ② 降级路径：**内嵌的最小 TrueType/OpenType 解析器**
//      · 只读 `head`/`hhea`/`hmtx`/`maxp`/`loca`/`glyf`/`cmap` 这几张表，
//        够算 advance width 和"有没有字形"
//      · 为什么需要它，而不是全靠 GDI：
//        a. GDI 要"创建字体"这个有副作用的动作；在某些进程/时机里
//           建字体可能失败（会话 0、字体未加载、权限受限）
//        b. **缺字检测**用 GDI 只能靠 `GetGlyphOutlineW` 返回 `GDI_ERROR`，
//           而有些字体（尤其带 fallback 的）会**替你换一个字体**去画，
//           于是"GDI 说能画、实际画出来是别的样子" —— 直接查字体文件的
//           cmap 才能得到"这套字体**自己**到底覆盖了哪些码位"这个事实
//        c. 不引入 stb_truetype 这种大块第三方（本仓库的取向是
//           common/ 里零第三方依赖），只读几张表，代码量可控
//
// ── 一个容易忽略的坑：Windows 的中文字体很多是 **TTC**（字体集合）──
//   `msgothic.ttc` / `msmincho.ttc` / `simsun.ttc` 都是。
//   TTC 文件头是 `ttcf`，真正的表在 `offsets[]` 指向的子字体里。
//   不处理 TTC，就会对着文件开头那 12 个字节解析失败，
//   然后误判成"这个字体什么字都没有" → 满屏豆腐块。
#pragma once

#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace bb {

// ── 字体描述 ────────────────────────────────────────────────────────────────

/**
 * 描述"用哪套字体量"。
 *
 * `height` 用 GDI 的约定：**负值 = 字符高度**（不含内部行距），
 * 正值 = 单元格高度（含行距）。我们一律用负值，因为排版关心的是"字多大"。
 */
struct FontSpec {
    std::wstring face = L"黑体";
    int height = -16;              // 负值 = 字符高度
    int weight = FW_NORMAL;
    bool italic = false;
    bool underline = false;
    BYTE charset = DEFAULT_CHARSET;

    /** 拼成 GDI 的 LOGFONTW（内部用；也便于日志里打印关键字段） */
    LOGFONTW ToLogFont() const {
        LOGFONTW lf{};
        lf.lfHeight = height;
        lf.lfWeight = weight;
        lf.lfItalic = italic ? 1 : 0;
        lf.lfUnderline = underline ? 1 : 0;
        lf.lfCharSet = charset;
        lf.lfOutPrecision = OUT_TT_PRECIS;      // 优先 TrueType（点阵字体没有字形轮廓）
        lf.lfQuality = ANTIALIASED_QUALITY;
        lf.lfPitchAndFamily = DEFAULT_PITCH | FF_DONTCARE;
        const size_t n = face.size() < 31 ? face.size() : 31;
        memcpy(lf.lfFaceName, face.c_str(), n * sizeof(wchar_t));
        lf.lfFaceName[n] = L'\0';
        return lf;
    }

    /** 参与缓存键：只有这些字段会影响度量结果 */
    std::wstring Key() const {
        return face + L"|" + std::to_wstring(height) + L"|" + std::to_wstring(weight) +
               (italic ? L"|i" : L"") + (underline ? L"|u" : L"") + L"|" +
               std::to_wstring(static_cast<int>(charset));
    }
};

struct TextExtent {
    int width = 0;
    int height = 0;
    bool ok = false;
};

// ── GDI 字体句柄缓存 ────────────────────────────────────────────────────────
//
// 折行是"逐字累加测量"，一段话几十个字就是几十次 GDI 调用。
// 每次都 CreateFontIndirectW/DeleteObject 太浪费（而且字体创建是相对重的操作），
// 所以按 FontSpec 缓存 HFONT。
//
// ⚠️ 线程安全：这里用一个进程级互斥量兜住。hook DLL 里可能多线程调用度量，
//    而 GDI 句柄本身可以跨线程用（只要不并发销毁/使用同一个 DC），
//    但我们自己在做缓存表的增删，必须锁。
class GdiFontCache {
public:
    static GdiFontCache& Instance() {
        static GdiFontCache inst;
        return inst;
    }

    /** 取（必要时创建）该字体规格对应的 HFONT；失败返回 nullptr */
    HFONT Get(const FontSpec& spec) {
        const std::wstring key = spec.Key();
        {
            Lock lk(&mu_);
            auto it = cache_.find(key);
            if (it != cache_.end()) return it->second;
        }
        LOGFONTW lf = spec.ToLogFont();
        HFONT h = CreateFontIndirectW(&lf);
        if (!h) return nullptr;
        Lock lk(&mu_);
        // 双检：另一线程可能刚插进去，那就用它的、把我们的删掉
        auto it = cache_.find(key);
        if (it != cache_.end()) {
            DeleteObject(h);
            return it->second;
        }
        cache_[key] = h;
        return h;
    }

    /** 清掉所有缓存（还原/退出时用；注意别在别人正用句柄时清） */
    void Clear() {
        Lock lk(&mu_);
        for (auto& kv : cache_) DeleteObject(kv.second);
        cache_.clear();
    }

    ~GdiFontCache() { Clear(); }

private:
    struct Lock {
        CRITICAL_SECTION* cs;
        explicit Lock(CRITICAL_SECTION* c) : cs(c) { EnterCriticalSection(cs); }
        ~Lock() { LeaveCriticalSection(cs); }
    };
    GdiFontCache() { InitializeCriticalSection(&mu_); }
    GdiFontCache(const GdiFontCache&) = delete;
    GdiFontCache& operator=(const GdiFontCache&) = delete;

    CRITICAL_SECTION mu_{};
    std::unordered_map<std::wstring, HFONT> cache_;
};

// ── 主路径：GDI 度量 ────────────────────────────────────────────────────────

/**
 * 量一段文本的像素宽高。
 *
 * ★ 用 `GetTextExtentPoint32W` 配一个**内存 DC**：
 *   这是最接近真实渲染的度量方式（GDI 会做同样的 hinting 与字形推进），
 *   而且不需要目标进程有窗口 —— hook 可能在任何时机被调用。
 *
 * @param len -1 表示按 NUL 结尾
 */
inline TextExtent MeasureTextGdi(const FontSpec& spec, const wchar_t* text, int len = -1) {
    TextExtent out;
    if (!text) return out;
    HFONT hFont = GdiFontCache::Instance().Get(spec);
    if (!hFont) return out;

    HDC dc = CreateCompatibleDC(nullptr);
    if (!dc) return out;
    HGDIOBJ old = SelectObject(dc, hFont);

    SIZE sz{};
    const BOOL ok = GetTextExtentPoint32W(dc, text, len < 0 ? static_cast<int>(wcslen(text)) : len,
                                         &sz);
    if (ok) {
        out.width = sz.cx;
        out.height = sz.cy;
        out.ok = true;
    }

    SelectObject(dc, old);
    DeleteDC(dc);
    return out;
}

/**
 * 量**单个字符**的推进宽度（advance）。
 *
 * 为什么要单独一个函数：自动折行是"一个字一个字试加"，用整串测量
 * 每加一个字就重量一遍整串，复杂度 O(n²) 且结果会受连字影响。
 * 逐字量再累加更直接，也更符合"中文一字一格"的排版事实。
 */
inline int MeasureCharGdi(const FontSpec& spec, wchar_t ch) {
    return MeasureTextGdi(spec, &ch, 1).width;
}

/**
 * 缺字检测（GDI 路径）：这套字体**自己**有没有这个字的字形？
 *
 * 用 `GetGlyphOutlineW(GGO_METRICS)`：
 *   · 返回 `GDI_ERROR`  → 没有这个字形
 *   · 返回其它值        → 有
 *
 * ⚠️ 这条**不如查 cmap 可靠**：GDI 可能通过字体链接（font linking）
 *    替你换一套字体来画，于是"能画"但字形来自别的字体。
 *    所以缺字检测**优先用 TTF 解析路径**，GDI 只作为拿不到字体文件时的兜底。
 */
inline bool HasGlyphGdi(const FontSpec& spec, wchar_t ch) {
    HFONT hFont = GdiFontCache::Instance().Get(spec);
    if (!hFont) return false;
    HDC dc = CreateCompatibleDC(nullptr);
    if (!dc) return false;
    HGDIOBJ old = SelectObject(dc, hFont);

    GLYPHMETRICS gm{};
    // 用固定矩阵：GLYPHMETRICS 只关心是否有字形，变换矩阵不影响"有没有"
    static const MAT2 kIdentity = {
        {0, 1}, {0, 0}, {0, 0}, {0, 1}   // FIXED 是 16.16，{fract, value}
    };
    const DWORD r = GetGlyphOutlineW(dc, static_cast<UINT>(ch), GGO_METRICS, &gm, 0, nullptr,
                                     &kIdentity);
    SelectObject(dc, old);
    DeleteDC(dc);
    return r != GDI_ERROR;
}

// ── 降级路径：最小 TrueType / OpenType 解析 ─────────────────────────────────

/**
 * 从 sfnt（TrueType/OpenType）字节流里读我们需要的几张表。
 *
 * 只做四件事：① 找表 ② 查 cmap 里某码位有没有字形 ③ 取 advance width
 *            ④ 判断字形是不是"空轮廓"（映射了但没实体，视觉上也是空白）
 *
 * 支持：TTF / OTF(CFF) / **TTC（字体集合，取第 0 个子字体）**
 *       cmap 子表 format 4（BMP）与 format 12（全 Unicode）
 */
class SfntFace {
public:
    /** 从内存加载（不复制：调用方要保证内存在本对象生命周期内有效） */
    bool Load(const uint8_t* data, size_t size) {
        data_ = nullptr;
        size_ = 0;
        tables_.clear();
        cmapSub_ = 0;
        numGlyphs_ = 0;
        unitsPerEm_ = 0;
        numHMetrics_ = 0;
        loca_ = 0;
        glyf_ = 0;
        indexToLocFormat_ = 0;
        hasGlyf_ = false;
        if (!data || size < 12) return false;

        const uint8_t* base = data;      // 读"偏移表 + 表目录"的位置
        size_t fileSize = size;          // 表偏移的参照系（见下）

        // ── TTC：跳过集合头，取第 0 个子字体的偏移表 ──
        //
        // ★★ 这里有个容易搞错的地方：TTC 里各表的 offset 是相对
        //    **整个文件开头**，而不是相对子字体自己的偏移表。★★
        //    所以 `base`（读目录的地方）要挪到子字体处，
        //    但表偏移的参照系仍是文件开头 —— 两者不能混成一个变量。
        //    （本轮实测踩到：把参照系也改成了子字体处，于是
        //      `off + len > baseSize` 全部越界被跳过 → maxp 找不到 →
        //      numGlyphs=0 → 所有 TTC 字体都判成"什么字都没有"。）
        if (RdU32At(data, 0) == 0x74746366u /* 'ttcf' */) {
            if (size < 16) return false;
            const uint32_t off = RdU32At(data, 12);   // offsets[0]
            if (off + 12 > size) return false;
            base = data + off;
        }

        const uint32_t version = RdU32At(base, 0);
        // 0x00010000 = TrueType；'OTTO' = CFF 轮廓；'true'/'typ1' 是老 Mac 的
        if (version != 0x00010000u && version != 0x4F54544Fu /* OTTO */ &&
            version != 0x74727565u /* true */ && version != 0x00010000u) {
            return false;
        }

        const uint16_t numTables = RdU16At(base, 4);
        if (numTables == 0 || numTables > 512) return false;
        const size_t dirOff = static_cast<size_t>(base - data);
        if (dirOff + 12 + static_cast<size_t>(numTables) * 16 > fileSize) return false;

        for (uint16_t i = 0; i < numTables; ++i) {
            const size_t rec = 12 + static_cast<size_t>(i) * 16;
            const uint32_t tag = RdU32At(base, rec);
            const uint32_t off = RdU32At(base, rec + 8);
            const uint32_t len = RdU32At(base, rec + 12);
            // 表偏移相对**文件开头**（TTC 亦如此），所以拿 off 直接配 data/size
            if (off > fileSize || static_cast<size_t>(off) + len > fileSize) continue;
            tables_[tag] = static_cast<uint32_t>(off);
        }

        data_ = data;
        size_ = fileSize;

        const uint32_t head = Table(MAKE_TAG('h', 'e', 'a', 'd'));
        if (head) {
            unitsPerEm_ = RdU16At(data_, head + 18);
            indexToLocFormat_ = RdI16At(data_, head + 50);
        }
        if (unitsPerEm_ == 0) unitsPerEm_ = 1000;   // 缺 head 时给个常见值，别除以 0

        const uint32_t maxp = Table(MAKE_TAG('m', 'a', 'x', 'p'));
        if (maxp) numGlyphs_ = RdU16At(data_, maxp + 4);

        const uint32_t hhea = Table(MAKE_TAG('h', 'h', 'e', 'a'));
        if (hhea) numHMetrics_ = RdU16At(data_, hhea + 34);

        loca_ = Table(MAKE_TAG('l', 'o', 'c', 'a'));
        glyf_ = Table(MAKE_TAG('g', 'l', 'y', 'f'));
        hasGlyf_ = (loca_ != 0 && glyf_ != 0);

        SelectCmapSubtable();
        return true;
    }

    bool Valid() const { return data_ != nullptr; }
    int UnitsPerEm() const { return unitsPerEm_ > 0 ? unitsPerEm_ : 1000; }
    int NumGlyphs() const { return numGlyphs_; }

    /** 该码位在这套字体里有没有**非空**字形 */
    bool HasGlyph(uint32_t cp) const {
        const uint32_t g = GlyphIndex(cp);
        if (g == 0) return false;
        // 映射到了 glyph 0（.notdef）就是"没有"
        // 另外：映射到非 0 但轮廓为空 → 视觉上仍然是空白，也算没有
        if (hasGlyf_ && !GlyphHasOutline(g)) return false;
        return true;
    }

    /** advance width，换算成"按 unitsPerEm 归一化的千分比"更便于调用方缩放 */
    int AdvanceUnits(uint32_t cp) const {
        const uint32_t g = GlyphIndex(cp);
        const uint32_t hmtx = Table(MAKE_TAG('h', 'm', 't', 'x'));
        if (!hmtx || numHMetrics_ == 0) return unitsPerEm_ / 2;   // 猜个半角，别崩
        const uint32_t idx = (g < numHMetrics_) ? g : (numHMetrics_ - 1);
        const size_t at = hmtx + static_cast<size_t>(idx) * 4;
        if (at + 2 > size_) return unitsPerEm_ / 2;
        return RdU16At(data_, at);
    }

    /** 用字体自带的 advance 度量文本（像素），供 GDI 不可用时降级 */
    int MeasureTextPx(uint32_t cp, int pixelHeight) const {
        const int upm = UnitsPerEm();
        const int adv = AdvanceUnits(cp);
        // pixelHeight 是"字符高度"，advance 是同一坐标系下的宽度，
        // 直接按 unitsPerEm 等比换算即可
        return static_cast<int>((static_cast<int64_t>(adv) * pixelHeight + upm / 2) / upm);
    }

private:
    static uint32_t MAKE_TAG(char a, char b, char c, char d) {
        return (static_cast<uint32_t>(static_cast<uint8_t>(a)) << 24) |
               (static_cast<uint32_t>(static_cast<uint8_t>(b)) << 16) |
               (static_cast<uint32_t>(static_cast<uint8_t>(c)) << 8) |
               static_cast<uint32_t>(static_cast<uint8_t>(d));
    }

    uint32_t Table(uint32_t tag) const {
        auto it = tables_.find(tag);
        return it == tables_.end() ? 0 : it->second;
    }

    // ★★ 全部按**大端**读 ★★
    //
    // sfnt（TrueType / OpenType）是 **big-endian** 格式 —— 这是从 Apple 时代
    // 沿用下来的历史包袱。所有多字节字段（表目录、cmap、hmtx…）都是大端。
    //
    // 本轮实测踩到的坑：一开始按小端读，于是
    //   · `ttcf` 被读成 0x66637474（而常量是 0x74746366）→ TTC 判断失效
    //   · `00 01 00 00` 被读成 0x00000100（而常量是 0x00010000）→ 版本判断失效
    // 结果是**所有字体文件都解析失败**，而失败又是静默的
    // （HasGlyph 退回 GDI 判断，任何字都判成"有"）。
    // 判断特征：文件前 4 字节看着像乱码，其实就是 ASCII 被按错字节序读了。
    static uint16_t RdU16At(const uint8_t* p, size_t o) {
        return static_cast<uint16_t>((static_cast<uint16_t>(p[o]) << 8) | p[o + 1]);
    }
    static int16_t RdI16At(const uint8_t* p, size_t o) {
        return static_cast<int16_t>(RdU16At(p, o));
    }
    static uint32_t RdU32At(const uint8_t* p, size_t o) {
        return (static_cast<uint32_t>(p[o]) << 24) | (static_cast<uint32_t>(p[o + 1]) << 16) |
               (static_cast<uint32_t>(p[o + 2]) << 8) | static_cast<uint32_t>(p[o + 3]);
    }
    uint16_t RdU16(size_t o) const { return o + 2 <= size_ ? RdU16At(data_, o) : 0; }
    uint32_t RdU32(size_t o) const { return o + 4 <= size_ ? RdU32At(data_, o) : 0; }

    /** 挑一个能用的 cmap 子表：优先 (3,10) format12 → (3,1) format4 → (0,*) */
    void SelectCmapSubtable() {
        const uint32_t cmap = Table(MAKE_TAG('c', 'm', 'a', 'p'));
        if (!cmap) return;
        const uint16_t n = RdU16At(data_, cmap + 2);
        if (n == 0 || n > 64) return;
        if (cmap + 4 + static_cast<size_t>(n) * 8 > size_) return;

        uint32_t best = 0;
        int bestScore = -1;
        for (uint16_t i = 0; i < n; ++i) {
            const size_t rec = cmap + 4 + static_cast<size_t>(i) * 8;
            const uint16_t plat = RdU16At(data_, rec);
            const uint16_t enc = RdU16At(data_, rec + 2);
            const uint32_t off = RdU32At(data_, rec + 4);
            const size_t at = cmap + off;
            if (at + 4 > size_) continue;
            const uint16_t fmt = RdU16At(data_, at);
            int score = -1;
            if (fmt == 12 && ((plat == 3 && enc == 10) || plat == 0)) score = 100;
            else if (fmt == 4 && plat == 3 && enc == 1) score = 90;
            else if (fmt == 4 && plat == 0) score = 80;
            else if (fmt == 4) score = 60;
            else if (fmt == 6) score = 40;
            else if (fmt == 0) score = 20;
            if (score > bestScore) {
                bestScore = score;
                best = static_cast<uint32_t>(at);
            }
        }
        cmapSub_ = best;
    }

    /** 码位 → 字形索引；0 表示 .notdef（没有） */
    uint32_t GlyphIndex(uint32_t cp) const {
        if (!cmapSub_) return 0;
        if (cmapSub_ + 4 > size_) return 0;
        const uint16_t fmt = RdU16At(data_, cmapSub_);
        if (fmt == 4) return LookupFormat4(cp);
        if (fmt == 12) return LookupFormat12(cp);
        if (fmt == 6) return LookupFormat6(cp);
        if (fmt == 0) return (cp < 256 && cmapSub_ + 6 + cp < size_) ? data_[cmapSub_ + 6 + cp] : 0;
        return 0;
    }

    uint32_t LookupFormat4(uint32_t cp) const {
        const size_t t = cmapSub_;
        if (cp > 0xFFFF) return 0;
        const uint16_t segX2 = RdU16At(data_, t + 6);
        const size_t segCount = segX2 / 2;
        if (segCount == 0) return 0;
        const size_t endBase = t + 14;
        const size_t startBase = endBase + segX2 + 2;   // +2 跳过 reservedPad
        const size_t deltaBase = startBase + segX2;
        const size_t rangeBase = deltaBase + segX2;
        if (rangeBase + segX2 > size_) return 0;

        // 线性扫段（段数通常几十到几百，够快；不做二分以免多一种出错路径）
        for (size_t i = 0; i < segCount; ++i) {
            const uint16_t endC = RdU16At(data_, endBase + i * 2);
            if (cp > endC) continue;
            const uint16_t startC = RdU16At(data_, startBase + i * 2);
            if (cp < startC) return 0;
            const int16_t delta = RdI16At(data_, deltaBase + i * 2);
            const uint16_t ro = RdU16At(data_, rangeBase + i * 2);
            if (ro == 0) {
                return static_cast<uint32_t>((cp + delta) & 0xFFFF);
            }
            // idRangeOffset 是"从这一个 idRangeOffset 字段自身出发"的字节偏移
            const size_t pos = rangeBase + i * 2 + ro + (cp - startC) * 2;
            if (pos + 2 > size_) return 0;
            const uint16_t g = RdU16At(data_, pos);
            if (g == 0) return 0;
            return static_cast<uint32_t>((g + delta) & 0xFFFF);
        }
        return 0;
    }

    uint32_t LookupFormat12(uint32_t cp) const {
        const size_t t = cmapSub_;
        if (t + 16 > size_) return 0;
        const uint32_t nGroups = RdU32At(data_, t + 12);
        if (nGroups > 200000) return 0;
        const size_t base = t + 16;
        size_t lo = 0, hi = nGroups;
        while (lo < hi) {   // groups 按 startCharCode 升序，可以二分
            const size_t mid = lo + (hi - lo) / 2;
            const size_t g = base + mid * 12;
            if (g + 12 > size_) return 0;
            const uint32_t s = RdU32At(data_, g);
            const uint32_t e = RdU32At(data_, g + 4);
            if (cp < s) {
                hi = mid;
            } else if (cp > e) {
                lo = mid + 1;
            } else {
                return RdU32At(data_, g + 8) + (cp - s);
            }
        }
        return 0;
    }

    uint32_t LookupFormat6(uint32_t cp) const {
        const size_t t = cmapSub_;
        if (t + 10 > size_) return 0;
        const uint16_t first = RdU16At(data_, t + 6);
        const uint16_t count = RdU16At(data_, t + 8);
        if (cp < first || cp >= static_cast<uint32_t>(first) + count) return 0;
        const size_t pos = t + 10 + (cp - first) * 2;
        if (pos + 2 > size_) return 0;
        return RdU16At(data_, pos);
    }

    /** 字形在 glyf 表里有没有实体数据（长度 > 0） */
    bool GlyphHasOutline(uint32_t g) const {
        if (!hasGlyf_) return true;   // CFF 字体没有 glyf，交给 cmap 结论
        if (g >= numGlyphs_) return false;
        uint32_t start = 0, end = 0;
        if (indexToLocFormat_ == 0) {
            const size_t a = loca_ + g * 2;
            if (a + 4 > size_) return false;
            start = RdU16At(data_, a) * 2u;
            end = RdU16At(data_, a + 2) * 2u;
        } else {
            const size_t a = loca_ + g * 4;
            if (a + 8 > size_) return false;
            start = RdU32At(data_, a);
            end = RdU32At(data_, a + 4);
        }
        return end > start;
    }

    const uint8_t* data_ = nullptr;
    size_t size_ = 0;
    std::unordered_map<uint32_t, uint32_t> tables_;
    uint32_t cmapSub_ = 0;
    uint32_t numGlyphs_ = 0;
    uint32_t unitsPerEm_ = 0;
    uint32_t numHMetrics_ = 0;
    uint32_t loca_ = 0;
    uint32_t glyf_ = 0;
    int16_t indexToLocFormat_ = 0;
    bool hasGlyf_ = false;
};

// ── 字体文件解析：从字体族名找到磁盘上的文件 ────────────────────────────────
//
// 为什么需要：缺字检测要"直接查字体文件的 cmap"，就得先知道文件在哪。
// 字体族名 → 文件名 的唯一权威来源是注册表
// `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`，
// 值是形如 `MS Gothic & MS UI Gothic & MS PGothic (TrueType)` → `msgothic.ttc`。

/**
 * 字体族名的**别名表**：中文名 ↔ 英文名。
 *
 * ★ 为什么必须有这个（本轮实测踩到的坑）：
 *   Windows 的字体注册表里，**中文字体用的是英文名**：
 *       SimHei (TrueType)     → simhei.ttf
 *       SimSun & NSimSun      → simsun.ttc
 *       Microsoft YaHei & ... → msyh.ttc
 *   而我们（以及 `fixFontName` 的默认值）用的是**中文名**「黑体」「宋体」。
 *   直接拿「黑体」去注册表查 → 一个都匹配不上 → 解析失败 →
 *   缺字检测悄悄退化成 GDI 的"能画"判断（GDI 会做字体链接替我们换字体），
 *   于是**任何字都判成"有"**，缺字兜底整条逻辑失效。
 *   而且这个失效是**静默**的：测量照样有值、程序不报错，只是"从来不换字体"。
 *
 * 所以查表时要把等价的名字都试一遍。
 */
inline std::vector<std::wstring> FontAliases(const std::wstring& face) {
    struct Pair { const wchar_t* zh; const wchar_t* en; };
    static const Pair kMap[] = {
        {L"黑体", L"SimHei"},
        {L"宋体", L"SimSun"},
        {L"新宋体", L"NSimSun"},
        {L"仿宋", L"FangSong"},
        {L"楷体", L"KaiTi"},
        {L"微软雅黑", L"Microsoft YaHei"},
        {L"等线", L"DengXian"},
        {L"微軟正黑體", L"Microsoft JhengHei"},
        {L"微软正黑体", L"Microsoft JhengHei"},
        {L"細明體", L"MingLiU"},
        {L"细明体", L"MingLiU"},
        {L"MS ゴシック", L"MS Gothic"},
        {L"MS 明朝", L"MS Mincho"},
        {L"メイリオ", L"Meiryo"},
    };

    std::vector<std::wstring> out;
    out.push_back(face);
    for (const auto& p : kMap) {
        // 给了中文名 → 补上英文名
        if (_wcsicmp(face.c_str(), p.zh) == 0 && _wcsicmp(p.zh, p.en) != 0) {
            out.push_back(p.en);
        }
        // 给了英文名 → 补上中文名
        if (_wcsicmp(face.c_str(), p.en) == 0 && _wcsicmp(p.zh, p.en) != 0) {
            out.push_back(p.zh);
        }
    }
    return out;
}

/** 查注册表拿字体文件路径；找不到返回空串 */
inline std::wstring ResolveFontFilePath(const std::wstring& face) {
    static const wchar_t* kFontsKey =
        L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

    // ★★ 必须显式请求 **64 位视图**（`KEY_WOW64_64KEY`）★★
    //
    // 为什么：在 64 位 Windows 上跑 32 位进程时，WOW64 会把
    //   `HKLM\SOFTWARE\...` **重定向**到 `HKLM\SOFTWARE\WOW6432Node\...`，
    // 而字体注册表**只在 64 位视图里**。于是 32 位进程去查字体，永远查不到 ——
    // 而且 `RegOpenKeyExW` 会**成功**（打开的是另一个键），
    // 只是枚举出来一条都没有，看起来就像"这台机器没装任何字体"。
    //
    // 这个坑对**注入器**尤其致命：注入器经常是 32 位的（要注 32 位游戏），
    // 于是缺字检测会静默退化成 GDI 判断 → 任何字都判成"有" → 兜底逻辑全废。
    // （本轮实测踩到：32 位自检里"字体文件：（未解析，走 GDI）"。）
    //
    // 先试 64 位视图；在真正的 32 位系统上这个标志不被支持，会失败，
    // 那就退回到默认视图。
    HKEY hKey = nullptr;
    LONG r = RegOpenKeyExW(HKEY_LOCAL_MACHINE, kFontsKey, 0,
                           KEY_READ | KEY_WOW64_64KEY, &hKey);
    if (r != ERROR_SUCCESS) {
        hKey = nullptr;
        r = RegOpenKeyExW(HKEY_LOCAL_MACHINE, kFontsKey, 0, KEY_READ, &hKey);
    }
    if (r != ERROR_SUCCESS || !hKey) return L"";

    // 先把所有等价名字准备好，然后**只扫一遍注册表**（注册表可能上千条，
    // 每个别名扫一遍太浪费）
    const std::vector<std::wstring> aliases = FontAliases(face);

    std::wstring found;
    wchar_t name[512];
    BYTE value[1024];
    for (DWORD i = 0;; ++i) {
        DWORD nameLen = _countof(name);
        DWORD valueLen = sizeof(value);
        DWORD type = 0;
        const LONG r = RegEnumValueW(hKey, i, name, &nameLen, nullptr, &type, value, &valueLen);
        if (r == ERROR_NO_MORE_ITEMS) break;
        if (r != ERROR_SUCCESS) break;
        if (type != REG_SZ && type != REG_EXPAND_SZ) continue;

        const std::wstring keyName(name, nameLen);
        // 键名形如 "SimSun & NSimSun (TrueType)" / "SimHei (TrueType)" ——
        // 取 " & " 之前、" (" 之前的部分做比对
        std::wstring firstPart = keyName;
        const size_t amp = firstPart.find(L" & ");
        if (amp != std::wstring::npos) firstPart.resize(amp);
        const size_t paren = firstPart.find(L" (");
        if (paren != std::wstring::npos) firstPart.resize(paren);

        bool hit = false;
        for (const auto& a : aliases) {
            if (_wcsicmp(firstPart.c_str(), a.c_str()) == 0) {
                hit = true;
                break;
            }
        }
        if (!hit) continue;

        found = reinterpret_cast<const wchar_t*>(value);
        break;
    }
    RegCloseKey(hKey);
    if (found.empty()) return L"";

    // 注册表里存的是**文件名**（相对 %WINDIR%\Fonts），要补成完整路径
    if (found.find(L'\\') != std::wstring::npos || found.find(L'/') != std::wstring::npos) {
        return found;   // 已经是完整路径
    }
    wchar_t winDir[MAX_PATH] = {0};
    if (!GetWindowsDirectoryW(winDir, _countof(winDir))) return L"";
    return std::wstring(winDir) + L"\\Fonts\\" + found;
}

/**
 * 这个字体族名在系统里**到底存不存在**（有没有注册表项）。
 *
 * ★ 为什么要单独能问这一个问题：
 *   GDI 的 `CreateFontIndirectW` 对不存在的字体族名**不会失败** ——
 *   它会默默替换成别的字体。于是"字体不存在"这件事在 GDI 路径上
 *   完全看不出来（测得有宽度、也能画），只有查注册表才知道。
 *   配置里写了一个本机没有的字体时，必须能明确告警，
 *   而不是让用户以为"换了字体但看起来没变化"。
 */
inline bool FontFaceExists(const std::wstring& face) {
    return !ResolveFontFilePath(face).empty();
}

/** 读整个文件（字体文件可能几 MB 到几十 MB，所以上限放到 128MB） */
inline bool ReadWholeFile(const std::wstring& path, std::vector<uint8_t>* out) {
    out->clear();
    if (path.empty()) return false;
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER sz{};
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0 || sz.QuadPart > (128LL << 20)) {
        CloseHandle(h);
        return false;
    }
    out->resize(static_cast<size_t>(sz.QuadPart));
    DWORD got = 0;
    const BOOL ok = ReadFile(h, out->data(), static_cast<DWORD>(out->size()), &got, nullptr);
    CloseHandle(h);
    if (!ok || got != out->size()) {
        out->clear();
        return false;
    }
    return true;
}

// ── 门面：优先 GDI，必要时降级到 SFNT ──────────────────────────────────────

/**
 * 度量门面 —— 调用方通常只该用这个。
 *
 * 度量**优先走 GDI**（那是最终真正渲染的字体，最准）；
 * GDI 不可用时降级到"读字体文件自己算"。
 */
class TextMeasure {
public:
    /** 量文本像素宽高 */
    TextExtent Extent(const FontSpec& spec, const wchar_t* text, int len = -1) {
        TextExtent e = MeasureTextGdi(spec, text, len);
        if (e.ok) return e;
        // 降级：GDI 完全不可用时，用字体文件的 advance 近似
        EnsureFace(spec);
        if (!face_.Valid()) return e;
        int w = 0;
        const int h = spec.height < 0 ? -spec.height : spec.height;
        const wchar_t* p = text;
        const int n = (len < 0) ? (p ? static_cast<int>(wcslen(p)) : 0) : len;
        for (int i = 0; i < n && p; ++i) w += face_.MeasureTextPx(static_cast<uint32_t>(p[i]), h);
        e.width = w;
        e.height = h;
        e.ok = (n > 0);
        return e;
    }

    /** 量单字宽度 */
    int CharWidth(const FontSpec& spec, wchar_t ch) { return Extent(spec, &ch, 1).width; }

    /**
     * 缺字检测 —— **优先查字体文件自己的 cmap**。
     *
     * 为什么不是优先 GDI：GDI 会做字体链接（font linking）兜底，
     * 于是"能画"但画出来的字形来自**另一套**字体。我们要回答的问题是
     * "这套字体自己覆盖了吗"，只有 cmap 能给出这个事实。
     * （验收第 3 条要的就是这个：日文原字体没有"龘"，必须能被检测出来。）
     */
    bool HasGlyph(const FontSpec& spec, wchar_t ch) {
        EnsureFace(spec);
        if (face_.Valid()) return face_.HasGlyph(static_cast<uint32_t>(ch));
        return HasGlyphGdi(spec, ch);   // 拿不到字体文件才退回 GDI
    }

    /** 当前字体文件是否已成功加载（调试/自述用） */
    bool FaceLoaded() const { return face_.Valid(); }
    const std::wstring& FacePath() const { return facePath_; }
    int FaceUnitsPerEm() const { return face_.UnitsPerEm(); }

    /**
     * 显式把某套字体的字体文件加载起来（并返回是否成功）。
     *
     * 为什么需要暴露这个：字体文件是**懒加载**的（GDI 能用就不读文件，
     * 省掉一次注册表扫描 + 几十 MB 读盘）。但"诊断/自述"场景恰恰需要
     * **主动**知道"这套字体的文件到底是哪个、有没有解析成功"，
     * 否则会看到"FacePath() 是空的"而误以为查找失败。
     */
    bool PrimeFace(const FontSpec& spec) {
        EnsureFace(spec);
        return face_.Valid();
    }

private:
    void EnsureFace(const FontSpec& spec) {
        if (face_.Valid() && facePathKey_ == spec.face) return;
        facePathKey_ = spec.face;
        facePath_ = ResolveFontFilePath(spec.face);
        faceBytes_.clear();
        face_ = SfntFace{};
        if (facePath_.empty()) return;
        if (!ReadWholeFile(facePath_, &faceBytes_)) return;
        face_.Load(faceBytes_.data(), faceBytes_.size());
    }

    SfntFace face_;
    std::vector<uint8_t> faceBytes_;
    std::wstring facePath_;
    std::wstring facePathKey_;
};

/** 进程级单例（字体文件读一次就够，别每次查注册表+读几十 MB） */
inline TextMeasure& Measure() {
    static TextMeasure inst;
    return inst;
}

} // namespace bb
