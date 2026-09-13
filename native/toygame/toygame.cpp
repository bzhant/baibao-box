// ============================================================================
// 玩具目标程序（N0 第一步）
//
// 作用：给"编码层 hook"提供一个**可控、可复现**的验证对象。
// 工程经验：
//   "直接拿真游戏调试会把人拖死" —— 每个引擎都必须先过一个玩具目标。
//
// 它刻意做得很朴素：
//   · Win32 GUI，**不用任何游戏引擎**，**不依赖我们自己的任何库**
//   · 文本以 **Shift-JIS（CP932）字节** 存在 exe 里（不是宽字符！）
//   · 每帧走 MultiByteToWideChar(CP932) 转成宽字符，再用 GDI 的 TextOutW 画出来
//   · 一个按钮在两种模式间切换，方便**肉眼 A/B 对比** hook 是否生效：
//       原始 = 每帧都重新转换（hook 能拦住）
//       缓存 = 启动时转换一次后一直用（hook 拦不到）→ 确认"变中文"确实是 hook 干的
//   · 窗口标题显示当前模式与 API 调用计数，便于确认挂钩生效
//
// 编译（x86，N0 阶段的正确目标）：
//   cl /nologo /W4 /O2 /DUNICODE /D_UNICODE toygame.cpp /Fe:toygame32.exe /link user32.lib gdi32.lib
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>   // _countof

#include "../common/layout_config.h"

// ── 日文文本：直接写 **Shift-JIS 字节** ─────────────────────────────────────
// 这样不依赖源文件编码，也不依赖编译器代码页 —— 目标程序里就是 CP932 字节，
// MultiByteToWideChar(CP932, ...) 一转就能出正确的日文。
// （若某些字节对不是合法日文，也只会解出别的假名，不影响验证目的。）
static const char* kLinesShiftJis[] = {
    // こんにちは、世界。
    "\x82\xB1\x82\xF1\x82\xC9\x82\xBF\x82\xCD\x81\x41\x90\xA2\x8A\x45\x81\x42",
    // ゲームを始めますか？
    //   注意首字是 83 51（ゲ），不是 83 65（テ）——
    //   这里原来写成了 0x8365，于是屏幕上一直显示着无意义的「テーム…」，
    //   而且因为字节和词表键对不上，这句**从来没被翻译过**。
    //   加自动化断言时才暴露（见 src/host/runtime/runtime-inject.test.ts 的阴性对照）。
    "\x83\x51\x81\x5B\x83\x80\x82\xF0\x8E\x6E\x82\xDF\x82\xDC\x82\xB7\x82\xA9\x81\x48",
    // はい / いいえ
    "\x82\xCD\x82\xA2 \x2F \x82\xA2\x82\xA2\x82\xA6",
    // セーブしました。
    "\x83\x5A\x81\x5B\x83\x75\x82\xB5\x82\xDC\x82\xB5\x82\xBD\x81\x42",
    // ★ 运行时专线：这一句**故意不放进 toymap.json**。
    //   如果静态词表把它也覆盖了，就永远走不到"向宿主取词"那条路，
    //   运行时那一半代码等于没被测到。往词表里加词时**别顺手把它加进去**。
    // ランタイム翻訳：この一文は静的な語彙表にありません。
    "\x83\x89\x83\x93\x83\x5E\x83\x43\x83\x80\x96\x7C\x96\xF3\x81\x46"
    "\x82\xB1\x82\xCC\x88\xEA\x95\xB6\x82\xCD\x90\xC3\x93\x49\x82\xC8"
    "\x8C\xEA\x9C\x62\x95\x5C\x82\xC9\x82\xA0\x82\xE8\x82\xDC\x82\xB9"
    "\x82\xF1\x81\x42",
};
static const int kLineCount = sizeof(kLinesShiftJis) / sizeof(kLinesShiftJis[0]);

