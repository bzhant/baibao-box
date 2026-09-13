// ============================================================================
// 排版自检（N2）
// ============================================================================
//
// 为什么要有这么一个"控制台自检 exe"：
//   排版这块的判断标准大多是"宽度有没有超"、"某个字有没有字形"、"折行位置对不对"，
//   这些**全都是可以自动断言的数值**，不需要肉眼看窗口。
//   把它们做成一个无 GUI 的自检程序，就能进 CI/验收脚本，而不是靠人盯着截图。
//
// 输出的每一行都是**可被脚本解析**的形式（`KEY=value` / `[通过]` / `[失败]`），
// 供 acceptance-n2.sh 断言。
//
// 用法：measure_selftest.exe [--json]
#include <windows.h>

#include <cstdio>
#include <string>
#include <vector>

#include "../common/measure.h"
#include "../common/wrap.h"
#include "../common/fontmap.h"

using namespace bb;

static int g_pass = 0;
static int g_fail = 0;
static bool g_json = false;

static std::string Utf8(const std::wstring& w) {
    if (w.empty()) return "";
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr,
                                      0, "?", nullptr);
    std::string s(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), s.data(), n, "?",
                        nullptr);
    return s;
}

static void Check(bool cond, const std::string& name, const std::string& detail) {
    if (cond) {
        ++g_pass;
        printf("[通过] %s  %s\n", name.c_str(), detail.c_str());
    } else {
        ++g_fail;
        printf("[失败] %s  %s\n", name.c_str(), detail.c_str());
    }
}

static void Note(const std::string& s) { printf("       %s\n", s.c_str()); }

// ── 字体注册表可读性诊断 ────────────────────────────────────────────────────
//
// 整套"缺字检测"的地基是"能读到字体文件"。读不到就会**静默**退化成 GDI 判断
// （GDI 会做字体链接替我们换字体），表现是"任何字都判成有字形"——
// 程序不报错、测量也正常，只是缺字兜底永不生效。所以这一项必须单独断言。
static void TestFontRegistry() {
    printf("\n=== 0) 字体注册表可读性（缺字检测的地基）===\n");

    const wchar_t* kKey = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
    HKEY hk = nullptr;
    LONG r64 = RegOpenKeyExW(HKEY_LOCAL_MACHINE, kKey, 0, KEY_READ | KEY_WOW64_64KEY, &hk);
    printf("       KEY_WOW64_64KEY 打开字体键: %s (rc=%ld)\n",
           r64 == ERROR_SUCCESS ? "成功" : "失败", static_cast<long>(r64));
    HKEY hk2 = nullptr;
    LONG r32 = RegOpenKeyExW(HKEY_LOCAL_MACHINE, kKey, 0, KEY_READ, &hk2);
    printf("       默认视图打开字体键:        %s (rc=%ld)\n",
           r32 == ERROR_SUCCESS ? "成功" : "失败", static_cast<long>(r32));

    HKEY use = (r64 == ERROR_SUCCESS) ? hk : hk2;
    if (!use || (r64 != ERROR_SUCCESS && r32 != ERROR_SUCCESS)) {
        Check(false, "能打开字体注册表键", "两个视图都打不开");
        return;
    }

    DWORD count = 0;
    wchar_t name[512];
    BYTE value[1024];
    for (DWORD i = 0; i < 5000; ++i) {
        DWORD nl = _countof(name), vl = sizeof(value), type = 0;
        const LONG e = RegEnumValueW(use, i, name, &nl, nullptr, &type, value, &vl);
        if (e == ERROR_NO_MORE_ITEMS) break;
        if (e != ERROR_SUCCESS) break;
        if (count < 3) {
            printf("       样例值: %ls → %ls\n", name,
                   type == REG_SZ ? reinterpret_cast<const wchar_t*>(value) : L"(非字符串)");
        }
        ++count;
    }
    printf("       枚举到 %lu 个值\n", static_cast<unsigned long>(count));
    Check(count > 10, "字体注册表里能枚举出字体条目",
          std::to_string(count) + " 条（>10 才算正常）");

    // ★ 关键断言：至少有一款**中文字体**能被解析成文件
    const bool hei = FontFaceExists(L"黑体");
    const bool song = FontFaceExists(L"宋体");
    const bool yh = FontFaceExists(L"微软雅黑");
    printf("       黑体=%s 宋体=%s 微软雅黑=%s\n", hei ? "有" : "无", song ? "有" : "无",
           yh ? "有" : "无");
    Check(hei || yh || song, "至少有一款中文字体能解析到字体文件",
          std::string("黑体=") + (hei ? "有" : "无") + " 宋体=" + (song ? "有" : "无") +
              " 雅黑=" + (yh ? "有" : "无"));

    if (r64 == ERROR_SUCCESS) RegCloseKey(hk);
    if (r32 == ERROR_SUCCESS && hk2) RegCloseKey(hk2);
}

