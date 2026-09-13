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
#include <cstdlib>

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

/**
 * 是否已完成握手（应答过宿主的 whoareyou）。
 *
 * ★ 在这之前**不要主动发任何东西**：对方还不知道我们是谁，
 *   我们的报文会被当成协议违约直接断连（实测踩到过，而且现象是
 *   "刚连上就断开"，从日志里很难看出是自己抢跑造成的）。
 */
static volatile LONG g_wsIdentified = 0;

// ── 运行时取词（宿主翻译）──────────────────────────────────────
//
// 静态词表（toymap.json）是"离线先备好"的那半边；这里补上**运行时**那半边：
// 词表里没有的原文，向宿主要译文，拿到后下一帧就渲染成中文。
//
// ★ 三条硬约束（都是这类工具翻车的常见地方）：
//   ① 游戏线程**绝不等待网络**：未命中就登记一句、本帧原样放行。
//      把"等宿主回话"放进被 hook 的 API 里，游戏立刻卡成幻灯片。
//   ② 同一句**只问一次**（负缓存）：否则每帧都问一遍，宿主被刷爆。
//   ③ 宿主不在就**自己停下来**：连不上就是连不上，不能反复重试拖慢游戏。
static SRWLOCK g_rtLock = SRWLOCK_INIT;
static std::unordered_map<std::string, std::wstring> g_rtTrans;  // UTF-8 原文 → 译文（宽字符）
static std::unordered_map<std::string, int> g_rtAsked;           // 已问过（含宿主答"没有"）
static std::unordered_map<std::string, int> g_rtApplied;         // 已回填并打过日志的
static std::vector<std::string> g_rtQueue;                       // 待请求（UTF-8 原文）
static HANDLE g_rtThread = nullptr;
static HANDLE g_rtReplyEvent = nullptr;
static std::string g_rtReplyPayload;                             // 收到的最新一条应答原文
static volatile LONG g_stopRt = 0;
static volatile LONG g_rtRun = 1;          // 0 = 已放弃（宿主不可用/连续失败）
static volatile LONG g_rtFailStreak = 0;
static volatile LONG g_rtWaitId = 0;
/**
 * 我们自己发出的请求 id（whoareyou 的应答要沿用宿主给的 id，不走这里）。
 *
 * 用统一的发号器，取词批次之间就不会撞 id；接收侧也才能干净地判断
 * "这条应答是不是我在等的那批" —— 否则只能靠"没有 cmd"来猜，
 * 会把 handshake / reportPairs 的应答也当成取词应答（实测刷了一堆假警告）。
 */
static volatile LONG g_nextReqId = 10;
static LONG NextReqId() { return InterlockedIncrement(&g_nextReqId); }
static volatile LONG g_rtReqCount = 0, g_rtGotCount = 0, g_rtNoneCount = 0, g_rtApplyCount = 0;

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

/**
 * 宿主总线的端口 —— 从 **hook DLL 同目录**下的 `listenPort` 状态文件读。
 *
 * 为什么必须读文件、不写死端口：
 *   · 总线的端口是**探测出来**的（起始端口被占用就 +1），写死会让
 *     "端口恰好被别的程序占了"变成"hook 装上了、却永远连不上宿主"；
 *   · 更要紧的是**安全**：回退到"总线上一定有我们的人"这个假设，
 *     在同机有别的程序监听同一端口时，我们会把协议报文发到**别人**那里。
 *     拿不到接头文件就干脆不连，比连错强。
 *
 * @return 端口；拿不到接头文件时返回 0（调用方据此跳过连接）
 */