// ── N2 演示文本：一段"3 倍长度"的中文，塞进固定宽度的对话框 ───────────────
//
// 三个刻意的设计（对应三条验收）：
//   ① 长度约是原来那些短句的 3 倍 → 不折行必然溢出（验收第 1 条）
//   ② 语句里混了「，」「。」「（」「）」等标点 → 用来验中文禁则（避头点/避尾点）
//   ③ **故意含「龘」** —— 这是一个日文传统字体（MS Gothic）**不含**的生僻汉字，
//      在原始字体下必然是豆腐块，必须靠"缺字兜底"才能显示（验收第 3 条）
static const wchar_t* kLongChinese =
    L"欢迎来到白的百宝箱（这是一个固定宽度的对话框）。"
    L"这里塞了一段大约是原来三倍长度的中文，用来验证自动折行、"
    L"字号自适应，以及生僻字「龘」的缺字兜底是否真的生效。"
    L"如果折行正确，这段文字应当整齐地排在这个框里、不溢出、不被裁掉；"
    L"如果字号自适应生效，即使字很大也会逐级缩小到刚好放得下。";

// 一个"日文原字体"里没有、但中文里存在的生僻字，单独显示一行做对照
static const wchar_t* kRareCharLine = L"缺字兜底对照：龘（日文字体通常没有这个字形）";

#define CODE_PAGE_SHIFT_JIS 932
#define ID_TOGGLE_BUTTON 1001

static HWND  g_hwnd        = nullptr;
static HWND  g_hButton     = nullptr;
static bool  g_useCache    = false;   // false = 原始模式（每帧转换）
static long  g_apiCalls    = 0;       // MultiByteToWideChar 调用计数
static long  g_drawCount   = 0;
static wchar_t g_cache[8][512];       // 缓存模式下的预转换结果

// 把 CP932 字节转成宽字符。返回转换出的字符数（含结尾 0）。
static int ToWide(const char* sjis, wchar_t* out, int outChars) {
    if (!sjis) return 0;
    int n = MultiByteToWideChar(CODE_PAGE_SHIFT_JIS, 0, sjis, -1, out, outChars);
    if (n <= 0) {
        // 转换失败也要能看出来，而不是画一片空白
        const wchar_t* fail = L"(CP932 转换失败)";
        int i = 0;
        while (fail[i] && i < outChars - 1) { out[i] = fail[i]; ++i; }
        out[i] = 0;
        return i + 1;
    }
    return n;
}

static void DrawDialog(HDC hdc);
static void PaintOffscreen();

static void UpdateTitle() {
    wchar_t title[256];
    if (!g_useCache) ++g_apiCalls;
    _snwprintf_s(title, _countof(title), _TRUNCATE,
        L"[玩具目标] 模式=%s  MultiByteToWideChar调用=%ld  重绘=%ld",
        g_useCache ? L"缓存(绕开hook)" : L"原始(每帧转换)",
        g_apiCalls, g_drawCount);
    SetWindowTextW(g_hwnd, title);
}

static void PaintAll(HDC hdc) {
    RECT rc;
    GetClientRect(g_hwnd, &rc);

    // 背景与文字颜色：深底浅字，方便看清字形
    HBRUSH bg = CreateSolidBrush(RGB(24, 26, 32));
    FillRect(hdc, &rc, bg);
    DeleteObject(bg);
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, RGB(235, 238, 245));

    // 字体：先给一个日文友好字体，验证 CJK 显示
    HFONT font = CreateFontW(-28, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE,
                             L"MS Gothic");
    HGDIOBJ oldFont = SelectObject(hdc, font);

    wchar_t wide[512];
    int y = 18;
    for (int i = 0; i < kLineCount; ++i) {
        const wchar_t* text;
        if (g_useCache) {
            text = g_cache[i];
        } else {
            // ★ 关键：每帧都真的调 MultiByteToWideChar —— hook 挂在这里
            ToWide(kLinesShiftJis[i], wide, _countof(wide));
            text = wide;
        }
        TextOutW(hdc, 30, y, text, (int)wcslen(text));
        y += 34;
    }

    SelectObject(hdc, oldFont);
    DeleteObject(font);

    // ── N2 演示区：固定宽度的"对话框" ──
    DrawDialog(hdc);
}

