// ============================================================================
// 玩具编码层 hook（N0 第二步）
//
// 挂 MultiByteToWideChar / WideCharToMultiByte —— 这是**最通用**的拦截点：
//   "数据层……适合：数据驱动、编码固定的引擎。最稳、最不依赖引擎内部结构。"
//
// 为什么从编码层起步：这一步验证的是"**能不能做**"——
// 如果不装引擎内部知识、只靠换编码就能把文本换掉，那后面所有引擎都有兜底方案。
//
// ⚠️⚠️ 本文件最关键的地方：**缓冲区长度语义** ⚠️⚠️
//   MultiByteToWideChar 的返回值是"**需要多少个宽字符**"（含结尾 0，当 cbMultiByte=-1）。
//   译文比原文长时，如果我们在"查询长度"的调用里返回**原文**的长度，
//   调用方就会按原文长度分配缓冲，我们往里写更长的译文 → **堆溢出 / 崩溃**。
//   这是这类工具最常见的崩溃原因，所以下面把它单独标出来、逐种情况处理。
//
// 导出：Install() / Uninstall()，支持干净卸载（工程铁律）。
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <unordered_map>
#include <vector>
#include <cstring>

#include "MinHook.h"
#include "../../common/log.h"
#include "../../common/json.h"
#include "../../common/hook.h"
#include "../../common/wsclient.h"

// ── N2 排版回填：度量 / 折行 / 字号自适应 / 字体替换 ──
#include "layout_hook.h"
#include "../../common/layout_config.h"
#include "../../common/measure.h"
#include "../../common/wrap.h"
#include "../../common/fontmap.h"

// ── 原始函数 ─────────────────────────────────────────────────
typedef int (WINAPI *PFN_MultiByteToWideChar)(UINT, DWORD, LPCCH, int, LPWSTR, int);
typedef int (WINAPI *PFN_WideCharToMultiByte)(UINT, DWORD, LPCWCH, int, LPSTR, int, LPCCH, LPBOOL);

// ── N2（排版回填）新增的被 hook 目标 ─────────────────────────
// TextOutW      ：文本绘制处 —— 折行/字号自适应/缺字兜底都在这里做
// CreateFontIndirectW/A ：字体创建处 —— 手段②「按配置换字体族名」
typedef BOOL  (WINAPI *PFN_TextOutW)(HDC, int, int, LPCWSTR, int);
typedef HFONT (WINAPI *PFN_CreateFontIndirectW)(const LOGFONTW*);
typedef HFONT (WINAPI *PFN_CreateFontIndirectA)(const LOGFONTA*);

static PFN_MultiByteToWideChar RealMB2WC = nullptr;
static PFN_WideCharToMultiByte RealWC2MB = nullptr;
static PFN_TextOutW           RealTextOutW = nullptr;
static PFN_CreateFontIndirectW RealCreateFontIndirectW = nullptr;
static PFN_CreateFontIndirectA RealCreateFontIndirectA = nullptr;

// 排版引擎（折行 + 字号自适应 + 缺字兜底），逻辑在 layout_hook.h
static bb::LayoutHook g_layout;

// 手段②的开关：默认**关**。
//   为什么默认关：它会把进程内**所有**字体创建都改成中文字体，
//   属于"比较激进"的改动。真正该由用户的配置（fixFontName + 开关）决定，
//   而不是我们偷偷替所有人做主。
//   关掉时，「龘」这类缺字仍然会被**手段③（绘制时按需兜底）**救回来 ——
//   两种手段各司其职，默认只启用影响面小的那个。
static volatile LONG g_fixFontOnCreate = 0;

// ★ 重入保护：我们自己的排版代码也会 CreateFontW，
//   如果那时手段②开着，会把我们精心选好的兜底字体又改掉。
//   用一个线程局部深度计数，让"我们自己发起的字体创建"直接放行。
static __declspec(thread) int g_inOwnDraw = 0;

// ── 词表 ─────────────────────────────────────────────────────
// key = 原文（CP932 字节串，不含结尾 0）；value = 译文（宽字符）
// **装好 hook 之后就不再改动** → 读路径无需加锁（热路径要求零分配/无锁）
static std::unordered_map<std::string, std::wstring> g_forward;   // 原文 → 译文
static std::unordered_map<std::wstring, std::string> g_reverse;   // 译文 → 原文
static bool g_built = false;