// ── 字体文件加载/解析诊断 ───────────────────────────────────────────────────
//
// 上面确认了"路径能查到"，这一步确认"文件能读、能解析"。
// 分开诊断是因为这两步会以完全不同的方式失败：
//   · 路径查不到 → 注册表/视图问题
//   · 文件读不到 → 权限/路径拼接问题
//   · 文件读了但解析不了 → 格式问题（TTC 没处理、版本号判断太严…）
static void TestFontLoad() {
    printf("\n=== 0b) 字体文件读取与解析 ===\n");
    struct Item { const wchar_t* face; };
    const Item items[] = {{L"黑体"}, {L"宋体"}, {L"MS Gothic"}, {L"微软雅黑"}};

    for (const auto& it : items) {
        const std::wstring path = ResolveFontFilePath(it.face);
        printf("       %-12ls 路径=%s\n", it.face, path.empty() ? "(空)" : Utf8(path).c_str());
        if (path.empty()) continue;

        std::vector<uint8_t> bytes;
        if (!ReadWholeFile(path, &bytes)) {
            printf("                    文件读取失败（err=%lu）\n",
                   static_cast<unsigned long>(GetLastError()));
            continue;
        }
        // sfnt 是**大端**格式，这里也按大端读，否则显示出来是"看起来像乱码"
        // 的字节交换值（比如 ttcf 变成 0x66637474），反而不利于定位
        const uint32_t magic =
            bytes.size() >= 4 ? ((static_cast<uint32_t>(bytes[0]) << 24) |
                                 (static_cast<uint32_t>(bytes[1]) << 16) |
                                 (static_cast<uint32_t>(bytes[2]) << 8) |
                                 static_cast<uint32_t>(bytes[3]))
                              : 0;
        printf("                    大小=%zu 字节  前4字节=0x%08x (%s)\n", bytes.size(), magic,
               magic == 0x00010000u   ? "TrueType"
               : magic == 0x74746366u ? "TTC 字体集合"
               : magic == 0x4F54544Fu ? "OpenType/CFF"
                                      : "??");

        SfntFace f;
        const bool ok = f.Load(bytes.data(), bytes.size());
        printf("                    解析=%s", ok ? "成功" : "**失败**");
        if (ok) {
            printf("  unitsPerEm=%d numGlyphs=%d  龘=%s あ=%s 好=%s\n", f.UnitsPerEm(),
                   f.NumGlyphs(), f.HasGlyph(0x9F98) ? "有" : "无", f.HasGlyph(0x3042) ? "有" : "无",
                   f.HasGlyph(0x597D) ? "有" : "无");
            // 自洽性检查：全角汉字的 advance 应约等于 unitsPerEm
            // （unitsPerEm 读错的话这个比值会明显不是 1.0，立刻能看出来）
            const int upm = f.UnitsPerEm();
            const int advHao = f.AdvanceUnits(0x597D);
            const int advA = f.AdvanceUnits(L'A');
            printf("                    advance: 好=%d (%.2f em)  A=%d (%.2f em)\n", advHao,
                   upm ? static_cast<double>(advHao) / upm : 0.0, advA,
                   upm ? static_cast<double>(advA) / upm : 0.0);
        } else {
            printf("\n");
        }
    }
}

// ── 度量自检 ────────────────────────────────────────────────────────────────

