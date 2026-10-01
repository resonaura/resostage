/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "WebServerHttp.h"

#include "server/WireTypes.h"

#include <libwebsockets.h>

#include <cctype>
#include <cstring>
#include <string_view>
#include <vector>

namespace resostage::webserver_http {
namespace {

// Percent-decodes a URL query-string value (e.g. "Audio%2Fkick.wav" ->
// "Audio/kick.wav", "+" -> " "). Malformed escapes are passed through as-is.
std::string urlDecode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1]))
            && std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
            const int hi = std::isdigit(static_cast<unsigned char>(s[i + 1])) ? s[i + 1] - '0' : (std::tolower(s[i + 1]) - 'a' + 10);
            const int lo = std::isdigit(static_cast<unsigned char>(s[i + 2])) ? s[i + 2] - '0' : (std::tolower(s[i + 2]) - 'a' + 10);
            out += static_cast<char>((hi << 4) | lo);
            i += 2;
        } else if (s[i] == '+') {
            out += ' ';
        } else {
            out += s[i];
        }
    }
    return out;
}

} // namespace

// Extracts `key`'s value from a raw "a=1&b=2" query string (as returned by
// lws' WSI_TOKEN_HTTP_URI_ARGS), percent-decoded. Empty string if absent.
std::string queryParam(const char* queryArgs, const char* key) {
    if (queryArgs == nullptr)
        return {};
    const std::string args(queryArgs);
    const std::string prefix = std::string(key) + "=";
    size_t pos = 0;
    while (pos < args.size()) {
        const size_t amp = args.find('&', pos);
        const std::string part = args.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (part.compare(0, prefix.size(), prefix) == 0)
            return urlDecode(part.substr(prefix.size()));
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return {};
}

int writeHttpResponse(struct lws* wsi, int status, const char* contentType,
                      const char* body, size_t bodyLen,
                      const char* contentDisposition) {
    uint8_t buf[LWS_PRE + 2048];
    uint8_t* start = &buf[LWS_PRE];
    uint8_t* p = start;
    uint8_t* end = &buf[sizeof(buf) - 1];

    if (lws_add_http_common_headers(wsi, static_cast<unsigned int>(status), contentType,
                                    bodyLen, &p, end))
        return 1;

    static const char kCsp[] =
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ws: wss: http: https:; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; "
        "style-src 'self' 'unsafe-inline' https:; "
        "worker-src 'self' blob:; "
        "connect-src 'self' ws: wss: http: https:; "
        "img-src 'self' data: blob: https:; "
        "font-src 'self' data: https:;";
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("content-security-policy"),
                                    reinterpret_cast<const unsigned char*>(kCsp),
                                    static_cast<int>(std::strlen(kCsp)), &p, end))
        return 1;

    // CORS for LAN tablets / other origins (local network only use-case).
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("access-control-allow-origin"),
                                    reinterpret_cast<const unsigned char*>("*"), 1, &p, end))
        return 1;

    static const char kCacheControl[] = "no-store, must-revalidate";
    if (lws_add_http_header_by_name(wsi,
                                    reinterpret_cast<const unsigned char*>("cache-control"),
                                    reinterpret_cast<const unsigned char*>(kCacheControl),
                                    static_cast<int>(std::strlen(kCacheControl)), &p, end))
        return 1;
    if (contentDisposition != nullptr) {
        if (lws_add_http_header_by_name(
                wsi, reinterpret_cast<const unsigned char*>("content-disposition"),
                reinterpret_cast<const unsigned char*>(contentDisposition),
                static_cast<int>(std::strlen(contentDisposition)), &p, end))
            return 1;
    }
    if (lws_finalize_write_http_header(wsi, start, &p, end))
        return 1;

    if (body != nullptr && bodyLen > 0) {
        // Body may be large (SPA); stage via a heap buffer with LWS_PRE headroom.
        std::vector<uint8_t> tx(LWS_PRE + bodyLen);
        std::memcpy(tx.data() + LWS_PRE, body, bodyLen);
        if (lws_write(wsi, tx.data() + LWS_PRE, bodyLen, LWS_WRITE_HTTP_FINAL) < 0)
            return 1;
    } else {
        // Empty body still needs FINAL for h2 stream close.
        unsigned char empty = 0;
        lws_write(wsi, &empty, 0, LWS_WRITE_HTTP_FINAL);
    }

    if (lws_http_transaction_completed(wsi))
        return -1;
    return 0;
}

int writeJsonOk(struct lws* wsi) {
    static const std::string kOk = []() {
        std::string s;
        (void)glz::write_json(wire::WOkPayload{}, s);
        return s;
    }();
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", kOk.data(), kOk.size());
}

int writeJsonError(struct lws* wsi, int status, const std::string& error) {
    wire::WErrorPayload payload{error};
    std::string s;
    (void)glz::write_json(payload, s);
    return writeHttpResponse(wsi, status, "application/json", s.data(), s.size());
}

int writeJsonEnabled(struct lws* wsi, bool enabled) {
    wire::WEnabledPayload payload{enabled};
    std::string s;
    (void)glz::write_json(payload, s);
    return writeHttpResponse(wsi, HTTP_STATUS_OK, "application/json", s.data(), s.size());
}

} // namespace resostage::webserver_http
