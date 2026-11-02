// BMG approval card: authenticated status recovery, with no executable state in UI snapshots.
export const APPROVAL_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
    }
    body { padding: 2px; }
    #card {
      width: 100%;
      padding: 14px;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: 14px;
      background: color-mix(in srgb, Canvas 95%, currentColor 5%);
      color: CanvasText;
    }
    #title { font-size: 14px; font-weight: 700; line-height: 1.35; }
    #justification { margin-top: 5px; font-size: 13px; line-height: 1.4; }
    .row {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr);
      gap: 8px;
      margin-top: 8px;
      font-size: 12px;
      line-height: 1.35;
    }
    .label { opacity: 0.62; }
    .value { min-width: 0; overflow-wrap: anywhere; }
    #command {
      margin-top: 10px;
      padding: 9px 10px;
      border-radius: 10px;
      background: color-mix(in srgb, currentColor 7%, transparent);
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #status {
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.4;
      opacity: 0.72;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #status[data-error="true"] { opacity: 1; }
    #actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    button {
      border: 0;
      border-radius: 999px;
      padding: 8px 13px;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      color: inherit;
      background: color-mix(in srgb, currentColor 11%, transparent);
    }
    #approve { background: color-mix(in srgb, currentColor 18%, transparent); }
    button:disabled { cursor: default; opacity: 0.45; }
    @media (max-width: 430px) {
      .row { grid-template-columns: 76px minmax(0, 1fr); }
      #card { padding: 12px; }
    }
  </style>