static void TestMeasure() {
    printf("\n=== 1) 文本度量 ===\n");

    FontSpec heiti;
    heiti.face = L"黑体";
    heiti.height = -20;

    const wchar_t* zh = L"你好世界";
    const TextExtent e1 = Measure().Extent(heiti, zh);
    Check(e1.ok && e1.width > 0, "黑体 20px 量中文有正宽度",
          "width=" + std::to_string(e1.width) + " height=" + std::to_string(e1.height));
    // 字体文件是懒加载的，这里主动起一次，好把解析结果显示出来
    const bool heiPrimed = Measure().PrimeFace(heiti);
    Note("黑体 字体文件：" + (heiPrimed ? Utf8(Measure().FacePath()) : std::string("（解析失败）")) +
         (heiPrimed ? "（已解析，unitsPerEm=" + std::to_string(Measure().FaceUnitsPerEm()) + "）"
                    : "（将退回 GDI 判断）"));

    // 同为 4 个汉字，宽高应当一致（中文等宽是排版的基本假设）
    const TextExtent e2 = Measure().Extent(heiti, L"上下左右");
    Check(e1.width == e2.width, "同样 4 个汉字宽度一致（中文等宽假设）",
          std::to_string(e1.width) + " vs " + std::to_string(e2.width));

    // 8 个字应当是 4 个字的两倍（中文等宽下）
    const TextExtent e3 = Measure().Extent(heiti, L"你好世界你好世界");
    Check(e3.width == e1.width * 2, "8 字宽度 = 4 字宽度的 2 倍",
          std::to_string(e3.width) + " vs " + std::to_string(e1.width * 2));

    // 逐字累加应当约等于整串测量（折行算法依赖这条）
    int sum = 0;
    for (const wchar_t* p = zh; *p; ++p) sum += Measure().CharWidth(heiti, *p);
    Check(sum == e1.width, "逐字累加 == 整串测量（折行算法的基础）",
          std::to_string(sum) + " vs " + std::to_string(e1.width));

    // 字号变大，宽度必须变大（单调性）
    FontSpec big = heiti;
    big.height = -40;
    const TextExtent e4 = Measure().Extent(big, zh);
    Check(e4.width > e1.width, "字号 20→40 宽度变大",
          std::to_string(e1.width) + " → " + std::to_string(e4.width));

    // 英文/半角：应当明显窄于同字数的中文
    const TextExtent e5 = Measure().Extent(heiti, L"abcd");
    Check(e5.width > 0 && e5.width < e1.width, "4 个英文比 4 个汉字窄",
          std::to_string(e5.width) + " < " + std::to_string(e1.width));
}

// ── 缺字检测自检 ────────────────────────────────────────────────────────────

static void TestGlyphCoverage() {
    printf("\n=== 2) 缺字检测（验收第 3 条的基础）===\n");

    // "龘"（U+9F98）是笔画极多的生僻字，日文传统字体（MS Gothic / MS Mincho）
    // 基本都不含；中文字体（黑体/宋体）应当含。
    const wchar_t kRare = L'龘';

    FontSpec gothic;
    gothic.face = L"MS Gothic";
    gothic.height = -20;
    gothic.charset = SHIFTJIS_CHARSET;

    FontSpec simhei;
    simhei.face = L"黑体";
    simhei.height = -20;

    FontSpec simsun;
    simsun.face = L"宋体";
    simsun.height = -20;

    const bool gGothic = Measure().HasGlyph(gothic, kRare);
    const bool gHei = Measure().HasGlyph(simhei, kRare);
    const bool gSong = Measure().HasGlyph(simsun, kRare);

    // 把每套字体的"文件是否解析成功"打出来 ——
    // ★ 这一步很关键：如果字体文件没解析成功，HasGlyph 会**静默退化**成
    //   GDI 判断，而 GDI 会做字体链接（替你换一套字体去画），
    //   于是**任何字都判成"有"**，缺字兜底整条逻辑失效却看不出异常。
    auto diag = [&](const wchar_t* face, FontSpec spec) {
        const bool ok = Measure().PrimeFace(spec);
        printf("       %ls: %s\n", face,
               ok ? Utf8(Measure().FacePath()).c_str() : "**字体文件解析失败（会退化成 GDI 判断）**");
    };
    diag(L"MS Gothic", gothic);
    diag(L"黑体", simhei);
    diag(L"宋体", simsun);

    printf("       龘 在 MS Gothic = %s\n", gGothic ? "有" : "无");
    printf("       龘 在 黑体       = %s\n", gHei ? "有" : "无");
    printf("       龘 在 宋体       = %s\n", gSong ? "有" : "无");

    // 我们要的判定：至少有一款系统中文字体覆盖它，否则"字体替换"方案无从落地
    Check(gHei || gSong, "系统里至少有一款中文字体含「龘」字形",
          std::string("黑体=") + (gHei ? "有" : "无") + " 宋体=" + (gSong ? "有" : "无"));

    // 常规汉字必须都有（这几款字体不可能缺）
    Check(Measure().HasGlyph(simhei, L'好') && Measure().HasGlyph(simsun, L'好'),
          "「好」在黑体与宋体里都有", "");

    // 日文假名在日文字体里必须有
    Check(Measure().HasGlyph(gothic, L'あ'), "「あ」在 MS Gothic 里有", "");

    // 反向：随便一个极偏僻的码位（私用区）应当**没有**
    const bool hasPua = Measure().HasGlyph(simhei, static_cast<wchar_t>(0xE000));
    Check(!hasPua, "私用区 U+E000 在黑体里判为没有字形（检测不是永远返回 true）",
          hasPua ? "竟然有" : "无（正确）");
}