// ── N2 演示区：固定宽度的"对话框" ──────────────────────────────────────────
//
// ★ 这里刻意**只调一次 TextOutW**，把整段长中文原样丢给 GDI。
//   不折行、不算字号 —— 这就是"直接换字符串"的真实后果：文字会从框里伸出去。
//   正确排版由**被注入的 hook** 负责（它 hook 了 TextOutW，在里面重排这段文字），
//   所以玩具自己什么都不用做。这样"变整齐"就百分百是 hook 干的，可直接作验收证据。
static void DrawDialog(HDC hdc) {
    const int dx = bb::toylayout::kDialogX;
    const int dy = bb::toylayout::kDialogY;
    const int dw = bb::toylayout::kDialogW;
    const int dh = bb::toylayout::kDialogH;

    // 框体：深色底 + 亮边，一眼能看出"文字有没有跑出这个框"
    RECT box = {dx, dy, dx + dw, dy + dh};
    HBRUSH boxBg = CreateSolidBrush(RGB(16, 22, 34));
    FillRect(hdc, &box, boxBg);
    DeleteObject(boxBg);
    HPEN pen = CreatePen(PS_SOLID, 2, RGB(90, 150, 220));
    HGDIOBJ oldPen = SelectObject(hdc, pen);
    HGDIOBJ oldBrush = SelectObject(hdc, GetStockObject(NULL_BRUSH));
    Rectangle(hdc, dx, dy, dx + dw, dy + dh);
    SelectObject(hdc, oldPen);
    SelectObject(hdc, oldBrush);
    DeleteObject(pen);

    // 用**日文字体**：这是"游戏原字体"。它不含「龘」，
    // 于是缺字兜底有没有生效，看这一行就知道。
    HFONT boxFont = CreateFontW(bb::toylayout::kBaseFontHeight, 0, 0, 0, FW_NORMAL, FALSE,
                                FALSE, FALSE, DEFAULT_CHARSET, OUT_TT_PRECIS,
                                CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                DEFAULT_PITCH | FF_DONTCARE, BB_TOY_ORIGINAL_FACE);
    HGDIOBJ oldBoxFont = SelectObject(hdc, boxFont);
    SetTextColor(hdc, RGB(228, 236, 248));

    // ★ 只调一次，整段长文本原样交给 GDI（不折行、不降字号）
    const int tx = dx + bb::toylayout::kPadX;
    const int ty = dy + bb::toylayout::kPadY;
    TextOutW(hdc, tx, ty, kLongChinese, (int)wcslen(kLongChinese));

    SelectObject(hdc, oldBoxFont);
    DeleteObject(boxFont);

    // 「龘」对照行放在**框外下方**。
    // ⚠️ 为什么不能放进框里：排版 hook 用的是"一个共享的框宽"，
    //    它不知道哪次 TextOutW 属于哪个框。如果长文本和对照行都在框内，
    //    长文本折出的 7 行会跟对照行**叠在一起**（实测就是这样）。
    //    放到框外、给它独立的 y，两者就不会互相压。
    HFONT rareFont = CreateFontW(-18, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                 DEFAULT_CHARSET, OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS,
                                 CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE,
                                 BB_TOY_ORIGINAL_FACE);
    HGDIOBJ oldRare = SelectObject(hdc, rareFont);
    SetTextColor(hdc, RGB(255, 190, 120));
    TextOutW(hdc, dx, dy + dh + 10, kRareCharLine, (int)wcslen(kRareCharLine));
    SelectObject(hdc, oldRare);
    DeleteObject(rareFont);
}

