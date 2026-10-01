/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <cstddef>
#include <string>

struct lws;

namespace resostage::webserver_http {

// Shared only by the WebServer HTTP implementation translation units.
std::string queryParam(const char* queryArgs, const char* key);
int writeHttpResponse(struct lws* wsi, int status, const char* contentType,
                      const char* body, std::size_t bodyLen,
                      const char* contentDisposition = nullptr);
int writeJsonOk(struct lws* wsi);
int writeJsonError(struct lws* wsi, int status, const std::string& error);
int writeJsonEnabled(struct lws* wsi, bool enabled);

} // namespace resostage::webserver_http