// ── 折行自检 ────────────────────────────────────────────────────────────────

static void TestWrap() {
    printf("\n=== 3) 自动折行 ===\n");

    FontSpec heiti;
    heiti.face = L"黑体";
    heiti.height = -16;

    // 造一段约 3 倍长度的中文（验收要求"塞 3 倍长度的中文"）
    const std::wstring base = L"欢迎来到白的百宝箱。";
    std::wstring longText;
    for (int i = 0; i < 3; ++i) longText += base;
    printf("       原文 %zu 字\n", longText.size());

    const int boxWidth = 200;   // 固定宽度对话框
    WrapOptions opt;
    opt.maxCharsPerLine = 0;    // 先只用宽度约束

    const WrappedText w = WrapText(Measure(), heiti, longText, boxWidth, opt);
    printf("       折成 %zu 行\n", w.lines.size());
    for (size_t i = 0; i < w.lines.size(); ++i) {
        const int lw = Measure().Extent(heiti, w.lines[i].c_str()).width;
        printf("         行%zu (%2zu字, %3dpx): %s\n", i + 1, w.lines[i].size(), lw,
               Utf8(w.lines[i]).c_str());
    }

    Check(!w.lines.empty(), "折行结果非空", std::to_string(w.lines.size()) + " 行");

    bool allFit = true;
    int widest = 0;
    for (const auto& line : w.lines) {
        const int lw = Measure().Extent(heiti, line.c_str()).width;
        if (lw > widest) widest = lw;
        if (lw > boxWidth) allFit = false;
    }
    Check(allFit, "每一行宽度都 <= 区域宽（验收第 1 条：不溢出）",
          "最宽 " + std::to_string(widest) + " <= " + std::to_string(boxWidth));

    // 内容不能丢：所有行的字符合起来必须等于原文
    std::wstring joined;
    for (const auto& line : w.lines) joined += line;
    Check(joined == longText, "折行不丢字、不加字（拼回去与原文完全一致）",
          "原文 " + std::to_string(longText.size()) + " 字，拼回 " +
              std::to_string(joined.size()) + " 字");

    // ── 行首禁则：标点不能跑到行首 ──
    // 构造一个"恰好在标点前断行"的场景：宽度只够放 N 个字，第 N+1 个是"。" 
    // 我们用逐字宽度算出"刚好能放 k 个字"的宽度，再多一点让断点落在句号上。
    {
        const std::wstring s = L"你好世界。再见世界。";
        const int oneChar = Measure().CharWidth(heiti, L'你');
        // 宽度刚好 4 个字：第 5 个是"。"，禁则生效时应把它推到下一行
        const int w4 = oneChar * 4;
        const WrappedText w2 = WrapText(Measure(), heiti, s, w4, opt);
        bool punctAtLineStart = false;
        for (const auto& line : w2.lines) {
            if (!line.empty() && IsLineStartForbidden(line[0])) punctAtLineStart = true;
        }
        Check(!punctAtLineStart, "行首禁则：标点没有出现在任何行的行首",
              "宽度=" + std::to_string(w4) + "px，折成 " + std::to_string(w2.lines.size()) +
                  " 行，首行=" + Utf8(w2.lines.empty() ? L"" : w2.lines[0]));

        bool punctAtLineEnd = false;
        for (const auto& line : w2.lines) {
            if (!line.empty() && IsLineEndForbidden(line.back())) punctAtLineEnd = true;
        }
        // 左括号出现在行尾也是禁则（"（"不能收尾）
        Check(!punctAtLineEnd, "行尾禁则：左括号类字符没有出现在任何行的行尾", "");
    }

    // ── 每行最大字数兜底 ──
    {
        WrapOptions o2;
        o2.maxCharsPerLine = 6;
        const WrappedText w3 = WrapText(Measure(), heiti, longText, 100000, o2);
        size_t maxSeen = 0;
        for (const auto& line : w3.lines) maxSeen = line.size() > maxSeen ? line.size() : maxSeen;
        Check(maxSeen <= 6, "每行最大字数上限生效（宽度很宽也按字数断）",
              "最长 " + std::to_string(maxSeen) + " <= 6");
    }

    // ── 英文单词不拆 ──
    {
        const std::wstring s = L"hello wonderful world";
        // ★ 区域宽必须**大于最长的那个词**，否则"拆词"是唯一可行的排版
        //   （真实排版器遇到超长单词也只能硬切 ——
        //     我第一版把区域设成 60px 而 "wonderful" 要 90px，
        //     于是测的其实是"超长词硬切"，那不算 bug，是测试用例本身不成立。
        //     这里按实测词宽动态定区域，确保测的是**真正的整词换行**。）
        // ⚠️ windows.h 把 `max` 定义成了**宏**，所以 `std::max(` 会被宏展开掉、
        //    报一串莫名其妙的语法错误。写成 `(std::max)(...)` 就能绕过宏。
        const int longest = (std::max)(Measure().Extent(heiti, L"wonderful").width,
                                       Measure().Extent(heiti, L"hello").width);
        const int boxW = longest + 4;   // 装得下任意一个词，但装不下两个
        WrapOptions o3;
        const WrappedText w4 = WrapText(Measure(), heiti, s, boxW, o3);

        // 判据：把所有行的**词**按顺序收集起来，必须和原文的词序列完全一致
        //      —— 这才是"没有哪个词被从中间切成两半"的准确表述。
        auto tokenize = [](const std::wstring& in) {
            std::vector<std::wstring> t;
            std::wstring cur;
            for (wchar_t c : in) {
                if (IsSpace(c)) {
                    if (!cur.empty()) { t.push_back(cur); cur.clear(); }
                } else {
                    cur.push_back(c);
                }
            }
            if (!cur.empty()) t.push_back(cur);
            return t;
        };
        // ⚠️ 注意：这里要**用空格**把各行拼起来再分词。
        //    直接用 `Joined()`（无分隔符拼接）会把 "hello"+"wonderful"+"world"
        //    粘成 "hellowonderfulworld" 一个词，于是永远判"不一致" ——
        //    我第一版就是这么错的：代码是对的、测试是错的。
        //    `Joined()` 的用途是"逐字符比对有没有丢字"（那就不该加分隔符）。
        std::wstring reflow;
        for (const auto& line : w4.lines) {
            if (!reflow.empty()) reflow += L' ';
            reflow += line;
        }
        const auto orig = tokenize(s);
        const auto got = tokenize(reflow);
        const bool sameWords = (orig == got);
        printf("       英文折行结果（区域宽 %dpx，词宽 %dpx）:\n", boxW, longest);
        for (size_t i = 0; i < w4.lines.size(); ++i) {
            printf("         行%zu: %s\n", i + 1, Utf8(w4.lines[i]).c_str());
        }
        Check(sameWords, "英文单词不被从中间拆开（词序列与原文一致）",
              std::to_string(w4.lines.size()) + " 行，区域宽 " + std::to_string(boxW) + "px（词宽 " +
                  std::to_string(longest) + "），词序列" +
                  (sameWords ? "一致" : "**不一致（有词被拆开）**"));

        // 顺带确认它确实换了行（否则这个用例没测到东西）
        Check(w4.lines.size() >= 2, "窄区域下英文确实发生了换行（用例有效）",
              std::to_string(w4.lines.size()) + " 行");
    }
}