</head>
<body>
  <div id="card">
    <div id="title">BMG approval</div>
    <div id="justification"></div>
    <div class="row"><div class="label">Workspace</div><div class="value" id="workspace"></div></div>
    <div class="row"><div class="label">Tool</div><div class="value" id="tool"></div></div>
    <div class="row"><div class="label">Duration</div><div class="value" id="duration"></div></div>
    <div class="row"><div class="label">Valid until</div><div class="value" id="validUntil"></div></div>
    <div class="row"><div class="label">Approval</div><div class="value" id="environment"></div></div>
    <div id="command"></div>
    <div id="status" aria-live="polite">Waiting for your decision.</div>
    <div id="actions">
      <button id="deny" type="button" disabled>Deny</button>
      <button id="approve" type="button" disabled>Approve</button>
    </div>
  </div>
  <script>
    (() => {
      const PROTOCOL_VERSION = "2026-01-26";
      const pending = new Map();
      let nextId = 1;
      let approval = null;
      let approvalNonce = null;
      let busy = false;
      let verified = false;
      let bridgeInitialized = false;
      let finalOutcome = null;
      let hostCapabilities = {};
      let queryGeneration = 0;
      let continuationStarted = false;

      const title = document.getElementById("title");
      const justification = document.getElementById("justification");
      const workspace = document.getElementById("workspace");
      const tool = document.getElementById("tool");
      const duration = document.getElementById("duration");
      const validUntil = document.getElementById("validUntil");
      const environment = document.getElementById("environment");
      const command = document.getElementById("command");
      const status = document.getElementById("status");
      const approve = document.getElementById("approve");
      const deny = document.getElementById("deny");

      function post(message) {
        window.parent.postMessage(message, "*");
      }

      function request(method, params, timeoutMs = 30000) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(method + " timed out"));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          post({ jsonrpc: "2.0", id, method, params });
        });
      }

      function toolEnvelope() {
        const metadata = window.openai?.toolResponseMetadata;
        return metadata && (
          metadata.mcp_tool_result || metadata.call_tool_result
        ) || null;
      }

      function formatDuration(seconds) {
        const value = Number(seconds || 0);
        if (value % 86400 === 0) return (value / 86400) + " day" + (value === 86400 ? "" : "s");
        if (value % 3600 === 0) return (value / 3600) + " hour" + (value === 3600 ? "" : "s");
        if (value % 60 === 0) return (value / 60) + " minute" + (value === 60 ? "" : "s");
        return value + " seconds";
      }

      function formatDeadline(value) {
        if (!value) return "Unknown";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }

      function readInitialResult(result = null) {
        const envelope = result || toolEnvelope();
        const structured = envelope?.structuredContent ||
          window.openai?.toolOutput || null;
        const hidden = envelope?._meta || {};
        if (!structured) return false;
        if (approval && structured.approval_id !== approval.approval_id) return false;
        approval = structured;
        approvalNonce = hidden.approval_nonce || approvalNonce || null;
        title.textContent = "BMG requests timed full access";
        justification.textContent = structured.action_summary ||
          "Approve this frozen owner action and temporarily allow BMG operations?";
        workspace.textContent = structured.scope_id || "BMG browser";
        tool.textContent = structured.tool_name || "Unknown";
        duration.textContent = formatDuration(structured.requested_duration_seconds);
        validUntil.textContent = formatDeadline(structured.card_expires_at);
        environment.textContent = structured.approval_id || "Unknown";
        command.textContent =
          "Approving grants access to all public BMG browser tools for " +
          formatDuration(structured.requested_duration_seconds) +
          ". OAuth authentication and BMG workspace ownership checks still apply.";
        approve.textContent = "Approve " + formatDuration(structured.requested_duration_seconds);
        if (!structured.approval_id) return false;
        if (!approvalNonce) {
          if (structured.classification === "approval_already_bound") {
            setStatus("This approval is already bound to its existing card. Use that card to approve or deny.", true);
          } else if (structured.state === "expired") {
            setStatus("This approval has expired. The frozen action was not dispatched.", true);
          } else if (structured.state === "superseded") {
            setStatus("This approval was invalidated by a BMG approval-policy change.", true);
          } else {
            setStatus("Approval token is unavailable in this host.", true);
          }
        }
        approve.disabled = true;
        deny.disabled = true;
        if (approvalNonce) restoreWidgetSnapshot();
        if (bridgeInitialized) void verifyCardState();
        updateHeight();
        return true;
      }

      function updateHeight() {
        try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
      }

      function setStatus(text, error = false) {
        status.textContent = text || "";
        status.dataset.error = error ? "true" : "false";
        updateHeight();
      }

      function setBusy(value) {
        busy = value;
        approve.disabled = value || !verified || Boolean(finalOutcome) || !approvalNonce;
        deny.disabled = value || !verified || Boolean(finalOutcome) || !approvalNonce;
      }

      const terminalStates = new Set([
        "consumed", "denied", "expired", "superseded",
        "execution_unknown", "approved_retryable"
      ]);

      function isTerminal(value) {
        return Boolean(value && terminalStates.has(value.state));
      }

      function terminalMessage(value, unverified = false) {
        let message;
        if (value.state === "denied") message = "Denied. The frozen action was not dispatched.";
        else if (value.state === "expired") message = "This approval expired. The frozen action was not dispatched.";
        else if (value.state === "superseded") message = "This approval was invalidated by a policy change.";
        else if (value.state === "execution_unknown") message = "Approved. Owner action outcome is unknown; it will not be automatically retried.";
        else if (value.state === "approved_retryable") message = "Approved. Owner action was not dispatched; the grant is not a new approval request.";
        else if (value.action_failed) message = "Approved, but the owner action failed.";
        else message = "Approved. The owner action was handled.";
        if (value.result_unavailable) message += " Archived decision; owner action output is unavailable.";
        if (value.grant_active) message += " Timed BMG access is currently active.";
        if (unverified) message += " Saved card state; live verification through this card is unavailable. No action will be retried.";
        return message;
      }

      function renderTerminal(value, { unverified = false } = {}) {
        finalOutcome = value;
        verified = false;
        busy = false;
        approve.disabled = true;
        deny.disabled = true;
        setStatus(terminalMessage(value, unverified), Boolean(value.action_failed) || unverified);
      }

      function saveWidgetSnapshot(value) {
        if (typeof window.openai?.setWidgetState !== "function" || !isTerminal(value)) return;
        const snapshot = {
          version: 1,
          approval_id: approval.approval_id,
          operation_id: approval.operation_id,
          state: value.state,
          action_failed: value.action_failed === true
        };
        try {
          Promise.resolve(window.openai.setWidgetState(snapshot)).catch(() => {});
        } catch {}
      }

      function restoreWidgetSnapshot() {
        const saved = window.openai?.widgetState;
        if (saved?.version === 1 &&
            saved.approval_id === approval?.approval_id &&
            saved.operation_id === approval?.operation_id &&
            isTerminal(saved)) {
          renderTerminal(saved, { unverified: true });
        }
      }

      async function verifyCardState() {
        if (!bridgeInitialized || !approval?.approval_id) return;
        if (!approvalNonce) {
          verified = false;
          setBusy(false);
          setStatus("Approval capability unavailable. This card cannot approve.", true);
          return;
        }
        const generation = ++queryGeneration;
        verified = false;
        setBusy(false);
        try {
          const response = await request("tools/call", {
            name: "get_approval_status",
            arguments: {
              approval_id: approval.approval_id,
              approval_nonce: approvalNonce
            }
          }, 12000);
          if (generation !== queryGeneration) return;
          const value = response?.structuredContent;
          if (response?.isError || !value ||
              value.approval_id !== approval.approval_id ||
              value.operation_id !== approval.operation_id ||
              value.kind !== "approval" ||
              (value.scope_id && value.scope_id !== approval.scope_id) ||
              (value.tool_name && value.tool_name !== approval.tool_name)) {
            throw new Error("Approval identity or status verification failed");
          }
          if (isTerminal(value)) {
            renderTerminal(value);
            if (!value.result_unavailable) saveWidgetSnapshot(value);
          } else if (value.state === "pending") {
            finalOutcome = null;
            verified = true;
            busy = false;
            setBusy(false);
            setStatus("Waiting for your decision.");
          } else {
            setStatus("Approval is being processed. Reopen this card to check its result.");
          }
        } catch {
          if (generation !== queryGeneration) return;
          if (isTerminal(finalOutcome)) renderTerminal(finalOutcome, { unverified: true });
          else setStatus("Approval status cannot be verified. This card cannot approve again.", true);
        }
      }

      function resultSummary(structured) {
        return {
          source: "bmg.approval",
          approval_id: structured?.approval_id,
          operation_id: structured?.operation_id,
          state: structured?.state,
          grant_active: structured?.grant_active,
          grant_state: structured?.grant_state,
          grant_approval_id: structured?.grant_approval_id,
          grant_expires_at: structured?.grant_expires_at,
          requested_duration_seconds: structured?.requested_duration_seconds,
          card_expires_at: structured?.card_expires_at,
          terminal_reason: structured?.terminal_reason,
          action_state: structured?.action_state,
          action_failed: structured?.action_failed,
          output: typeof structured?.output === "string"
            ? structured.output.slice(0, 12000)
            : ""
        };
      }

      async function notifyModel(decision, structured) {
        if (continuationStarted) return;
        continuationStarted = true;
        const summary = {
          ...resultSummary(structured),
          decision
        };
        const contextText = decision === "deny"
          ? "The user denied the frozen BMG action. Do not run it."
          : "The user approved the frozen BMG browser action and timed full-access grant. BMG handled the owner action; do not recreate or rerun it. Pass this approval_id on later public BMG browser tool calls to reuse this grant. Omit approval_id to request another independent grant.";
        try {
          await request("ui/update-model-context", {
            content: [{
              type: "text",
              text: contextText
            }],
            structuredContent: summary
          }, 10000);
        } catch {
          setStatus(terminalMessage(structured) +
            " ChatGPT context handoff failed. Send a message to continue.", true);
          return;
        }

        const prompt = decision === "deny"
          ? "Continue from the BMG denial result already placed in model context. Do not recreate or run the frozen action."
          : "Continue from the BMG approval result already placed in model context. BMG handled the frozen owner action. Reuse this grant by passing its approval_id on later public BMG browser tool calls; omit approval_id to request another independent grant.";
        if (hostCapabilities?.message?.text) {
          try {
            const response = await request("ui/message", {
              role: "user",
              content: [{ type: "text", text: prompt }]
            }, 10000);
            if (response?.isError !== true) return;
          } catch {}
        }
        if (typeof window.openai?.sendFollowUpMessage === "function") {
          try {
            await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: false });
            return;
          } catch {}
        }
        setStatus(terminalMessage(structured) +
          " ChatGPT did not continue automatically. Send a message to continue.", true);
      }

      async function resolve(decision) {
        if (busy || !verified || finalOutcome || !approval || !approvalNonce) return;
        verified = false;
        queryGeneration++;
        setBusy(true);
        setStatus(decision === "deny" ? "Denying request..." : "Applying approval...");
        try {
          const result = await request("tools/call", {
            name: "resolve_pending_action",
            arguments: {
              approval_id: approval.approval_id,
              approval_nonce: approvalNonce,
              decision
            }
          }, 120000);
          const structured = result?.structuredContent || {};
          if (result?.isError === true ||
              structured.approval_id !== approval.approval_id ||
              structured.operation_id !== approval.operation_id ||
              !isTerminal(structured)) {
            throw new Error("Approval response requires verification");
          }
          approval = { ...approval, ...structured };
          if (structured.state === "approved_retryable") {
            setStatus((structured.output || "The owner action was not dispatched.") +
              " The timed BMG grant remains active; pass this approval_id on later public BMG browser tool calls.", true);
          } else if (structured.state === "execution_unknown") {
            setStatus((structured.output || "Execution outcome is unknown. BMG will not retry automatically.") +
              " The timed BMG grant remains active.", true);
          } else if (structured.action_failed) {
            setStatus((structured.output || "The approved owner action failed.") +
              " The timed BMG grant remains active.", true);
          } else if (structured.state === "denied") {
            setStatus("Denied. The frozen action was not dispatched.");
          } else if (structured.state === "expired") {
            setStatus("This approval card expired before it was resolved. The frozen action was not dispatched.", true);
          } else if (structured.state === "superseded") {
            setStatus("This approval was invalidated by a BMG approval-policy change. The frozen action was not dispatched.", true);
          } else {
            setStatus(structured.output || "Approved. Timed BMG access is active.");
          }
          renderTerminal(structured);
          saveWidgetSnapshot(structured);
          void notifyModel(decision, structured);
        } catch (error) {
          setStatus(
            "Approval outcome needs verification: " +
              String(error && error.message ? error.message : error),
            true
          );
          busy = false;
          verified = false;
          approve.disabled = true;
          deny.disabled = true;
          void verifyCardState();
        }
      }

      approve.addEventListener("click", () => { void resolve("approve"); });
      deny.addEventListener("click", () => { void resolve("deny"); });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) {
            waiter.reject(new Error(message.error.message || "MCP Apps request failed"));
          } else {
            waiter.resolve(message.result);
          }
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          readInitialResult(message.params || null);
        }
      });

      window.addEventListener("openai:set_globals", () => {
        readInitialResult();
      });

      async function initialize() {
        try {
          const initialized = await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: {
              name: "bmg-approval",
              title: "BMG approval",
              version: "2.0.0"
            },
            appCapabilities: {}
          }, 5000);
          hostCapabilities = initialized?.hostCapabilities || {};
          const alreadyLoaded = Boolean(approval?.approval_id);
          bridgeInitialized = true;
          post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
          if (!readInitialResult()) {
            setStatus("Waiting for approval details.");
            if (alreadyLoaded) void verifyCardState();
          } else if (alreadyLoaded && !approvalNonce) {
            void verifyCardState();
          }
        } catch (error) {
          setStatus(
            "Approval card initialization failed: " +
              String(error && error.message ? error.message : error),
            true
          );
        }
      }

      void initialize();
    })();
  </script>
</body>
</html>`;

export const APPROVAL_UI_URI = 'ui://bmg/approval-v2.html';