// ── 离屏绘制 ───────────────────────────────────────────────────────────────
//
// ★ 为什么必须有这个（这是本轮实测踩出来的，不是"顺手加的功能"）：
//
//   排版的演示原本只发生在 `WM_PAINT` 里。而 **Windows 不会给"完全被遮住"
//   的窗口真正重绘** —— 窗口被别的窗口盖住时，我们收不到有效的 WM_PAINT，
//   于是 `TextOutW` 压根不会被调用，"排版 hook 接管"这件事在日志里就**看不见**。
//
//   真实表现：单跑 N2 验收通过；把它接进全量验收总入口（前面几套会拉起
//   控制台窗口盖住玩具窗口）后，注入完全成功、hook 也都装上了，
//   日志里却**一条排版记录都没有** —— 看起来像"排版功能没生效"，
//   其实是"窗口没被画"。这种"取决于窗口可见性"的测试是最难查的一类。
//
//   解决办法：定时器里**额外做一次离屏绘制**（画到内存 DC 上，画完就丢）。
//   于是不管窗口有没有被遮住、甚至最小化了，绘图调用都会稳定发生，
//   排版逻辑一定会被触发，日志也就稳定可断言。
//
//   顺带一提：侦察清单里要问引擎"有没有可用的**影子层/离屏绘制**
//   能力来自测字宽" —— 这里做的正是同一件事，只是玩具自己实现了它。
static void PaintOffscreen() {
    HDC screen = GetDC(nullptr);
    if (!screen) return;
    HDC mem = CreateCompatibleDC(screen);
    if (!mem) { ReleaseDC(nullptr, screen); return; }

    // 位图只要够装下对话框区域即可（我们只关心绘图调用发生，不看像素）
    HBITMAP bmp = CreateCompatibleBitmap(screen, bb::toylayout::kDialogW + 80,
                                         bb::toylayout::kDialogH + 60);
    HGDIOBJ oldBmp = bmp ? SelectObject(mem, bmp) : nullptr;

    SetBkMode(mem, TRANSPARENT);
    DrawDialog(mem);

    if (oldBmp) SelectObject(mem, oldBmp);
    if (bmp) DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_CREATE:
            g_hButton = CreateWindowW(L"BUTTON", L"切换 原始 / 缓存（对比 hook 是否生效）",
                WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                30, 400, 400, 34, hwnd, (HMENU)ID_TOGGLE_BUTTON,
                ((LPCREATESTRUCT)lp)->hInstance, nullptr);
            return 0;

        case WM_COMMAND:
            if (LOWORD(wp) == ID_TOGGLE_BUTTON) {
                g_useCache = !g_useCache;
                InvalidateRect(hwnd, nullptr, TRUE);
            }
            return 0;

        case WM_PAINT: {
            PAINTSTRUCT ps;
            HDC hdc = BeginPaint(hwnd, &ps);
            ++g_drawCount;
            PaintAll(hdc);
            EndPaint(hwnd, &ps);
            UpdateTitle();
            return 0;
        }

        case WM_TIMER:
            // 用定时器持续重绘：注入后能立刻看到文字变化（否则要点一下才刷新）
            InvalidateRect(hwnd, nullptr, FALSE);
            // ★ 再离屏画一遍 —— 保证排版逻辑**一定会**被触发，
            //   不受"窗口有没有被遮住"影响（见 PaintOffscreen 的说明）
            PaintOffscreen();
            return 0;

        case WM_ERASEBKGND:
            return 1; // 在 WM_PAINT 里自己填背景，避免闪烁

        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

// ============================================================================
// 启动自述 —— 把"从外面看不到、但验收必须确认"的运行时事实落盘。
//
// 为什么玩具程序要自己写这份文件：
//   · needEnglishPath（ASCII 工作目录）是**注入器的行为**，但**只有目标进程
//     自己**知道它最终的当前目录是什么。注入器只能说"我让它以哪个目录启动"，
//     说不了"它实际跑在哪个目录"。验收要求"玩具程序打印的当前目录必须是纯
//     ASCII"，这个证据只能由目标进程自己产出。
//   · 顺带记录进程位数、exe 路径、命令行 —— 位数不匹配这类问题一眼可查。
//   · 环境变量也记几条：envAppend 的功能同样只能从目标进程内部验证。
//
// 写到 exe 同目录的 toy_selfreport.txt（纯 UTF-8，每次启动覆盖）。
// ============================================================================
static void WriteSelfReport() {
    wchar_t exePath[MAX_PATH] = {0};
    GetModuleFileNameW(nullptr, exePath, _countof(exePath));
    wchar_t cwd[MAX_PATH] = {0};
    GetCurrentDirectoryW(_countof(cwd), cwd);

    // 目录里有没有非 ASCII 字符？这是 needEnglishPath 验收的判据。
    bool cwdIsAscii = true;
    for (const wchar_t* p = cwd; *p; ++p) {
        if (*p > 0x7F) { cwdIsAscii = false; break; }
    }

    wchar_t reportPath[MAX_PATH];
    _snwprintf_s(reportPath, _countof(reportPath), _TRUNCATE, L"%ls.selfreport.txt", exePath);

    FILE* f = nullptr;
    if (_wfopen_s(&f, reportPath, L"wb") != 0 || !f) return;

    // ⚠️ 窄格式化（_snprintf_s）配 `%ls` 在 MSVC 上会崩（0xC0000409，
    //    本项目在 log.h 里踩过同一个坑）。所以这里：
    //      · 先用**宽**格式化函数把所有内容组成宽串
    //      · 再手工 WideCharToMultiByte 转 UTF-8
    //      · 最后二进制 fwrite 落盘
    //    全程不碰 CRT 的编码转换，稳。
    wchar_t wbuf[2048];
    _snwprintf_s(wbuf, _countof(wbuf), _TRUNCATE,
        L"=== 玩具目标 启动自述 ===\r\n"
        L"exe 路径        : %ls\r\n"
        L"当前目录        : %ls\r\n"
        L"当前目录纯ASCII : %ls\r\n"
        L"位数            : %d\r\n"
        L"命令行          : %ls\r\n"
        L"BB_TEST_ENV     : %ls\r\n"
        L"ANSI 代码页     : %d\r\n",
        exePath, cwd, cwdIsAscii ? L"是" : L"否",
        static_cast<int>(sizeof(void*) * 8),
        GetCommandLineW(),
        GetEnvironmentVariableW(L"BB_TEST_ENV", nullptr, 0) ? L"(已设置)" : L"(未设置)",
        GetACP());

    char utf8[4096];
    const int bytes = WideCharToMultiByte(CP_UTF8, 0, wbuf, -1, utf8, sizeof(utf8) - 1,
                                          "?", nullptr);
    if (bytes > 1) fwrite(utf8, 1, static_cast<size_t>(bytes - 1), f);
    fclose(f);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, LPWSTR, int) {
    // 先把启动自述写出来 —— 这样"当前目录是不是纯 ASCII"这类事实
    // 在注入器/验收脚本那侧就能读到，不依赖肉眼看窗口。
    WriteSelfReport();

    // 启动时先把缓存模式的文本转好（**在 hook 装上来之前**，
    // 所以缓存模式永远显示日文原文 —— 正好用来做 A/B 对照）
    for (int i = 0; i < kLineCount; ++i) {
        ToWide(kLinesShiftJis[i], g_cache[i], _countof(g_cache[i]));
    }

    WNDCLASSW wc = {};
    wc.lpfnWndProc   = WndProc;
    wc.hInstance     = hInst;
    wc.lpszClassName = L"BaibaoToyGameWnd";
    wc.hCursor       = LoadCursor(nullptr, IDC_ARROW);
    RegisterClassW(&wc);

    g_hwnd = CreateWindowW(wc.lpszClassName, L"[玩具目标] 启动中…",
        WS_OVERLAPPEDWINDOW & ~WS_MAXIMIZEBOX & ~WS_THICKFRAME,
        CW_USEDEFAULT, CW_USEDEFAULT, 470, 490,
        nullptr, nullptr, hInst, nullptr);
    if (!g_hwnd) return 1;

    ShowWindow(g_hwnd, SW_SHOW);
    // 每 200ms 重绘一次，注入后文字变化能立刻反映出来
    SetTimer(g_hwnd, 1, 200, nullptr);
    UpdateTitle();

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}