// ── 字号自适应自检 ─────────────────────────────────────────────────────────

static void TestAutoFontSize() {
    printf("\n=== 4) 字号自适应（验收第 2 条）===\n");

    FontSpec heiti;
    heiti.face = L"黑体";
    heiti.height = -24;   // 基准字号偏大，故意让它放不下

    const std::wstring text = L"欢迎来到白的百宝箱，这里用来演示字号自适应与自动折行。";
    // 故意给一个"窄而矮"的区域：高只够 3 行，24px 基准字号放不下
    const int boxW = 180;
    const int boxH = 3 * 24;   // 3 行基准高度

    AutoFitOptions ao;
    ao.minHeight = -8;
    ao.maxShrinkSteps = 24;

    const AutoFitResult r = AutoFitFontSize(Measure(), heiti, text, boxW, boxH, ao);

    printf("       基准字号 %d，最终字号 %d，缩小 %d 级，%zu 行，高 %d（区域高 %d）\n",
           -heiti.height, -r.font.height, r.shrinkSteps, r.wrapped.lines.size(), r.usedHeight,
           boxH);
    for (size_t i = 0; i < r.wrapped.lines.size(); ++i) {
        printf("         行%zu: %s\n", i + 1, Utf8(r.wrapped.lines[i]).c_str());
    }

    Check(r.ok, "字号自适应成功找到放得下的字号",
          std::to_string(-heiti.height) + "px → " + std::to_string(-r.font.height) + "px");
    Check(r.usedHeight <= boxH, "自适应后的总高度 <= 区域高（验收第 2 条：完整可见）",
          std::to_string(r.usedHeight) + " <= " + std::to_string(boxH));
    Check(r.heightFits && r.widthFits, "宽高都在区域内", "");
    if (r.shrinkSteps > 0) {
        Note("确实降了字号，说明基准字号本来就放不下 —— 这个用例是有效的");
    } else {
        Note("⚠️ 没降字号，这个用例可能没测到东西");
    }
}

