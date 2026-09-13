// 极简 JSON —— 原生侧需要它做两件事：读词表文件、说 RPC 协议。
//
// 为什么不引第三方：项目宪法要求"不引入 libs/ 之外的第三方库"，
// 而我们在沙箱里也没法随便下包。这个实现够用即可：解析 + 序列化，
// 支持对象/数组/字符串(含转义与 \uXXXX)/数字/布尔/null。
//
// ⚠️ 注意：宿主侧协议里的 args/ret 走的是**对象图**格式（见 host/bus/graph.ts），
// 我们先按普通 JSON 收发；等接入对象图时在这里加对应的编解码即可。
#pragma once

#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace bb {
namespace json {

enum class Type { Null, Bool, Number, String, Array, Object };

struct Value;
using Array = std::vector<Value>;
using Object = std::map<std::string, Value>;

struct Value {
    Type type = Type::Null;
    bool boolean = false;
    double number = 0;
    std::string str;
    std::shared_ptr<Array> arr;
    std::shared_ptr<Object> obj;

    Value() = default;
    explicit Value(bool b) : type(Type::Bool), boolean(b) {}
    explicit Value(double n) : type(Type::Number), number(n) {}
    explicit Value(std::string s) : type(Type::String), str(std::move(s)) {}
    explicit Value(const char* s) : type(Type::String), str(s) {}
    explicit Value(Array a) : type(Type::Array), arr(std::make_shared<Array>(std::move(a))) {}
    explicit Value(Object o) : type(Type::Object), obj(std::make_shared<Object>(std::move(o))) {}

    bool isNull()   const { return type == Type::Null; }
    bool isBool()   const { return type == Type::Bool; }
    bool isNumber() const { return type == Type::Number; }
    bool isString() const { return type == Type::String; }
    bool isArray()  const { return type == Type::Array; }
    bool isObject() const { return type == Type::Object; }

    // 容错取值：类型不对就返回兜底值，避免 hook 里到处判类型
    std::string asString(const std::string& d = "") const { return isString() ? str : d; }
    double asNumber(double d = 0) const { return isNumber() ? number : d; }
    bool asBool(bool d = false) const { return isBool() ? boolean : d; }

    const Value* find(const std::string& key) const {
        if (!isObject()) return nullptr;
        auto it = obj->find(key);
        return it == obj->end() ? nullptr : &it->second;
    }
    std::string getString(const std::string& key, const std::string& d = "") const {
        const Value* v = find(key);
        return v ? v->asString(d) : d;
    }
    double getNumber(const std::string& key, double d = 0) const {
        const Value* v = find(key);
        return v ? v->asNumber(d) : d;
    }

    void set(const std::string& key, Value v) {
        if (!isObject()) { type = Type::Object; obj = std::make_shared<Object>(); }
        (*obj)[key] = std::move(v);
    }
};

// ── 解析 ─────────────────────────────────────────────────────
namespace detail {

struct Parser {
    const char* p;
    const char* end;
    bool ok = true;

    explicit Parser(const std::string& s) : p(s.data()), end(s.data() + s.size()) {}

    void skipWs() {
        while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) ++p;
    }
    bool eof() const { return p >= end; }

    Value parseValue() {
        skipWs();
        if (eof()) { ok = false; return Value(); }
        char c = *p;
        switch (c) {
            case '{': return parseObject();
            case '[': return parseArray();
            case '"': return Value(parseString());
            case 't': if (match("true"))  return Value(true);  ok = false; return Value();
            case 'f': if (match("false")) return Value(false); ok = false; return Value();
            case 'n': if (match("null"))  return Value();      ok = false; return Value();
            default:  return parseNumber();
        }
    }

    bool match(const char* lit) {
        size_t n = 0; while (lit[n]) ++n;
        if (static_cast<size_t>(end - p) < n) return false;
        for (size_t i = 0; i < n; ++i) if (p[i] != lit[i]) return false;
        p += n;
        return true;
    }

    Value parseObject() {
        ++p; // '{'
        Object o;
        skipWs();
        if (p < end && *p == '}') { ++p; return Value(std::move(o)); }
        for (;;) {
            skipWs();
            if (eof() || *p != '"') { ok = false; return Value(); }
            std::string key = parseString();
            skipWs();
            if (eof() || *p != ':') { ok = false; return Value(); }
            ++p;
            o[key] = parseValue();
            skipWs();
            if (eof()) { ok = false; return Value(); }
            if (*p == ',') { ++p; continue; }
            if (*p == '}') { ++p; break; }
            ok = false; return Value();
        }
        return Value(std::move(o));
    }

