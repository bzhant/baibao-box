# =============================================================================
# zz_bb_cjk.rpy —— Ren'Py 中文适配（单文件安装 / 删除即还原）
# =============================================================================
# 作用：让 Ren'Py 游戏能正常显示中文。
#
# ── 为什么 Ren'Py 只需要这一个文件（侦察结论，见 docs/recon/RenPy-引擎侦察报告.md）──
#   Ren'Py 与 MV/MZ 完全不同：它**自带专业文本排版引擎和 CJK 断行规则**，
#   所以**不需要写任何折行 hook**。真正缺的只有「字体」：
#
#   · 断行：`renpy/text/text.py:845` 里 "unicode"/"eastasian" 走
#           `textsupport.annotate_unicode(...)` —— 就是 CJK 断行。
#           引擎默认值就是 `language "unicode"`（`renpy/common/00style.rpy:140`），
#           本游戏也设了 `gui.language = "unicode"`（`game/gui.rpy:412`）。
#           ⇒ 本来就能正确处理中文换行。
#   · 字体：本游戏 `gui.text_font = "CoolveticaRG-Regular.otf"`、
#           `gui.name_text_font = "Beach Vibe.ttf"` —— 都是**装饰性拉丁字体，没有 CJK 字形**
#           ⇒ 中文全是豆腐块。**这才是要修的。**
#
# ── 三个关键设计决定 ──
#
#   ① 用 `FontGroup` 只给 CJK 加回退，**不替换游戏字体**
#      游戏的 Coolvetica / Beach Vibe 是标题风格的一部分。直接换掉会让界面观感全变。
#      FontGroup 按码位段把字体拼起来：拉丁字符仍走原字体，CJK 才交给中文字体。
#
#   ② 中文字体**按名字从系统里找，不往游戏里塞字体文件**
#      `renpy/text/font.py:635 load_face()`：游戏目录找不到时会用 `pygame.sysfont`
#      在**系统字体目录**里按名字找（需 `config.allow_sysfonts`）。
#      ⇒ 干净地避开了"分发字体涉及授权"的问题（对比 MV/MZ 那边我们明确没做字体分发）。
#      本游戏 `game/` 里那两个 `*.ttf.bak` 说明别人改过字体 —— 我们不改任何原文件。
#
#   ③ 单文件安装：卸载 = **删掉这个文件（以及它的 .rpyc）**
#      ⚠️ 强调 `.rpyc`：Ren'Py 会把 .rpy 编译成 .rpyc，
#      只删 .rpy 而留下 .rpyc 的话，**它仍然会被加载** —— 这是"删了却没还原"的常见坑。
#
# ── 顺序要求 ──
#   文件名以 `zz_` 开头 → 按字母序最后加载；再用 `init 999`（合法范围内的最高优先级 = 最后执行），
#   确保在 `gui.rpy` 的 `gui.init(1920, 1080)` 之后覆盖。
#   `gui.init` 会按 `gui.*` 变量重建样式，所以这里同时改**变量**和**具体样式**，双保险。
# =============================================================================

