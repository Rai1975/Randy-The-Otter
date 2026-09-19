// Only activates on joinhandshake.com — scoped to personal use.
// Runs in Chrome's MAIN world (manifest "world": "MAIN" at document_start)
// so window.fetch / XHR here are the page's real objects, not the isolated-world copies.
(function () {
  "use strict";

  // Guard against double-patch on SPA navigations / extension reloads.
  if (window.__hsInterceptorPatched) return;
  window.__hsInterceptorPatched = true;

  var GRAPHQL_MARKER = "/hs/graphql";
  var TARGET_OP = "GetExtendedJobDetails";

  // --- helpers ---------------------------------------------------------------

  function isGraphqlUrl(url) {
    if (!url || typeof url !== "string") return false;
    return url.indexOf(GRAPHQL_MARKER) !== -1;
  }

  function tryParseOperationName(bodyText) {
    if (!bodyText || typeof bodyText !== "string") return null;
    try {
      var parsed = JSON.parse(bodyText);
      // Batched requests may be an array; pick first with operationName
      if (Array.isArray(parsed)) {
        for (var i = 0; i < parsed.length; i++) {
          if (parsed[i] && typeof parsed[i].operationName === "string") {
            return parsed[i].operationName;
          }
        }
        return null;
      }
      if (parsed && typeof parsed.operationName === "string") {
        return parsed.operationName;
      }
      // Some clients nest under variables or extensions — not our target
      return null;
    } catch (_e) {
      return null;
    }
  }

  function tryParseJson(text) {
    if (!text || typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch (_e) {
      return null;
    }
  }

  // Log as a single expandable object so DevTools shows ▶ and copy-as-object works
  function logGraphqlHit(source, url, operationName, bodyText) {
    try {
      var reqObj = tryParseJson(bodyText);
      if (reqObj !== null) {
        console.log("[HS-SCRAPER] GraphQL hit:", {
          source: source,
          url: url,
          operationName: operationName || null,
          request: reqObj,
        });
      } else {
        console.log("[HS-SCRAPER] GraphQL hit:", {
          source: source,
          url: url,
          operationName: operationName || null,
          request: bodyText || null,
        });
      }
    } catch (_e) {}
  }

  function isJobOperation(op) {
    return op === TARGET_OP;
  }

  function extractFields(job) {
    if (!job || typeof job !== "object") return null;
    var title =
      job.title ||
      job.name ||
      job.jobTitle ||
      job.positionTitle ||
      job.displayName ||
      null;

    var company =
      (job.employer && (job.employer.name || job.employer.displayName)) ||
      (job.company && (job.company.name || job.company.displayName)) ||
      (job.organization && job.organization.name) ||
      job.employerName ||
      job.companyName ||
      job.organizationName ||
      null;

    var payRange =
      job.payRate ||
      job.payRange ||
      job.salaryRange ||
      job.compensation ||
      job.wage ||
      job.pay ||
      (job.salary && (job.salary.displayString || job.salary.formatted || job.salary.value)) ||
      null;
    // Keep payRange as an object so console.log renders it expandably;
    // stringification (if ever needed) happens only at backend POST time.

    var workMode =
      job.workMode ||
      job.remoteType ||
      job.locationType ||
      job.workplaceType ||
      job.remote ||
      job.isRemote ||
      (job.location && job.location.type) ||
      null;
    if (workMode === true) workMode = "remote";
    if (workMode === false) workMode = "in-person";

    var workAuth =
      job.workAuthorizationRequirement ||
      job.workAuthorization ||
      job.workAuth ||
      job.visaRequirement ||
      job.requiresWorkAuthorization ||
      job.authorizationRequirement ||
      job.employmentAuthorization ||
      null;

    var description =
      job.description ||
      job.jobDescription ||
      job.details ||
      job.longDescription ||
      null;

    return {
      title: title,
      company: company,
      payRange: payRange,
      workMode: workMode,
      workAuthorization: workAuth,
      description: description,
    };
  }

  function tryExtractJobId(bodyText, job) {
    // Prefer id from the GraphQL job payload itself
    if (job && typeof job === "object") {
      if (job.id != null) return String(job.id);
      if (job.jobId != null) return String(job.jobId);
    }
    // Fall back to variables in the request body (batched or single)
    var parsed = tryParseJson(bodyText);
    if (!parsed) return null;
    var list = Array.isArray(parsed) ? parsed : [parsed];
    for (var i = 0; i < list.length; i++) {
      var v = list[i] && list[i].variables;
      if (v && typeof v === "object") {
        if (v.id != null) return String(v.id);
        if (v.jobId != null) return String(v.jobId);
        if (v.jobID != null) return String(v.jobID);
        if (v.job_id != null) return String(v.job_id);
      }
    }
    return null;
  }

  function handleJobPayload(job, meta) {
    var parsed = extractFields(job);
    // Only the parsed job fields — expandable object in DevTools (no raw dump)
    console.log("[HS-SCRAPER] parsed job fields:", parsed);

    // Relay parsed-only across world boundary to the isolated content script
    try {
      var jobId = tryExtractJobId(meta.requestBody || null, job);
      window.postMessage(
        {
          type: "HS_SCRAPER_JOB_DATA",
          payload: {
            parsed: parsed,
            jobId: jobId,
            operationName: meta.operationName || null,
            url: meta.url || null,
            timestamp: Date.now(),
          },
        },
        "*"
      );
    } catch (_e) {
      // postMessage must never break the host page
    }
  }

  function tryHandleGraphqlResponse(json, meta) {
    try {
      if (!json || typeof json !== "object") return;
      // Handles both { data: { job: {...} } } and batched arrays — no full-response dump (parsed-only)
      var candidates = Array.isArray(json) ? json : [json];
      for (var i = 0; i < candidates.length; i++) {
        var entry = candidates[i];
        if (entry && entry.data && entry.data.job) {
          handleJobPayload(entry.data.job, meta);
        }
      }
    } catch (_e) {
      // Defensive — never break page flow
    }
  }

  // --- fetch patch -----------------------------------------------------------

  var origFetch = window.fetch;

  window.fetch = async function (input, init) {
    var url = null;
    var bodyText = null;
    var operationName = null;

    try {
      // Resolve URL string
      if (typeof input === "string") {
        url = input;
      } else if (input && typeof input.url === "string") {
        url = input.url;
      } else if (input instanceof Request && typeof input.url === "string") {
        url = input.url;
      }

      // Resolve body text for operationName (init.body wins; else try Request clone)
      if (init && typeof init.body === "string") {
        bodyText = init.body;
      } else if (typeof input !== "string" && input instanceof Request) {
        try {
          // Clone so we don't consume the original stream
          var cloned = input.clone();
          // Guard: some Requests have no body
          if (cloned && typeof cloned.text === "function") {
            bodyText = null;
          }
        } catch (_e) {
          bodyText = null;
        }
      }

      if (bodyText) {
        operationName = tryParseOperationName(bodyText);
      }
      // Only log the target op — all other /hs/graphql traffic is ignored
      if (isGraphqlUrl(url) && isJobOperation(operationName)) {
        logGraphqlHit("fetch-pre", url, operationName, bodyText);
      }
    } catch (_e) {
      // Never break fetch setup
    }

    var response;
    try {
      response = await origFetch.apply(this, arguments);
    } catch (e) {
      throw e;
    }

    // Async body re-check for Request-object case where body wasn't in init
    var effectiveRequestBody = bodyText || null;
    if (!operationName && isGraphqlUrl(url) && typeof input !== "string" && input instanceof Request) {
      try {
        var reqClone = input.clone();
        var reqText = await reqClone.text().catch(function () { return null; });
        if (reqText) {
          operationName = tryParseOperationName(reqText);
          effectiveRequestBody = reqText;
          if (isJobOperation(operationName)) {
            logGraphqlHit("fetch-pre-requestClone", url, operationName, reqText);
          }
        }
      } catch (_e) {}
    }

    // Only deep-parse the target op; everything else is silently ignored
    try {
      if (isGraphqlUrl(url) && isJobOperation(operationName)) {
        // Preserve the effective request body for jobId extraction downstream
        var effectiveBody = effectiveRequestBody;
        // Clone so the page's own .json()/.text() is untouched
        var clone = response.clone();
        clone
          .json()
          .then(function (json) {
            tryHandleGraphqlResponse(json, { operationName: operationName, url: url, requestBody: effectiveBody });
          })
          .catch(function () {
            // Non-JSON or already-consumed — ignore
          });
      }
    } catch (_e) {}

    return response;
  };

  // --- XHR patch -------------------------------------------------------------

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__hsUrl = url;
      this.__hsMethod = method;
    } catch (_e) {}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      this.__hsBody = body;
      var op = null;
      if (typeof body === "string") {
        op = tryParseOperationName(body);
      }
      if (op) this.__hsOperationName = op;
      if (isGraphqlUrl(this.__hsUrl) && isJobOperation(op)) {
        logGraphqlHit("xhr-send", this.__hsUrl, op, typeof body === "string" ? body : null);
      }

      var self = this;
      var urlForCheck = this.__hsUrl;

      // Use addEventListener so we don't clobber existing onload/onreadystatechange handlers
      var onLoadHandler = function () {
        try {
          var currentOp = self.__hsOperationName;
          // If body wasn't a string, we never parsed op — try once more
          // (some apps pass FormData/Blob; those won't be JSON anyway)
          if (!currentOp && typeof self.__hsBody === "string") {
            currentOp = tryParseOperationName(self.__hsBody);
          }
          if (!isGraphqlUrl(urlForCheck) || !isJobOperation(currentOp)) return;

          var text = null;
          try {
            text = self.responseText;
          } catch (_e) {
            return;
          }
          if (!text) return;
          var json = null;
          try {
            json = JSON.parse(text);
          } catch (_e) {
            return;
          }
          tryHandleGraphqlResponse(json, { operationName: currentOp, url: urlForCheck, requestBody: typeof self.__hsBody === "string" ? self.__hsBody : null });
        } catch (_e) {}
      };

      // load fires after DONE for XHR; also listen to readystatechange as fallback
      try {
        this.addEventListener("load", onLoadHandler);
      } catch (_e) {
        // Fallback: wrap onreadystatechange if addEventListener unavailable
        var prev = this.onreadystatechange;
        this.onreadystatechange = function () {
          if (self.readyState === 4) onLoadHandler();
          if (typeof prev === "function") {
            try { return prev.apply(self, arguments); } catch (_e2) {}
          }
        };
      }
    } catch (_e) {
      // Never break XHR setup
    }
    return origSend.apply(this, arguments);
  };

  console.log("[HS-SCRAPER] interceptor active (fetch + XHR patched, watching /hs/graphql) — href:", window.location.href);
  // Expose a quick manual check: run __hsScraperCheck() in console
  try {
    window.__hsScraperCheck = function () {
      return {
        href: window.location.href,
        fetchPatched: window.fetch && window.fetch.toString().indexOf("HS-SCRAPER") !== -1 || "fetch patched (wrapper)",
        targetOp: TARGET_OP,
        graphqlMarker: GRAPHQL_MARKER,
      };
    };
    console.log("[HS-SCRAPER] run __hsScraperCheck() in console to verify patch is alive");
  } catch (_e) {}
})();