    Value parseArray() {
        ++p; // '['
        Array a;
        skipWs();
        if (p < end && *p == ']') { ++p; return Value(std::move(a)); }
        for (;;) {
            a.push_back(parseValue());
            skipWs();
            if (eof()) { ok = false; return Value(); }
            if (*p == ',') { ++p; continue; }
            if (*p == ']') { ++p; break; }
            ok = false; return Value();
        }
        return Value(std::move(a));
    }

    // 把 UTF-8 码点追加到 out
    static void appendUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) out.push_back(static_cast<char>(cp));
        else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    unsigned parseHex4() {
        unsigned v = 0;
        for (int i = 0; i < 4 && p < end; ++i, ++p) {
            char c = *p;
            v <<= 4;
            if (c >= '0' && c <= '9') v |= unsigned(c - '0');
            else if (c >= 'a' && c <= 'f') v |= unsigned(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= unsigned(c - 'A' + 10);
            else { ok = false; return 0; }
        }
        return v;
    }

    std::string parseString() {
        std::string out;
        ++p; // '"'
        while (p < end) {
            char c = *p++;
            if (c == '"') return out;
            if (c != '\\') { out.push_back(c); continue; }
            if (p >= end) break;
            char e = *p++;
            switch (e) {
                case '"':  out.push_back('"');  break;
                case '\\': out.push_back('\\'); break;
                case '/':  out.push_back('/');  break;
                case 'b':  out.push_back('\b'); break;
                case 'f':  out.push_back('\f'); break;
                case 'n':  out.push_back('\n'); break;
                case 'r':  out.push_back('\r'); break;
                case 't':  out.push_back('\t'); break;
                case 'u': {
                    unsigned cp = parseHex4();
                    // 代理对：高代理后面跟 \uDC00-\uDFFF
                    if (cp >= 0xD800 && cp <= 0xDBFF && p + 1 < end && p[0] == '\\' && p[1] == 'u') {
                        p += 2;
                        unsigned lo = parseHex4();
                        if (lo >= 0xDC00 && lo <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        }
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: ok = false; return out;
            }
        }
        ok = false;
        return out;
    }

    Value parseNumber() {
        const char* start = p;
        if (p < end && (*p == '-' || *p == '+')) ++p;
        while (p < end && ((*p >= '0' && *p <= '9') || *p == '.' || *p == 'e' || *p == 'E' ||
                           *p == '-' || *p == '+')) ++p;
        if (p == start) { ok = false; return Value(); }
        return Value(std::strtod(std::string(start, p).c_str(), nullptr));
    }
};

} // namespace detail

inline Value parse(const std::string& text) {
    detail::Parser ps(text);
    Value v = ps.parseValue();
    if (!ps.ok) return Value(); // 解析失败给 null，调用方自己判
    return v;
}

inline bool parseOk(const std::string& text, Value* out) {
    detail::Parser ps(text);
    Value v = ps.parseValue();
    if (!ps.ok) return false;
    if (out) *out = std::move(v);
    return true;
}

// ── 序列化 ───────────────────────────────────────────────────
namespace detail {

inline void escapeTo(std::string& out, const std::string& s) {
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c)); // 直接放 UTF-8 字节
                }
        }
    }
    out.push_back('"');
}

inline void dumpTo(std::string& out, const Value& v) {
    switch (v.type) {
        case Type::Null:   out += "null"; break;
        case Type::Bool:   out += v.boolean ? "true" : "false"; break;
        case Type::Number: {
            char buf[40];
            // 整数友好：避免 1 被写成 1.000000
            if (v.number == static_cast<double>(static_cast<long long>(v.number))) {
                std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v.number));
            } else {
                std::snprintf(buf, sizeof(buf), "%.10g", v.number);
            }
            out += buf;
            break;
        }
        case Type::String: escapeTo(out, v.str); break;
        case Type::Array: {
            out.push_back('[');
            bool first = true;
            for (const auto& e : *v.arr) {
                if (!first) out.push_back(',');
                first = false;
                dumpTo(out, e);
            }
            out.push_back(']');
            break;
        }
        case Type::Object: {
            out.push_back('{');
            bool first = true;
            for (const auto& kv : *v.obj) {
                if (!first) out.push_back(',');
                first = false;
                escapeTo(out, kv.first);
                out.push_back(':');
                dumpTo(out, kv.second);
            }
            out.push_back('}');
            break;
        }
    }
}

} // namespace detail

inline std::string dump(const Value& v) {
    std::string out;
    out.reserve(256);
    detail::dumpTo(out, v);
    return out;
}

} // namespace json
} // namespace bb