# ★ 优先级必须是 **-999 ~ 999** 之间（lint 实测报过错：
#   "The init priority (1000) is not in the -999 to 999 range."）。
#   999 = 最高 = 最后执行，正好保证在 gui.rpy 的 gui.init() 之后覆盖。
init 999 python:

    # ── 允许从系统字体目录按名字找字体（见文件头 ②）──
    config.allow_sysfonts = True

    # ── 候选中文字体：按顺序取第一个系统里存在的 ──
    #   用"候选列表 + 逐个尝试"而不是写死一个：不同机器装的字体不一样，
    #   写死一个在没装那台机器上会静默退回豆腐块。
    BB_CJK_FONT_CANDIDATES = [
        "simhei.ttf",        # 黑体（Windows 自带，覆盖好、低分辨率下清楚）
        "msyh.ttc",          # 微软雅黑
        "simsun.ttc",        # 宋体
        "msjh.ttc",          # 微軟正黑體
        "NotoSansCJKsc-Regular.otf",
        "SourceHanSansSC-Regular.otf",
    ]

    # ── 需要接管字体的样式 ──
    #   取自 Ren'Py gui 模板的样式清单。用"存在才设"的循环，
    #   而不是逐个硬写 —— 不同版本/不同游戏有的样式可能不存在。
    BB_FONT_STYLES = [
        "default", "say_dialogue", "say_thought", "say_label",
        "namebox", "namebox_label",
        "input", "button_text", "choice_button_text", "quick_button_text",
        "navigation_button_text", "main_menu_button_text", "game_menu_button_text",
        "confirm_button_text", "radio_button_text", "check_button_text",
        "slot_button_text", "file_slot_time_text", "file_slot_name_text",
        "notify_text", "history_text", "skip_text", "bar_label_text",
        "mute_button_text", "gui_button_text", "interface_button_text",
        "help_button_text", "about_label_text",
    ]

    def bb_make_font_group(base_font):
        """把「原字体 + 中文字体」按码位段拼成一个 FontGroup。

        `start=None` 的那次 add 是"默认字体"（其余未被显式映射的字符用它）；
        后面几次 add 把 CJK 相关区段指给中文字体。
        「先 add 的优先」，所以原字体放在最前、吃拉丁，CJK 段落再交给中文字体。
        """
        g = FontGroup()
        # 原字体作为默认（拉丁、装饰字符仍然由它渲染 → 保留游戏观感）
        if base_font:
            g.add(base_font)
        cjk = _bb_cjk_name
        if cjk:
            # CJK 部首 / 康熙部首
            g.add(cjk, 0x2E80, 0x2FDF)
            # CJK 标点（、。「」…— 等）
            g.add(cjk, 0x3000, 0x303F)
            # 假名（保留原文时可能遇到）
            g.add(cjk, 0x3040, 0x30FF)
            # 注音 / 带圈 CJK
            g.add(cjk, 0x3100, 0x32FF)
            # CJK 扩展 A
            g.add(cjk, 0x3400, 0x4DBF)
            # CJK 基本区（汉字主体）
            g.add(cjk, 0x4E00, 0x9FFF)
            # 兼容汉字
            g.add(cjk, 0xF900, 0xFAFF)
            # CJK 兼容形式
            g.add(cjk, 0xFE30, 0xFE4F)
            # 全角字符（全角标点、全角字母数字）
            g.add(cjk, 0xFF00, 0xFFEF)
            # CJK 扩展 B 及以后（生僻字，如「龘」）
            g.add(cjk, 0x20000, 0x2FA1F)
        return g

    # ── 挑一个系统里真正存在的中文字体 ──
    #   说明：这里只做"名字是否可用"的登记，真正的解析由 Ren'Py 的 load_face 完成。
    #   我们无法在 init 阶段可靠地探测系统字体（那要 pygame.sysfont，时机不对），
    #   所以策略是：候选列表 + 逐个尝试 + 最后兜底用原字体，
    #   并把最终选择写进日志，便于出问题时排查。
    _bb_cjk_name = None
    try:
        import pygame
        pygame.sysfont.initsysfonts()
        _bb_installed = []
        for _names in pygame.sysfont.Sysfonts.values():
            if _names:
                for _flags, _ffn in _names.items():
                    _bb_installed.append(_ffn.lower())
        for _cand in BB_CJK_FONT_CANDIDATES:
            if any(_f.endswith(_cand.lower()) for _f in _bb_installed):
                _bb_cjk_name = _cand
                break
    except Exception as _e:
        _bb_cjk_name = None
        renpy.log("BB_CJK: 探测系统字体失败：%r" % (_e,))

    if _bb_cjk_name is None:
        # 探测不到也不致命 —— 但要说清楚，不要静默失败
        renpy.log("BB_CJK: 未在系统里找到候选中文字体，中文可能显示为豆腐块。"
                  "候选：%r" % (BB_CJK_FONT_CANDIDATES,))
    else:
        renpy.log("BB_CJK: 使用中文字体 %r" % (_bb_cjk_name,))

    # ── 应用：变量 + 具体样式，双保险 ──
    if _bb_cjk_name:
        # ① 改 gui.* 变量（若之后还有按变量重建样式的过程，也会带上）
        for _var in ("text_font", "name_text_font", "interface_text_font",
                     "button_text_font", "choice_button_text_font"):
            try:
                _base = getattr(gui, _var, None)
                if _base:
                    setattr(gui, _var, bb_make_font_group(_base))
            except Exception as _e:
                renpy.log("BB_CJK: 设置 gui.%s 失败：%r" % (_var, _e))

        # ② 直接改具体样式（gui.init 已经跑过，样式已经建好，所以这一步才是真正生效的）
        for _sn in BB_FONT_STYLES:
            try:
                _st = getattr(style, _sn)
                _base = _st.font
                _st.font = bb_make_font_group(_base)
            except Exception:
                # 样式不存在 / 该样式没有 font 属性 —— 正常，跳过
                pass

        # ③ 中文标点禁则：用引擎自带的 eastasian 断行
        #    `annotate_unicode(glyphs, False, 0)` —— 与默认的 "unicode" 同分支，
        #    这里显式写出来是为了：即使游戏原本设成 "western"（会按空格断、中文完全不折）
        #    也能被纠正过来。
        try:
            style.default.language = "eastasian"
        except Exception as _e:
            renpy.log("BB_CJK: 设置 language 失败：%r" % (_e,))

        renpy.log("BB_CJK: 中文适配已应用（FontGroup 回退 + eastasian 断行）")