static UINT g_targetCodePage = 932;   // 只拦这个代码页，其它（UTF-8 等）一律放行
static HMODULE g_selfModule = nullptr;
static std::string g_identityJson;
static bb::WsClient g_ws;
static HANDLE g_wsThread = nullptr;
static volatile LONG g_stopWs = 0;

// ── UTF-8 ↔ 宽 ↔ CP932 小工具 ────────────────────────────────
static std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (n <= 0) return L"";
    std::wstring w(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

static std::string WideToSjis(const std::wstring& w) {
    if (w.empty()) return "";
    // 注意：这里**故意用真实 API**（此刻 hook 还没装，不会递归）
    int n = WideCharToMultiByte(g_targetCodePage, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    if (n <= 0) return "";
    std::string s(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(g_targetCodePage, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

static std::string WideToUtf8(const std::wstring& w) {
    if (w.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    if (n <= 0) return "";
    std::string s(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

/** 取 DLL 自身所在目录 */
static std::wstring SelfDir() {
    wchar_t path[MAX_PATH] = {0};
    GetModuleFileNameW(g_selfModule, path, MAX_PATH);
    std::wstring p(path);
    size_t pos = p.find_last_of(L"\\/");
    return pos == std::wstring::npos ? L"." : p.substr(0, pos);
}

/** 读词表文件（先找 <dll目录>\toymap.json，再找 <dll目录>\data\toymap.json） */
static bool LoadMapFromFile(std::string* sourceUsed) {
    std::vector<std::wstring> candidates = {
        SelfDir() + L"\\toymap.json",
        SelfDir() + L"\\data\\toymap.json",
    };
    for (const auto& path : candidates) {
        HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) continue;

        DWORD size = GetFileSize(h, nullptr);
        std::string buf;
        buf.resize(size);
        DWORD read = 0;
        ReadFile(h, &buf[0], size, &read, nullptr);
        CloseHandle(h);
        buf.resize(read);

        bb::json::Value root;
        if (!bb::json::parseOk(buf, &root) || !root.isObject()) {
            BB_WARN(L"词表 %s 不是合法 JSON 对象，跳过", path.c_str());
            continue;
        }
        for (const auto& kv : *root.obj) {
            // 文件里是 UTF-8；原文要转成 CP932 字节，才能和 hook 里看到的一致
            std::string key = WideToSjis(Utf8ToWide(kv.first));
            std::wstring val = Utf8ToWide(kv.second.asString());
            if (key.empty() || val.empty()) continue;
            g_forward[key] = val;
            g_reverse[val] = key;
        }
        if (sourceUsed) *sourceUsed = WideToUtf8(path);
        BB_LOG(L"词表已载入: %u 条，来自 %s", static_cast<unsigned>(g_forward.size()), path.c_str());
        return true;
    }
    BB_WARN(L"没找到词表文件（toymap.json）");
    return false;
}

// ── ★★★ 长度语义：把这两个函数写对，工具才不会崩 ★★★ ────────────

/**
 * 判断调用方要的是"查询所需长度"还是"真的写入"。
 * Win32 约定：cchWideChar == 0 表示**只查询长度**，此时不得写入任何字节。
 */
static int HijackResult(const std::wstring& translated, bool nullTerminated,
                        LPWSTR dst, int cchWide) {
    // 需要多少个宽字符。
    //  · nullTerminated（调用方传 cbMultiByte = -1，源串自带结尾 0）：要连结尾 0 一起算
    //  · 否则：只要正文字符数
    const int need = static_cast<int>(translated.size()) + (nullTerminated ? 1 : 0);

    // 情况 1：**只查询长度**（cchWideChar == 0）→ 必须返回【译文】所需长度
    //   这是最容易写错的地方：若此处返回原文长度，调用方会按原文长度分配缓冲，
    //   随后我们写入更长的译文 → 堆破坏。宁可按约定返回 0 让调用方自己处理，
    //   也绝不能在长度查询里说谎。
    if (cchWide == 0) return need;

    // 情况 2：缓冲区不够 → 按 Win32 约定返回 0 并置 ERROR_INSUFFICIENT_BUFFER。
    //   **不要截断硬写**：截断会产生半截乱码，还可能导致调用方按"成功"继续处理。
    if (dst == nullptr || cchWide < need) {
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return 0;
    }

    // 情况 3：正常写入。拷贝译文，并在需要时补结尾 0。
    if (translated.size() > 0) {
        std::memcpy(dst, translated.data(), translated.size() * sizeof(wchar_t));
    }
    if (nullTerminated) dst[translated.size()] = L'\0';
    return need;
}

// ── Hook：MultiByteToWideChar（游戏把 CP932 字节转成宽字符 → 我们换成中文）──
static int WINAPI HookMB2WC(UINT cp, DWORD flags, LPCCH src, int cbMulti,
                            LPWSTR dst, int cchWide) {
    // 只处理目标代码页；其它编码（UTF-8/UTF-16 等）**原样放行**，避免误伤
    if (cp != g_targetCodePage || src == nullptr || !g_built) {
        return RealMB2WC(cp, flags, src, cbMulti, dst, cchWide);
    }

    const bool nullTerminated = (cbMulti == -1);

    // 1) 先把"原文"按原样转出来，用于查表。
    //    这里用**真实函数**，不会递归进 hook。
    int needOriginal = RealMB2WC(cp, flags, src, cbMulti, nullptr, 0);
    if (needOriginal <= 0) return RealMB2WC(cp, flags, src, cbMulti, dst, cchWide);

    std::wstring original(static_cast<size_t>(needOriginal), L'\0');
    RealMB2WC(cp, flags, src, cbMulti, &original[0], needOriginal);

    // 2) 查表：按 CP932 字节串匹配（截掉结尾 0，和词表的 key 对齐）
    std::string key(reinterpret_cast<const char*>(src),
                    nullTerminated ? std::strlen(reinterpret_cast<const char*>(src))
                                   : static_cast<size_t>(cbMulti));
    auto it = g_forward.find(key);
    if (it == g_forward.end()) {
        return RealMB2WC(cp, flags, src, cbMulti, dst, cchWide);  // 没命中，原样
    }

    // 3) 命中 → 返回译文（长度语义见 HijackResult 的注释）
    return HijackResult(it->second, nullTerminated, dst, cchWide);
}

// ── Hook：WideCharToMultiByte（反向：程序要把中文写回时，还原成 CP932）──
static int WINAPI HookWC2MB(UINT cp, DWORD flags, LPCWCH src, int cchWide,
                            LPSTR dst, int cbMulti, LPCCH defChar, LPBOOL usedDef) {
    if (cp != g_targetCodePage || src == nullptr || !g_built) {
        return RealWC2MB(cp, flags, src, cchWide, dst, cbMulti, defChar, usedDef);
    }

    const bool nullTerminated = (cchWide == -1);
    std::wstring key(src, nullTerminated ? std::wcslen(src) : static_cast<size_t>(cchWide));

    auto it = g_reverse.find(key);
    if (it == g_reverse.end()) {
        return RealWC2MB(cp, flags, src, cchWide, dst, cbMulti, defChar, usedDef);
    }

    const std::string& original = it->second;
    const int need = static_cast<int>(original.size()) + (nullTerminated ? 1 : 0);

    if (cbMulti == 0) return need;                      // 只查询长度
    if (dst == nullptr || cbMulti < need) {             // 缓冲不够：如实报错，不截断
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return 0;
    }
    std::memcpy(dst, original.data(), original.size());
    if (nullTerminated) dst[original.size()] = '\0';
    return need;
}

// ── N2：绘制时的排版（折行 + 字号自适应 + 缺字兜底）──────────
//
// ★ 这个 detour 里**绝对不能再调 `TextOutW`**。
//   我们要画多行，如果调的是被 hook 的 TextOutW，就会递归进自己：
//   每层都重新折行、重新降字号，一路递归到栈溢出。
//   所以画行时统一走 `RealTextOutW`（原始函数指针）。
static BOOL WINAPI HookTextOutW(HDC hdc, int x, int y, LPCWSTR text, int len) {
    if (!RealTextOutW) return FALSE;
    if (!text || len == 0) return RealTextOutW(hdc, x, y, text, len);

    // 已经在处理自己的绘制就直通，避免嵌套
    if (g_inOwnDraw == 0) {
        ++g_inOwnDraw;
        const bool handled = g_layout.TryLayoutAndDraw(
            hdc, x, y, text, len,
            [](HDC h, int lx, int ly, const wchar_t* s, int n) {
                RealTextOutW(h, lx, ly, s, n);   // ★ 必须是原始函数
            },
            nullptr);
        --g_inOwnDraw;

        if (handled) {
            // 注意：**不要**在这里再打一次 LAYOUT 行。
            // TryLayoutAndDraw 内部已经节流地打过日志了；在这里无条件再打一次，
            // 会让节流完全失效（实测：每帧多出一行重复记录，2.5 秒 26 行）。
            return TRUE;
        }
    }
    return RealTextOutW(hdc, x, y, text, len);
}

// ── N2：手段②「按配置换字体族名」──────────────────────────────
//
// 在 `CreateFontIndirectW/A` 处把字体族名换掉。
// 默认关闭（见 g_fixFontOnCreate 的说明），由配置/外部命令开启。
static HFONT WINAPI HookCreateFontIndirectW(const LOGFONTW* lplf) {
    if (!RealCreateFontIndirectW || !lplf) return RealCreateFontIndirectW(lplf);
    // 我们自己排版时创建的字体不要被改（否则精心选的兜底字体又被覆盖）
    if (!g_fixFontOnCreate || g_inOwnDraw > 0) return RealCreateFontIndirectW(lplf);

    LOGFONTW lf = *lplf;
    wcsncpy_s(lf.lfFaceName, L"黑体", _TRUNCATE);
    // ★ 字符集也要改：原来是 SHIFTJIS_CHARSET 时，
    //   拿它去建中文字体会让 GDI 到日文字体里找中文字形，多半找不到
    lf.lfCharSet = DEFAULT_CHARSET;
    BB_LOG(L"[字体] CreateFontIndirectW 族名 %s → 黑体（手段② 按配置替换）", lplf->lfFaceName);
    return RealCreateFontIndirectW(&lf);
}

static HFONT WINAPI HookCreateFontIndirectA(const LOGFONTA* lplf) {
    if (!RealCreateFontIndirectA || !lplf) return RealCreateFontIndirectA(lplf);
    if (!g_fixFontOnCreate || g_inOwnDraw > 0) return RealCreateFontIndirectA(lplf);

    LOGFONTA lf = *lplf;
    // ANSI 版只能用当前 ANSI 代码页能表示的族名 —— "SimHei" 在 936/1252 下都安全
    strncpy_s(lf.lfFaceName, "SimHei", _TRUNCATE);
    lf.lfCharSet = DEFAULT_CHARSET;
    BB_LOG(L"[字体] CreateFontIndirectA 族名 %s → SimHei（手段② 按配置替换）", lplf->lfFaceName);
    return RealCreateFontIndirectA(&lf);
}

// ── 与宿主通信（后台线程，绝不阻塞游戏主线程）────────────────
static void SendJson(const bb::json::Value& v) {
    if (g_ws.isOpen()) g_ws.sendText(bb::json::dump(v));
}

/** 把词表里每一对 <原文, 译文> 上报给宿主（供工作台显示） */
static void ReportPairs() {
    bb::json::Array pairs;
    for (const auto& kv : g_forward) {
        bb::json::Value pair(bb::json::Object{});
        pair.set("src", bb::json::Value(WideToUtf8(Utf8ToWide(kv.first))));
        pair.set("dst", bb::json::Value(WideToUtf8(kv.second)));
        pairs.emplace_back(std::move(pair));
    }
    bb::json::Value msg(bb::json::Object{});
    msg.set("id", bb::json::Value(2.0));
    msg.set("type", bb::json::Value(0.0));
    msg.set("target", bb::json::Value(0.0));
    msg.set("cmd", bb::json::Value(std::string("reportPairs")));
    msg.set("args", bb::json::Value(std::move(pairs)));
    SendJson(msg);
    BB_LOG(L"已上报 %u 对词条给宿主", static_cast<unsigned>(g_forward.size()));
}

static DWORD WINAPI WsThreadProc(LPVOID) {
    if (!g_ws.connectTo("127.0.0.1", 17872, "baibao-native/1.0")) {
        BB_WARN(L"连不上宿主总线，本进程将只在本地查词（不影响游戏运行）");
        return 0;
    }

    std::string text;
    bool reported = false;
    while (!g_stopWs) {
        if (!g_ws.recvText(text, 5000)) {
            if (g_stopWs) break;
            BB_WARN(L"总线读失败，退出通信线程");
            break;
        }
        bb::json::Value msg;
        if (!bb::json::parseOk(text, &msg)) continue;

        // 握手：宿主问 "whoareyou" → 我们用**同一个 id** 发一个 whoareyou 请求回去，
        // args 里带身份（exe 路径 + PID + 模块名）
        if (msg.getString("cmd") == "whoareyou") {
            bb::json::Value reply(bb::json::Object{});
            reply.set("id", bb::json::Value(msg.getNumber("id", 0)));
            reply.set("type", bb::json::Value(0.0));
            reply.set("target", bb::json::Value(0.0));
            reply.set("cmd", bb::json::Value(std::string("whoareyou")));
            bb::json::Value ident;
            if (!bb::json::parseOk(g_identityJson, &ident)) ident = bb::json::Value(bb::json::Object{});
            reply.set("args", std::move(ident));
            SendJson(reply);
            BB_LOG(L"已应答 whoareyou，身份: %S", g_identityJson.c_str());
            if (!reported) {
                ReportPairs();
                reported = true;
            }
            continue;
        }
        // 宿主下发的其它命令（改词表等）留待后续里程碑
    }
    return 0;
}

// ── 导出 ─────────────────────────────────────────────────────
extern "C" __declspec(dllexport) BOOL WINAPI Install(HMODULE selfModule) {
    g_selfModule = selfModule;

    std::wstring logPath = SelfDir() + L"\\toyHook.log";
    bb::Log::open(logPath);

    // 身份信息：宿主靠它知道"这是哪个进程、哪个 hook"
    {
        wchar_t exePath[MAX_PATH] = {0};
        GetModuleFileNameW(nullptr, exePath, MAX_PATH);
        std::string exeUtf8 = WideToUtf8(exePath);
        char buf[1024];
        std::snprintf(buf, sizeof(buf),
            "{\"exePath\":\"%s\",\"pid\":%lu,\"module\":\"toyHook\",\"engine\":\"toy\",\"arch\":%d}",
            exeUtf8.c_str(), GetCurrentProcessId(), static_cast<int>(sizeof(void*) * 8));
        g_identityJson = buf;
    }

    BB_LOG(L"===== Install 开始 =====");
    BB_LOG(L"自身模块: %p  目标代码页: %u", selfModule, g_targetCodePage);

    // ★ 顺序很重要：**先把词表建好再装 hook** ——
    //   这样钩子生效后读的是不可变数据，热路径无需加锁。
    std::string mapSource;
    LoadMapFromFile(&mapSource);
    g_built = true;

    if (!bb::HookEngine::install()) return FALSE;

    HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
    RealMB2WC = reinterpret_cast<PFN_MultiByteToWideChar>(
        GetProcAddress(kernel32, "MultiByteToWideChar"));
    RealWC2MB = reinterpret_cast<PFN_WideCharToMultiByte>(
        GetProcAddress(kernel32, "WideCharToMultiByte"));

    if (!bb::HookEngine::attach("MultiByteToWideChar",
            reinterpret_cast<LPVOID>(RealMB2WC),
            reinterpret_cast<LPVOID>(HookMB2WC),
            reinterpret_cast<LPVOID*>(&RealMB2WC))) {
        BB_ERR(L"挂 MultiByteToWideChar 失败");
        return FALSE;
    }
    // 反向 hook 失败不致命（正向才是关键路径），但要记下来
    PFN_WideCharToMultiByte realWC2MB = RealWC2MB;
    if (!bb::HookEngine::attach("WideCharToMultiByte",
            reinterpret_cast<LPVOID>(RealWC2MB),
            reinterpret_cast<LPVOID>(HookWC2MB),
            reinterpret_cast<LPVOID*>(&RealWC2MB))) {
        BB_WARN(L"挂 WideCharToMultiByte 失败（不影响正向替换）");
        RealWC2MB = realWC2MB;
    }

    // ── N2：排版相关的 hook ──
    //   失败**不致命**：没有排版照样能跑（只是文本可能溢出/缺字），
    //   而编码替换是核心功能，不能因为排版 hook 失败就整体失败。
    {
        HMODULE gdi32 = GetModuleHandleW(L"gdi32.dll");
        if (gdi32) {
            RealTextOutW = reinterpret_cast<PFN_TextOutW>(
                GetProcAddress(gdi32, "TextOutW"));
            if (RealTextOutW && !bb::HookEngine::attach("TextOutW",
                    reinterpret_cast<LPVOID>(RealTextOutW),
                    reinterpret_cast<LPVOID>(HookTextOutW),
                    reinterpret_cast<LPVOID*>(&RealTextOutW))) {
                BB_WARN(L"挂 TextOutW 失败（排版回填不会生效，其它功能不受影响）");
            } else if (RealTextOutW) {
                BB_LOG(L"hook [TextOutW] 已装（排版回填：折行/字号自适应/缺字兜底）");
            }

            RealCreateFontIndirectW = reinterpret_cast<PFN_CreateFontIndirectW>(
                GetProcAddress(gdi32, "CreateFontIndirectW"));
            if (RealCreateFontIndirectW) {
                PFN_CreateFontIndirectW real = RealCreateFontIndirectW;
                if (!bb::HookEngine::attach("CreateFontIndirectW",
                        reinterpret_cast<LPVOID>(RealCreateFontIndirectW),
                        reinterpret_cast<LPVOID>(HookCreateFontIndirectW),
                        reinterpret_cast<LPVOID*>(&RealCreateFontIndirectW))) {
                    BB_WARN(L"挂 CreateFontIndirectW 失败（手段② 不可用）");
                    RealCreateFontIndirectW = real;
                } else {
                    BB_LOG(L"hook [CreateFontIndirectW] 已装（手段②：按配置换字体族名，当前%s）",
                           g_fixFontOnCreate ? L"开启" : L"关闭");
                }
            }

            RealCreateFontIndirectA = reinterpret_cast<PFN_CreateFontIndirectA>(
                GetProcAddress(gdi32, "CreateFontIndirectA"));
            if (RealCreateFontIndirectA) {
                PFN_CreateFontIndirectA real = RealCreateFontIndirectA;
                if (!bb::HookEngine::attach("CreateFontIndirectA",
                        reinterpret_cast<LPVOID>(RealCreateFontIndirectA),
                        reinterpret_cast<LPVOID>(HookCreateFontIndirectA),
                        reinterpret_cast<LPVOID*>(&RealCreateFontIndirectA))) {
                    BB_WARN(L"挂 CreateFontIndirectA 失败（手段② 的 ANSI 分支不可用）");
                    RealCreateFontIndirectA = real;
                } else {
                    BB_LOG(L"hook [CreateFontIndirectA] 已装");
                }
            }
        }
    }

    // 通信线程：与游戏主线程完全分离
    g_stopWs = 0;
    g_wsThread = CreateThread(nullptr, 0, WsThreadProc, nullptr, 0, nullptr);

    // 排版配置：把对话框几何与最终采用的字体报一次，便于日志侧对照
    BB_LOG(L"排版配置：对话框 %dx%d（内宽 %d），基准字体 %s %dpx，fixFontName=%s fallback=%s",
           bb::toylayout::kDialogW, bb::toylayout::kDialogH, bb::toylayout::InnerWidth(),
           BB_TOY_ORIGINAL_FACE, -bb::toylayout::kBaseFontHeight, L"黑体", L"宋体");

    BB_LOG(L"===== Install 完成 =====");
    return TRUE;
}

// ============================================================================
// 对外命令（宿主/注入器可以通过 --call 远程调用这些导出）
// ============================================================================

/**
 * 手段② 开关：是否在"创建字体"处就把族名换掉。
 *
 * 为什么做成可远程开关，而不是写死在配置里：
 *   它影响面大（进程内所有字体创建），需要能在**不重启游戏**的前提下
 *   打开/关掉做 A/B 对比。所以给一个运行时可切的入口。
 */
extern "C" __declspec(dllexport) BOOL WINAPI SetFixFontOnCreate(BOOL on) {
    InterlockedExchange(&g_fixFontOnCreate, on ? 1 : 0);
    BB_LOG(L"[字体] 手段②（CreateFontIndirect 换族名）已%s", on ? L"开启" : L"关闭");
    return TRUE;
}

/**
 * ★ 「全部还原」（验收第 4 条）
 *
 * 把字体与字号都恢复到原始状态。具体做三件事：
 *   ① 关掉手段②（不再拦截字体创建）
 *   ② 关掉绘制时的排版接管（不再改字号、不再换字体）
 *      —— 于是画出来的就是**游戏原本的字体与字号**
 *   ③ 清掉统计，便于下一轮验收重新计数
 *
 * 注意：这里**不**卸载 hook 本身。还原的是"我们对字体和版面做过的事"，
 * 不是"我们存在过"。彻底移除是 `Uninstall()` 的职责 —— 两者语义不同，
 * 混在一起会导致"还原后连接也断了、日志也没了"，反而不好验证。
 */
extern "C" __declspec(dllexport) BOOL WINAPI RestoreAll() {
    BB_LOG(L"===== RestoreAll 开始（全部还原：字体 + 字号）=====");

    InterlockedExchange(&g_fixFontOnCreate, 0);

    bb::LayoutHook::Options o = g_layout.GetOptions();
    o.enabled = false;          // 关键：不再接管绘制 → 字体与字号回到游戏原样
    g_layout.SetOptions(o);
    g_layout.Restore();

    BB_LOG(L"[还原] 手段② 已关；绘制接管已关；"
           L"此后文本按游戏原始字体与原始字号绘制");
    BB_LOG(L"RESTOREALL ok=1 fontOverride=0 layoutDisabled=1 fixFontOnCreate=0");
    BB_LOG(L"===== RestoreAll 完成 =====");
    return TRUE;
}

/** 重新打开排版接管（还原之后想再开回来时用；A/B 对比很方便） */
extern "C" __declspec(dllexport) BOOL WINAPI EnableLayout(BOOL on) {
    bb::LayoutHook::Options o = g_layout.GetOptions();
    o.enabled = (on != 0);
    g_layout.SetOptions(o);
    BB_LOG(L"[排版] 接管已%s", on ? L"开启" : L"关闭");
    return TRUE;
}

extern "C" __declspec(dllexport) BOOL WINAPI Uninstall() {
    BB_LOG(L"===== Uninstall 开始 =====");

    g_stopWs = 1;
    if (g_wsThread) {
        WaitForSingleObject(g_wsThread, 3000);
        CloseHandle(g_wsThread);
        g_wsThread = nullptr;
    }
    g_ws.close();

    // 工程铁律：内存补丁必须原样还原
    bb::HookEngine::uninstallAll();

    // 排版相关状态一并清掉：原始函数指针置空，
    // 免得卸载后还有残留路径指到已经拆掉的 detour
    RealTextOutW = nullptr;
    RealCreateFontIndirectW = nullptr;
    RealCreateFontIndirectA = nullptr;
    InterlockedExchange(&g_fixFontOnCreate, 0);
    bb::LayoutHook::Options o = g_layout.GetOptions();
    o.enabled = true;
    g_layout.SetOptions(o);
    // 把 GDI 字体缓存里的句柄释放掉（进程可能被反复注入/卸载）
    bb::GdiFontCache::Instance().Clear();

    g_built = false;
    g_forward.clear();
    g_reverse.clear();

    BB_LOG(L"===== Uninstall 完成（已恢复原状）=====");
    bb::Log::close();
    return TRUE;
}

BOOL WINAPI DllMain(HINSTANCE hInst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_selfModule = hInst;
        DisableThreadLibraryCalls(hInst);
        // 注意：**不在 DllMain 里做重活**（LoadLibrary 死锁风险）。
        // 注入器在进程恢复执行后会显式调用 Install()。
    }
    return TRUE;
}