// ── 字体替换自检 ───────────────────────────────────────────────────────────

static void TestFontSubstitution() {
    printf("\n=== 5) 字体替换（缺字兜底）===\n");

    // 决策函数：给定"原字体 + 文本"，返回该用哪套字体
    FontResolver res;
    FontResolveOptions ro;
    ro.fixFontName = L"黑体";      // 配置项默认值
    ro.fallbackFace = L"宋体";     // 兜底字体（模拟"内嵌 CJK 字体"的角色）

    FontSpec gameFont;
    gameFont.face = L"MS Gothic";
    gameFont.height = -18;
    gameFont.charset = SHIFTJIS_CHARSET;

    // ① 全是日文假名 → 原字体够用，不该换
    const FontSubstitution s1 = res.Resolve(Measure(), gameFont, L"こんにちは", ro);
    Check(!s1.substituted, "纯日文文本不触发替换（不做无谓的字体改动）",
          Utf8(s1.chosen.face) + " 原因=" + s1.reason);

    // ② 含"龘" → MS Gothic 缺字 → 必须替换
    const FontSubstitution s2 = res.Resolve(Measure(), gameFont, L"你好龘世界", ro);
    Check(s2.substituted, "含「龘」触发字体替换（验收第 3 条：不能是豆腐块）",
          Utf8(s2.chosen.face) + " 原因=" + s2.reason);

    // 替换后的字体必须真的能画出那个字
    if (s2.substituted) {
        Check(Measure().HasGlyph(s2.chosen, L'龘'),
              "替换后的字体确实含「龘」字形（不是随便换一个）", Utf8(s2.chosen.face));
    }

    // ③ 缺字清单要能报出来
    std::vector<wchar_t> missing = res.FindMissingGlyphs(Measure(), gameFont, L"你好龘世界");
    Check(missing.size() == 1 && missing[0] == L'龘',
          "缺字清单准确报出「龘」（用于日志/界面提示）",
          "缺 " + std::to_string(missing.size()) + " 个");

    // ④ 还原：替换后能回到原始字体
    FontOverrideState st;
    st.Apply(gameFont);
    Check(st.HasOriginal() && st.Original().face == L"MS Gothic", "记录原始字体，准备替换", "");
    st.SetOverride(s2.chosen);
    Check(st.IsOverridden() && st.Override().face == s2.chosen.face, "替换生效",
          Utf8(st.Override().face));
    st.Restore();
    Check(!st.IsOverridden() && st.Current().face == L"MS Gothic",
          "还原后字体回到原始值（验收第 4 条）", Utf8(st.Current().face));
}

int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--json") == 0) g_json = true;
    }
    // 控制台按 UTF-8 输出，避免脚本按 GBK 解码拿到乱码
    SetConsoleOutputCP(CP_UTF8);

    printf("================ 排版自检 (N2) ================\n");
    printf("%d 位进程\n", static_cast<int>(sizeof(void*) * 8));

    TestFontRegistry();
    TestFontLoad();
    TestMeasure();
    TestGlyphCoverage();
    TestWrap();
    TestAutoFontSize();
    TestFontSubstitution();

    printf("\n================ 结果 ================\n");
    printf("通过 %d 项，失败 %d 项\n", g_pass, g_fail);
    printf("PASS=%d FAIL=%d\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