static unsigned short BusPort() {
    const std::wstring p = SelfDir() + L"\\listenPort";
    HANDLE h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return 0;
    char buf[32] = {0};
    DWORD read = 0;
    ReadFile(h, buf, sizeof(buf) - 1, &read, nullptr);
    CloseHandle(h);
    const int v = std::atoi(buf);
    if (v > 0 && v < 65536) return static_cast<unsigned short>(v);
    return 0;
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

// ── 运行时取词：热路径这一侧 ─────────────────────────────────

/**
 * 像"玩家看得懂的文字"才值得送给宿主翻译。
 *
 * 为什么要过滤：编码层 hook 会把进程里**所有** CP932→宽字符 的转换都拦下来，
 * 里面混着文件路径、注册表键、内部常量。把这些也发去翻译，既浪费额度，
 * 又会把宿主的词库污染成垃圾场。
 *
 * 判据取最朴素的一条：**含非 ASCII 字符**（日文、中文都在其中）。
 * 纯 ASCII 的 "OK" / "HP" 这类短标识就不发了 —— 它们即使要翻，
 * 也不该由"编码层"这个兜底通道来猜。
 */
static bool LooksLikeText(const std::string& utf8) {
    if (utf8.size() < 2 || utf8.size() > 2048) return false;
    for (unsigned char c : utf8) {
        if (c >= 0x80) return true;
    }
    return false;
}

/**
 * 热路径：查运行时缓存；未命中则**登记待译**（不阻塞、不等待）。
 *
 * @param original 原文（宽字符，由编码层真实转换得到）
 * @param out      命中时写入译文
 * @return 命中返回 true
 */
static bool RuntimeLookup(const std::wstring& original, std::wstring* out) {
    if (InterlockedCompareExchange(&g_rtRun, 1, 1) == 0) return false;

    const std::string utf8 = WideToUtf8(original);
    if (!LooksLikeText(utf8)) return false;

    bool needAsk = false;
    {
        AcquireSRWLockShared(&g_rtLock);
        auto it = g_rtTrans.find(utf8);
        if (it != g_rtTrans.end()) {
            *out = it->second;
            ReleaseSRWLockShared(&g_rtLock);
            return true;
        }
        needAsk = (g_rtAsked.find(utf8) == g_rtAsked.end());
        ReleaseSRWLockShared(&g_rtLock);
    }
    if (!needAsk) return false;   // 已经问过了（在途或宿主答"没有"）—— 不再重复问

    AcquireSRWLockExclusive(&g_rtLock);
    // 双检：读取锁释放到独占锁之间，可能已被别的线程登记
    if (g_rtAsked.emplace(utf8, 1).second) {
        if (g_rtQueue.size() < 1024) {
            g_rtQueue.push_back(utf8);
            InterlockedIncrement(&g_rtReqCount);
            /*
             * 打一条机器可断言的自述行（验收脚本按 RUNTIME 前缀 grep）。
             * 只在这一句**首次**出现时打一次 —— 热路径每帧都会走到这里，
             * 不能每帧刷一行把日志冲爆。
             */
            BB_LOG(L"RUNTIME req=\"%s\"", original.c_str());
        } else {
            BB_WARN(L"[运行时] 待译队列已满，丢弃: %s", original.c_str());
        }
    }
    ReleaseSRWLockExclusive(&g_rtLock);
    return false;
}

/** 真的把运行时译文交还给调用方时打点（每句只打一次，避免刷日志） */
static void LogRuntimeApply(const std::wstring& src, const std::wstring& dst) {
    InterlockedIncrement(&g_rtApplyCount);
    const std::string k = WideToUtf8(src);
    bool first = false;
    {
        AcquireSRWLockExclusive(&g_rtLock);
        first = g_rtApplied.emplace(k, 1).second;
        ReleaseSRWLockExclusive(&g_rtLock);
    }
    if (first) {
        BB_LOG(L"RUNTIME apply=\"%s\" -> \"%s\"", src.c_str(), dst.c_str());
    }
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
    // 3) 静态词表命中 → 直接换成译文（长度语义见 HijackResult 的注释）
    auto it = g_forward.find(key);
    if (it != g_forward.end()) {
        return HijackResult(it->second, nullTerminated, dst, cchWide);
    }

    // 4) 静态词表没有 → 看**运行时**取词（宿主给的译文）
    //
    //    ★ 这里绝不阻塞游戏线程：缓存里有就换，没有就登记一句、本帧原样放行。
    //      译文由通信线程去要，下一帧再走到这里就命中了。
    //      —— 把"等宿主回话"塞进被 hook 的 API 里，是这类工具卡死的头号原因。
    {
        std::wstring runtimeDst;
        if (RuntimeLookup(original, &runtimeDst)) {
            LogRuntimeApply(original, runtimeDst);
            return HijackResult(runtimeDst, nullTerminated, dst, cchWide);
        }
    }

    return RealMB2WC(cp, flags, src, cbMulti, dst, cchWide);  // 两处都没有，原样放行
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
static bool SendJson(const bb::json::Value& v) {
    if (!g_ws.isOpen()) return false;
    return g_ws.sendText(bb::json::dump(v));
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
    msg.set("id", bb::json::Value(static_cast<double>(NextReqId())));
    msg.set("type", bb::json::Value(0.0));
    msg.set("target", bb::json::Value(0.0));
    msg.set("cmd", bb::json::Value(std::string("reportPairs")));
    msg.set("args", bb::json::Value(std::move(pairs)));
    SendJson(msg);
    BB_LOG(L"已上报 %u 对词条给宿主", static_cast<unsigned>(g_forward.size()));
}

// ── 运行时取词：通信这一侧 ───────────────────────────────────

/**
 * 应答当前待译批次。
 *
 * 只认**当前批次**的 id：取词线程一次只发一批、发完就等，所以理论上不会有
 * 别的应答飘进来；真遇到了就明确记一条，而不是把陈旧数据当成本次结果 ——
 * 那种"看起来生效了、其实写错了"的 bug 最难查。
 */
static void HandleBusReply(const bb::json::Value& msg) {
    const LONG want = g_rtWaitId;
    const LONG got = static_cast<LONG>(msg.getNumber("id", -1));
    if (want == 0 || got != want) {
        BB_WARN(L"[运行时] 收到非当前批次的应答（期望 %d，收到 %d），已忽略", (int)want, (int)got);
        return;
    }
    {
        AcquireSRWLockExclusive(&g_rtLock);
        g_rtReplyPayload = bb::json::dump(msg);
        ReleaseSRWLockExclusive(&g_rtLock);
    }
    SetEvent(g_rtReplyEvent);
}

/**
 * 宿主下发的命令。
 *
 * ★ 未知命令**必须明确回报错误**，不能静默吞掉 —— 否则宿主那边只能看到
 *   "发出去没反应"，完全无从排查（这条是宿主侧 bus 的同一条规矩）。
 */
static void HandleHostCommand(const bb::json::Value& msg) {
    const std::string cmd = msg.getString("cmd");
    bb::json::Value reply(bb::json::Object{});
    reply.set("id", bb::json::Value(msg.getNumber("id", 0)));
    reply.set("type", bb::json::Value(1.0));

    if (cmd == "runtimeStat") {
        bb::json::Value st(bb::json::Object{});
        st.set("run", bb::json::Value(static_cast<double>(g_rtRun)));
        st.set("req", bb::json::Value(static_cast<double>(g_rtReqCount)));
        st.set("got", bb::json::Value(static_cast<double>(g_rtGotCount)));
        st.set("none", bb::json::Value(static_cast<double>(g_rtNoneCount)));
        st.set("apply", bb::json::Value(static_cast<double>(g_rtApplyCount)));
        reply.set("error", bb::json::Value(false));
        reply.set("ret", std::move(st));
        SendJson(reply);
        BB_LOG(L"[运行时] 已应答宿主 runtimeStat");
        return;
    }

    reply.set("error", bb::json::Value(true));
    reply.set("ret", bb::json::Value(std::string("未知命令: ") + cmd));
    SendJson(reply);
    BB_WARN(L"[运行时] 宿主下发了未知命令: %s", Utf8ToWide(cmd).c_str());
}

/** 把某批原文重新标成"未问过"，允许以后再试（发送失败 / 等应答超时） */
static void RequireReAsk(const std::vector<std::string>& batch) {
    AcquireSRWLockExclusive(&g_rtLock);
    for (const auto& s : batch) g_rtAsked.erase(s);
    ReleaseSRWLockExclusive(&g_rtLock);
}

/** 连续失败到上限 → 放弃运行时取词（把结论写清楚，免得看起来像"功能没生效"） */
static void GiveUpRuntime() {
    InterlockedExchange(&g_rtRun, 0);
    BB_ERR(L"RT giveup=1 连续 3 次无应答 —— 已停止运行时取词（游戏与本地词表不受影响）");
}

/** 运行时取词的统计自述行（验收脚本按 RT 前缀 grep） */
static void LogRuntimeStat() {
    BB_LOG(L"RT run=%d req=%d got=%d none=%d apply=%d",
           static_cast<int>(g_rtRun), static_cast<int>(g_rtReqCount),
           static_cast<int>(g_rtGotCount), static_cast<int>(g_rtNoneCount),
           static_cast<int>(g_rtApplyCount));
}

/** 解析应答：译文进缓存；宿主没给的记成负缓存，不再重复问 */
static void ApplyReply(const std::string& payload, const std::vector<std::string>& batch) {
    std::unordered_map<std::string, std::wstring> got;
    bb::json::Value rep;
    if (bb::json::parseOk(payload, &rep)) {
        const bb::json::Value* ret = rep.find("ret");
        const bb::json::Value* items = ret ? ret->find("items") : nullptr;
        if (items && items->isArray()) {
            for (const auto& one : *items->arr) {
                const std::string src = one.getString("src");
                const std::string dst = one.getString("dst");
                if (!src.empty() && !dst.empty()) got[src] = Utf8ToWide(dst);
            }
        }
    } else {
        BB_WARN(L"[运行时] 应答无法解析: %s", Utf8ToWide(payload).c_str());
    }

    {
        AcquireSRWLockExclusive(&g_rtLock);
        for (const auto& kv : got) g_rtTrans[kv.first] = kv.second;
        ReleaseSRWLockExclusive(&g_rtLock);
    }

    LONG noneCount = 0;
    for (const auto& s : batch) {
        auto it = got.find(s);
        if (it != got.end()) {
            BB_LOG(L"RUNTIME got=\"%s\" -> \"%s\"", Utf8ToWide(s).c_str(), it->second.c_str());
        } else {
            BB_LOG(L"RUNTIME none=\"%s\"", Utf8ToWide(s).c_str());
            ++noneCount;
        }
    }
    InterlockedExchangeAdd(&g_rtGotCount, static_cast<LONG>(got.size()));
    InterlockedExchangeAdd(&g_rtNoneCount, noneCount);
}

/**
 * 取词线程：把待译队列批量发给宿主，然后等应答。
 *
 * 与接收线程分工：本线程**只发**，接收线程**只收**。
 * TCP 的 send 与 recv 互不干扰，拆成两个线程后两边都是简单的阻塞代码；
 * 若合并成一个线程，"边等应答边收应答"就得自己做超时多路复用，复杂得多且更易出错。
 */
static DWORD WINAPI RtThreadProc(LPVOID) {
    // 等总线连上，**并且完成握手**（答过 whoareyou）—— 握手前抢发会被判协议违约
    for (int i = 0; i < 150 && !g_stopRt; ++i) {
        if (g_ws.isOpen() && g_wsIdentified) break;
        if (g_rtRun == 0) break;   // 通信侧已判定"不可用"，不必再等
        Sleep(100);
    }
    if (!g_ws.isOpen() || !g_wsIdentified) {
        InterlockedExchange(&g_rtRun, 0);
        BB_WARN(L"[运行时] 总线未连接或未完成握手 —— 运行时取词停用（本地词表照常）");
        return 0;
    }
    BB_LOG(L"[运行时] 取词线程已启动（宿主在线且已握手）");

    while (!g_stopRt) {
        std::vector<std::string> batch;
        {
            AcquireSRWLockExclusive(&g_rtLock);
            const size_t take = g_rtQueue.size() < 16 ? g_rtQueue.size() : 16;
            batch.assign(g_rtQueue.begin(), g_rtQueue.begin() + static_cast<ptrdiff_t>(take));
            g_rtQueue.erase(g_rtQueue.begin(), g_rtQueue.begin() + static_cast<ptrdiff_t>(take));
            ReleaseSRWLockExclusive(&g_rtLock);
        }
        if (batch.empty()) {
            Sleep(120);
            continue;
        }

        bb::json::Array items;
        for (const auto& s : batch) {
            bb::json::Value one(bb::json::Object{});
            one.set("src", bb::json::Value(s));
            items.emplace_back(std::move(one));
        }
        bb::json::Value args(bb::json::Object{});
        args.set("from", bb::json::Value(std::string("ja")));
        args.set("to", bb::json::Value(std::string("zh")));
        args.set("items", bb::json::Value(std::move(items)));

        const LONG id = NextReqId();
        InterlockedExchange(&g_rtWaitId, id);   // 接收侧靠它认出"这条应答是我在等的那批"
        bb::json::Value req(bb::json::Object{});
        req.set("id", bb::json::Value(static_cast<double>(id)));
        req.set("type", bb::json::Value(0.0));
        req.set("target", bb::json::Value(0.0));
        req.set("cmd", bb::json::Value(std::string("translate")));
        req.set("args", std::move(args));

        ResetEvent(g_rtReplyEvent);
        if (!g_ws.isOpen() || !SendJson(req)) {
            BB_WARN(L"[运行时] 发送失败，本轮 %u 条稍后重试", static_cast<unsigned>(batch.size()));
            RequireReAsk(batch);
            if (InterlockedIncrement(&g_rtFailStreak) >= 3) { GiveUpRuntime(); break; }
            continue;
        }

        const DWORD waitResult = WaitForSingleObject(g_rtReplyEvent, 3000);
        // 正在卸载：事件可能是被"叫醒"用的，别把陈旧应答当成本次结果
        if (g_stopRt) break;
        if (waitResult != WAIT_OBJECT_0) {
            BB_WARN(L"[运行时] 等应答超时（%u 条），本轮作废、稍后可重试",
                    static_cast<unsigned>(batch.size()));
            RequireReAsk(batch);
            if (InterlockedIncrement(&g_rtFailStreak) >= 3) { GiveUpRuntime(); break; }
            continue;
        }
        InterlockedExchange(&g_rtFailStreak, 0);

        std::string payload;
        {
            AcquireSRWLockShared(&g_rtLock);
            payload = g_rtReplyPayload;
            ReleaseSRWLockShared(&g_rtLock);
        }
        ApplyReply(payload, batch);
        Sleep(60);
    }
    return 0;
}

static DWORD WINAPI WsThreadProc(LPVOID) {
    const unsigned short port = BusPort();
    if (port == 0) {
        // 没有接头文件 = 宿主没起总线。此时**不猜端口**：同机可能有别的程序
        // 正好监听默认端口，猜着连会把我们的报文发到别人那里去。
        InterlockedExchange(&g_rtRun, 0);   // 取词线程也别等了
        BB_WARN(L"没找到宿主总线的接头文件（hook 同目录下应有 listenPort），"
                L"跳过总线连接 —— 本地词表照常工作");
        return 0;
    }
    if (!g_ws.connectTo("127.0.0.1", port, "baibao-native/1.0")) {
        BB_WARN(L"连不上宿主总线（端口 %u），本进程将只在本地查词（不影响游戏运行）", port);
        return 0;
    }

    std::string text;
    bool reported = false;
    while (!g_stopWs) {
        bool timedOut = false;
        if (!g_ws.recvText(text, 5000, &timedOut)) {
            if (g_stopWs) break;
            // ★ 空闲超时 ≠ 断线。长连接绝大部分时间都是空闲的，
            //   把空闲当成断线会让通信线程自己把自己拆掉（实测 5 秒后自杀）。
            if (timedOut) continue;
            BB_WARN(L"总线连接断开，退出通信线程");
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
            BB_LOG(L"已应答 whoareyou，身份: %s", Utf8ToWide(g_identityJson).c_str());
            InterlockedExchange(&g_wsIdentified, 1);   // 从这里起才允许主动发消息
            if (!reported) {
                ReportPairs();
                reported = true;
            }
            continue;
        }
        // 分流：
        //   · 带 cmd 的 = 宿主 → 原生的请求（必须回它）
        //   · 不带 cmd 的 = 应答。只把**我在等的那一批**交给取词线程；
        //     其余（握手、reportPairs 的应答）直接忽略 —— 它们不是错误，
        //     只是与我们无关。不区分的话就会把正常应答报成一堆假警告。
        const std::string cmd = msg.getString("cmd");
        if (!cmd.empty()) {
            HandleHostCommand(msg);
            continue;
        }
        const LONG rid = static_cast<LONG>(msg.getNumber("id", -1));
        if (rid != 0 && rid == g_rtWaitId) {
            HandleBusReply(msg);
        } else {
            BB_LOG(L"[总线] 忽略 id=%d 的应答（非当前取词批次）", static_cast<int>(rid));
        }
    }
    return 0;
}

// ── 导出 ─────────────────────────────────────────────────────
extern "C" __declspec(dllexport) BOOL WINAPI Install(HMODULE selfModule) {
    g_selfModule = selfModule;

    std::wstring logPath = SelfDir() + L"\\toyHook.log";
    bb::Log::open(logPath);

    // 身份信息：宿主靠它知道"这是哪个进程、哪个 hook"。
    //
    // ★ 必须用 json 库构造，**不要手拼字符串**。
    //   Windows 路径里全是反斜杠，手拼会得到 `"C:\Users\..."` —— 那不是合法 JSON
    //   （`\U` 是非法转义），宿主一解析就整条断连；就算对端宽容地解出来了，
    //   值也被吃掉转义（`\n` 变成真换行、`\b` 变成退格），路径根本是错的。
    //   实测踩到：现象是"刚连上就被断开"，而两边的日志都看不出是身份报文坏了。
    {
        wchar_t exePath[MAX_PATH] = {0};
        GetModuleFileNameW(nullptr, exePath, MAX_PATH);
        bb::json::Value ident(bb::json::Object{});
        ident.set("exePath", bb::json::Value(WideToUtf8(exePath)));
        ident.set("pid", bb::json::Value(static_cast<double>(GetCurrentProcessId())));
        ident.set("module", bb::json::Value(std::string("toyHook")));
        ident.set("engine", bb::json::Value(std::string("toy")));
        ident.set("arch", bb::json::Value(static_cast<double>(sizeof(void*) * 8)));
        g_identityJson = bb::json::dump(ident);
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

    // 运行时取词线程：只负责"把待译队列发给宿主、等应答"
    g_rtReplyEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);  // 自动复位
    g_stopRt = 0;
    g_rtThread = CreateThread(nullptr, 0, RtThreadProc, nullptr, 0, nullptr);

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

    // 先把取词线程收掉（它会在 socket 上发东西，必须在关连接之前停）
    g_stopRt = 1;
    if (g_rtReplyEvent) SetEvent(g_rtReplyEvent);   // 叫醒可能正在等应答的它
    if (g_rtThread) {
        WaitForSingleObject(g_rtThread, 3000);
        CloseHandle(g_rtThread);
        g_rtThread = nullptr;
    }
    if (g_rtReplyEvent) { CloseHandle(g_rtReplyEvent); g_rtReplyEvent = nullptr; }
    LogRuntimeStat();   // 运行时取词的最终统计（验收脚本据此断言）

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

    // 运行时取词的状态一并清掉（同一个进程可能被反复注入/卸载）
    AcquireSRWLockExclusive(&g_rtLock);
    g_rtTrans.clear();
    g_rtAsked.clear();
    g_rtApplied.clear();
    g_rtQueue.clear();
    ReleaseSRWLockExclusive(&g_rtLock);
    InterlockedExchange(&g_rtRun, 1);
    InterlockedExchange(&g_rtFailStreak, 0);
    InterlockedExchange(&g_rtReqCount, 0);
    InterlockedExchange(&g_rtGotCount, 0);
    InterlockedExchange(&g_rtNoneCount, 0);
    InterlockedExchange(&g_rtApplyCount, 0);

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
