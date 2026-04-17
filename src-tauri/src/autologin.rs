use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const JIEGEHAO_LOGIN_URL: &str = "https://jiegehao.cn/api/policy/password";
const JIEGEHAO_PIT_URL: &str = "https://jiegehao.cn/api/lease/pit";
const JIEGEHAO_GPT_CODE_URL: &str = "https://jiegehao.cn/api/lease/gpt/code";
const AUTOLOGIN_WINDOW_LABEL: &str = "oauth-autologin";

// ── Data structures ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiegehaoAccount {
    pub id: String,
    pub account: String,
    pub password: String,
    #[serde(default)]
    pub status: String, // "pending" | "running" | "success" | "error" | "empty"
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct JiegehaoStore {
    accounts: Vec<JiegehaoAccount>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiegehaoLoginResult {
    pub token: String,
    pub codex_account: String,
    pub codex_password: String,
    pub seat_id: i64,
}

// ── Storage helpers ───────────────────────────────────────────────────────────

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法读取应用目录: {e}"))?;
    if !base.exists() {
        fs::create_dir_all(&base).map_err(|e| format!("无法创建数据目录: {e}"))?;
    }
    Ok(base.join("jiegehao_accounts.json"))
}

fn load_store(app: &AppHandle) -> Result<JiegehaoStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(JiegehaoStore::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取账号文件失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("账号文件格式错误: {e}"))
}

fn save_store(app: &AppHandle, store: &JiegehaoStore) -> Result<(), String> {
    let path = store_path(app)?;
    let raw = serde_json::to_string_pretty(store).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(path, raw).map_err(|e| format!("写入账号文件失败: {e}"))
}

// Minimal percent-encoding for URL query values
fn percent_encode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            _ => {
                use std::fmt::Write as _;
                let _ = write!(result, "%{:02X}", byte);
            }
        }
    }
    result
}

fn emit_autologin_event(app: &AppHandle, event_type: &str, payload: Value) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit(
                "autologin-event",
                json!({ "type": event_type, "payload": payload }),
            )
            .map_err(|e| format!("浜嬩欢杞彂澶辫触: {e}"))?;
    }
    Ok(())
}

// ── Tauri commands: account CRUD ─────────────────────────────────────────────

#[tauri::command]
pub fn autologin_load_accounts(app: AppHandle) -> Result<Vec<JiegehaoAccount>, String> {
    Ok(load_store(&app)?.accounts)
}

#[tauri::command]
pub fn autologin_save_account(
    app: AppHandle,
    account: JiegehaoAccount,
) -> Result<Vec<JiegehaoAccount>, String> {
    let mut store = load_store(&app)?;
    if let Some(existing) = store.accounts.iter_mut().find(|a| a.id == account.id) {
        *existing = account;
    } else {
        store.accounts.push(account);
    }
    save_store(&app, &store)?;
    Ok(store.accounts)
}

#[tauri::command]
pub fn autologin_delete_account(
    app: AppHandle,
    id: String,
) -> Result<Vec<JiegehaoAccount>, String> {
    let mut store = load_store(&app)?;
    store.accounts.retain(|a| a.id != id);
    save_store(&app, &store)?;
    Ok(store.accounts)
}

// ── Tauri commands: jiegehao.cn API ──────────────────────────────────────────

/// Login to jiegehao.cn with the platform account and get the Codex credentials
/// from the active pit (rented ChatGPT/Codex seat).
#[tauri::command]
pub async fn autologin_jiegehao_get_codex(
    account: String,
    password: String,
) -> Result<JiegehaoLoginResult, String> {
    let client = reqwest::Client::new();

    // Step 1 – Login
    let login_resp = client
        .post(JIEGEHAO_LOGIN_URL)
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({ "account": account, "password": password }))
        .send()
        .await
        .map_err(|e| format!("借个号登录请求失败: {e}"))?;

    let login_body: Value = login_resp
        .json()
        .await
        .map_err(|e| format!("借个号登录响应解析失败: {e}"))?;

    if login_body
        .get("code")
        .and_then(Value::as_i64)
        .unwrap_or(-1)
        != 0
    {
        return Err(login_body
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("借个号登录失败")
            .to_string());
    }

    let login_data = login_body
        .get("data")
        .ok_or("借个号登录返回缺少 data")?;
    let token = login_data
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if token.is_empty() {
        return Err("借个号登录成功但未获取到 token".to_string());
    }

    // Step 2 – Fetch pit records (rented accounts)
    let pit_resp = client
        .get(JIEGEHAO_PIT_URL)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("借个号获取账号 pit 失败: {e}"))?;

    let pit_body: Value = pit_resp
        .json()
        .await
        .map_err(|e| format!("借个号 pit 响应解析失败: {e}"))?;

    if pit_body
        .get("code")
        .and_then(Value::as_i64)
        .unwrap_or(-1)
        != 0
    {
        return Err(pit_body
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("获取 pit 账号失败")
            .to_string());
    }

    let pits = pit_body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Find the first pit that has both account and password
    let active_pit = pits.iter().find(|p| {
        let has_account = p
            .get("account")
            .and_then(Value::as_str)
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let has_password = p
            .get("password")
            .and_then(Value::as_str)
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        has_account && has_password
    });

    let pit = active_pit.ok_or("该平台账号下没有可用的 Codex 账号（pit 为空），已跳过")?;

    let codex_account = pit
        .get("account")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let codex_password = pit
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let seat_id = pit.get("seat_id").and_then(Value::as_i64).unwrap_or(0);

    Ok(JiegehaoLoginResult {
        token,
        codex_account,
        codex_password,
        seat_id,
    })
}

/// Fetch the ChatGPT/Codex verification code from jiegehao.cn.
/// Wait ~3 seconds before calling this to ensure the email has been sent.
#[tauri::command]
pub async fn autologin_fetch_code(
    token: String,
    user_name: String,
    seat_id: i64,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let encoded_name = percent_encode(&user_name);
    let url = format!(
        "{JIEGEHAO_GPT_CODE_URL}?user_name={encoded_name}&bus_seat_id={seat_id}"
    );

    let response = client
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("验证码请求失败: {e}"))?;

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("验证码响应解析失败: {e}"))?;

    if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(body
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("验证码获取失败")
            .to_string());
    }

    let code = body
        .get("data")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if code.is_empty() {
        return Err("验证码为空，请重试".to_string());
    }

    Ok(code)
}

// ── Automation window management ─────────────────────────────────────────────

/// Build the initialization script that automates the OpenAI/Codex OAuth login.
/// The script is injected before every page load in the automation webview.
fn build_init_script(codex_account: &str, codex_password: &str) -> String {
    // Safely escape for embedding in a JS string literal
    let escape_js = |s: &str| -> String {
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    };

    let account_js = escape_js(codex_account);
    let password_js = escape_js(codex_password);

    format!(
        r#"
(function() {{
  // Guard: run at most once per page context
  if (window.__CODEX_AUTO_INIT_DONE__) return;
  window.__CODEX_AUTO_INIT_DONE__ = true;

  var ACCOUNT = "{account}";
  var PASSWORD = "{password}";

  /* ── IPC helper ──────────────────────────────────────────────────────── */
  function report(eventType, payload) {{
    try {{
      var internals = window.__TAURI_INTERNALS__;
      if (internals && internals.invoke) {{
        internals.invoke('autologin_webview_report', {{
          eventType: eventType,
          payload: JSON.stringify(payload !== undefined ? payload : null)
        }});
      }}
    }} catch (e) {{
      // Silently ignore if IPC is unavailable (build/test environments)
    }}
  }}

  /* ── Utilities ───────────────────────────────────────────────────────── */
  function sleep(ms) {{
    return new Promise(function(res) {{ setTimeout(res, ms); }});
  }}

  // React / framework-aware value setter
  function setNativeValue(el, value) {{
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (setter && setter.set) {{
      setter.set.call(el, value);
    }} else {{
      el.value = value;
    }}
    el.dispatchEvent(new Event('input',  {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }}

  // Wait for a visible, enabled element matching any of the given selectors
  function waitForEl(selectors, timeoutMs) {{
    var sels = Array.isArray(selectors) ? selectors : [selectors];
    var deadline = Date.now() + (timeoutMs || 15000);
    return new Promise(function(resolve, reject) {{
      function check() {{
        for (var i = 0; i < sels.length; i++) {{
          var el = document.querySelector(sels[i]);
          if (el && !el.disabled && el.offsetParent !== null) {{
            return resolve(el);
          }}
        }}
        if (Date.now() >= deadline) return reject(new Error('timeout: ' + sels[0]));
        setTimeout(check, 300);
      }}
      check();
    }});
  }}

  /* ── Main automation logic ───────────────────────────────────────────── */
  async function run() {{
    try {{
      /* Report page_load immediately (before any sleep) so it always appears in logs */
      var url = window.location.href;
      report('progress', 'page_load:' + url.replace(/[?#].*$/, '').substring(0, 80));

      /* ── 0. Device push-approval page (check FIRST, before any sleep) ── */
      // This page has no email/password inputs. Detect it by looking for the
      // "试试电子邮件" / "Try email" button which is always present on this page.
      // Must run before sleep so it fires even if the page navigates away quickly.
      (function checkDeviceApproval() {{
        var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
        for (var i = 0; i < btns.length; i++) {{
          var t = (btns[i].textContent || btns[i].innerText || '').trim();
          if (t.includes('试试电子邮件') || t.includes('电子邮件') ||
              t.toLowerCase().includes('try email') || t.toLowerCase().includes('use email')) {{
            report('progress', 'device_approval_clicking_email_fallback');
            btns[i].click();
            return;
          }}
        }}
      }})();

      await sleep(800);

      /* ── Shared: fill password input and click submit ────────────────── */
      async function doPasswordStep(pwdEl) {{
        report('progress', 'filling_password');
        setNativeValue(pwdEl, PASSWORD);
        await sleep(600);
        var btn = await waitForEl([
          'button[type="submit"]',
          'button[data-action-button-primary="true"]',
          'button[name="action"]'
        ], 4000).catch(function() {{ return null; }});
        if (btn) {{
          report('progress', 'submit_password');
          btn.click();
          await sleep(500);
        }} else {{
          report('progress', 'password_submit_btn_not_found');
        }}
      }}

      /* ── Shared: watch for post-password SPA states ──────────────────── */
      // After password submit the page may SPA-transition (no new page load) to:
      //   • device push-approval  →  click "试试电子邮件" then keep watching
      //   • check-inbox / OTP     →  emit need_code
      //   • consent               →  click allow
      async function watchPostPassword() {{
        report('progress', 'watching_post_password');
        var deadline = Date.now() + 45000;
        var clickedEmailFallback = false;

        while (Date.now() < deadline) {{
          await sleep(600);
          var pageText = (document.body && document.body.innerText || '').toLowerCase();

          /* --- detect device push-approval page by TEXT (reliable even before buttons render) --- */
          // Unique phrases only present on the "approve on device" page:
          // Chinese: "上批准" / "重新发送提示" / "已向你的设备发送"
          // English: "approve on your" / "sent a push" / "resend push"
          var onDeviceApprovalPage =
            pageText.includes('\u4e0a\u6279\u51c6') ||          /* 上批准 */
            pageText.includes('\u91cd\u65b0\u53d1\u9001\u63d0\u793a') ||  /* 重新发送提示 */
            pageText.includes('\u5df2\u5411\u4f60\u7684\u8bbe\u5907\u53d1\u9001') ||  /* 已向你的设备发送 */
            pageText.includes('\u8bd5\u8bd5\u7535\u5b50\u90ae\u4ef6') ||  /* 试试电子邮件 (button text unique to this page) */
            pageText.includes('approve on your') ||
            pageText.includes('sent a push') ||
            pageText.includes('resend push') ||
            pageText.includes('try email');

          if (onDeviceApprovalPage) {{
            if (!clickedEmailFallback) {{
              /* Try to click "试试电子邮件" button */
              var allBtns2 = Array.prototype.slice.call(document.querySelectorAll('button'));
              var efBtn = null;
              for (var bi = 0; bi < allBtns2.length; bi++) {{
                var bt = (allBtns2[bi].textContent || allBtns2[bi].innerText || '').trim();
                if (bt.includes('\u8bd5\u8bd5\u7535\u5b50\u90ae\u4ef6') || bt.includes('\u7535\u5b50\u90ae\u4ef6') ||
                    bt.toLowerCase().includes('try email') || bt.toLowerCase().includes('use email')) {{
                  efBtn = allBtns2[bi]; break;
                }}
              }}
              if (efBtn) {{
                report('progress', 'device_approval_clicking_email_fallback');
                efBtn.click();
                clickedEmailFallback = true;
                await sleep(1500);
              }}
            }}
            /* Still on device approval page — skip inbox/consent checks */
            continue;
          }}

          /* --- OTP input already visible --- */
          var otpSels = ['input[name="code"]','input[autocomplete="one-time-code"]',
            'input[inputmode="numeric"]','input[type="number"][maxlength]',
            'input[placeholder*="code" i]','input[placeholder*="\u9a8c\u8bc1\u7801" i]'];
          for (var oi = 0; oi < otpSels.length; oi++) {{
            var otpEl2 = document.querySelector(otpSels[oi]);
            if (otpEl2 && otpEl2.offsetParent !== null) {{
              report('need_code', {{ type: 'email' }});
              return;
            }}
          }}

          /* --- check-inbox hint in page text --- */
          // NOTE: do NOT include '验证码' here — the password page has '使用一次性验证码登录'
          // which would cause a false positive before the page has transitioned.
          if (pageText.includes('check your email') || pageText.includes('check your inbox') ||
              pageText.includes('\u68c0\u67e5\u60a8\u7684\u6536\u4ef6\u7bb1') ||
              pageText.includes('\u6536\u4ef6\u7bb1')) {{
            report('need_code', {{ type: 'email' }});
            return;
          }}

          /* --- consent / authorization page --- */
          var cKw = ['authorize','allow','connect','accept','codex','\u6388\u6743','\u7ee7\u7eed'];
          if (cKw.some(function(k) {{ return pageText.includes(k); }})) {{
            var cSels = ['button[data-testid="allow-btn"]','button[name="action"][value="accept"]',
              'button[name="action"][value="allow"]','form button[type="submit"]:not([disabled])',
              'button[class*="allow" i]','button[class*="confirm" i]'];
            var consentFound = null;
            for (var ci = 0; ci < cSels.length; ci++) {{
              var cb = document.querySelector(cSels[ci]);
              if (cb && cb.offsetParent !== null && !cb.disabled) {{ consentFound = cb; break; }}
            }}
            /* text-based fallback: find '继续'/'continue' button, skip '取消' */
            if (!consentFound) {{
              var allB = Array.prototype.slice.call(document.querySelectorAll('button'));
              for (var bi2 = 0; bi2 < allB.length; bi2++) {{
                var bt2 = (allB[bi2].textContent || allB[bi2].innerText || '').trim();
                if ((bt2 === '\u7ee7\u7eed' || bt2.toLowerCase() === 'continue') &&
                    allB[bi2].offsetParent !== null && !allB[bi2].disabled) {{
                  consentFound = allB[bi2]; break;
                }}
              }}
            }}
            if (consentFound) {{
              report('progress', 'clicking_consent');
              consentFound.click();
              await sleep(1500);
              continue; /* keep watching — next page may be device approval or OTP */
            }}
          }}

          /* --- redirected away from auth.openai.com (success) --- */
          var curUrl = window.location.href;
          if (!curUrl.includes('auth.openai.com') &&
              !curUrl.includes('accounts.openai.com')) {{
            report('progress', 'redirected_success:' + curUrl.substring(0, 80));
            return;
          }}
        }}
        report('progress', 'watchPostPassword_timeout');
      }}

      /* ── 1. Password field already visible (direct navigation) ───────── */
      var pwdNow = document.querySelector('input[type="password"], input[name="password"]');
      if (pwdNow && !pwdNow.disabled && !pwdNow.readOnly && pwdNow.offsetParent !== null) {{
        await doPasswordStep(pwdNow);
        await watchPostPassword();
        return;
      }}

      /* ── 2. Email input page ─────────────────────────────────────────── */
      function findWritableEmailInput() {{
        var sels = [
          'input[name="username"]',
          'input[type="email"]',
          'input[autocomplete="email"]',
          'input[autocomplete="username"]',
          'input[id*="email" i]',
          'input[placeholder*="email" i]'
        ];
        for (var i = 0; i < sels.length; i++) {{
          var el = document.querySelector(sels[i]);
          if (el && !el.disabled && !el.readOnly && el.offsetParent !== null) return el;
        }}
        return null;
      }}

      var emailInput = findWritableEmailInput();
      if (!emailInput) {{
        emailInput = await new Promise(function(resolve) {{
          var deadline = Date.now() + 2000;
          function check() {{
            var el = findWritableEmailInput();
            if (el) return resolve(el);
            if (Date.now() >= deadline) return resolve(null);
            setTimeout(check, 200);
          }}
          check();
        }});
      }}

      if (emailInput) {{
        report('progress', 'filling_email');
        setNativeValue(emailInput, ACCOUNT);
        await sleep(600);

        var emailBtn = await waitForEl([
          'button[type="submit"]',
          'button[data-action-button-primary="true"]',
          'button[name="action"]',
          '.continue-btn',
          'button[class*="continue" i]'
        ], 4000).catch(function() {{ return null; }});

        if (emailBtn) {{
          report('progress', 'submit_email');
          emailBtn.click();
        }} else {{
          report('progress', 'email_submit_btn_not_found');
        }}

        /* SPA: wait up to 30s for password field to appear in the same page context */
        var pwdAfter = await waitForEl([
          'input[type="password"]',
          'input[name="password"]'
        ], 30000).catch(function() {{ return null; }});

        if (pwdAfter && !pwdAfter.disabled && pwdAfter.offsetParent !== null) {{
          await doPasswordStep(pwdAfter);
        }} else {{
          report('progress', 'password_field_not_appeared_after_email');
        }}
        await watchPostPassword();
        return;
      }}

      /* ── 3. Device push-approval page → fall back to email OTP ─────── */
      // Appears after password submit when the account has a linked mobile device.
      // We click "试试电子邮件" / "Try email" to switch to email OTP which we can handle.
      // Wait up to 3s for buttons to render (page may still be loading).
      var emailFallbackBtn = await new Promise(function(resolve) {{
        var deadline = Date.now() + 3000;
        function check() {{
          var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
          for (var i = 0; i < btns.length; i++) {{
            var t = (btns[i].textContent || btns[i].innerText || '').trim();
            if (t.includes('试试电子邮件') || t.toLowerCase().includes('try email')) {{
              return resolve(btns[i]);
            }}
          }}
          if (Date.now() >= deadline) return resolve(null);
          setTimeout(check, 200);
        }}
        check();
      }});
      if (emailFallbackBtn) {{
        report('progress', 'device_approval_clicking_email_fallback');
        emailFallbackBtn.click();
        return;
      }}

      /* ── 4. Consent / authorization page ────────────────────────────── */
      var pageText = (document.body && document.body.innerText || '').toLowerCase();
      var consentSelectors = [
        'button[data-testid="allow-btn"]',
        'button[name="action"][value="accept"]',
        'button[name="action"][value="allow"]',
        'form button[type="submit"]:not([disabled])',
        'button[class*="allow" i]',
        'button[class*="confirm" i]'
      ];
      var consentKeywords = ['authorize', 'allow', 'connect', 'accept', 'codex', 'continue', '授权', '继续'];
      var hasConsentKeyword = consentKeywords.some(function(k) {{ return pageText.includes(k); }});

      if (hasConsentKeyword) {{
        var consentBtn = await waitForEl(consentSelectors, 3000).catch(function() {{ return null; }});
        /* text-based fallback: find '继续'/'continue' button, skip '取消' */
        if (!consentBtn) {{
          var allBc = Array.prototype.slice.call(document.querySelectorAll('button'));
          for (var bic = 0; bic < allBc.length; bic++) {{
            var btc = (allBc[bic].textContent || allBc[bic].innerText || '').trim();
            if ((btc === '继续' || btc.toLowerCase() === 'continue') &&
                allBc[bic].offsetParent !== null && !allBc[bic].disabled) {{
              consentBtn = allBc[bic]; break;
            }}
          }}
        }}
        if (consentBtn) {{
          report('progress', 'clicking_consent');
          consentBtn.click();
          await sleep(1000);
          return;
        }}
      }}

      /* ── 5. Device authorization: button to trigger sending OTP ─────── */
      var deviceBtn = document.querySelector(
        'button[value="send-otp"], button[name="action"][value="send-otp"], ' +
        'button[data-action*="send" i], button[class*="send-code" i]'
      );
      if (deviceBtn) {{
        report('progress', 'device_auth_clicking_send');
        deviceBtn.click();
        await sleep(400);
        report('need_code', {{ type: 'device' }});
        return;
      }}

      /* ── 6. OTP / verification code input ───────────────────────────── */
      var otpSelectors = [
        'input[name="code"]',
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[type="number"][maxlength]',
        'input[placeholder*="code" i]',
        'input[placeholder*="验证码" i]'
      ];
      var otpEl = await waitForEl(otpSelectors, 2000).catch(function() {{ return null; }});
      var hasInboxHint = pageText.includes('check your email') ||
                         pageText.includes('check your inbox') ||
                         pageText.includes('verification code') ||
                         pageText.includes('验证码');

      if (otpEl || hasInboxHint) {{
        report('need_code', {{ type: 'email' }});
        return;
      }}

      /* Fall-through: unknown page */
      report('progress', 'unknown_page:' + url.replace(/[?#].*$/, '').substring(0, 80) +
        ' | text:' + pageText.replace(/\s+/g, ' ').substring(0, 120));

    }} catch (err) {{
      report('error', String(err));
    }}
  }}

  /* ── Fill-code helper (called via eval from main app) ────────────────── */
  window.__CODEX_FILL_CODE__ = async function(code) {{
    try {{
      report('progress', 'filling_code');

      var otpInput = await waitForEl([
        'input[name="code"]',
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[type="number"][maxlength]',
        'input[placeholder*="code" i]',
        'input[placeholder*="验证码" i]'
      ], 12000).catch(function() {{ return null; }});

      if (otpInput) {{
        setNativeValue(otpInput, code);
      }} else {{
        // Try individual digit inputs (some UIs split digits)
        var digitEls = document.querySelectorAll(
          'input[inputmode="numeric"][maxlength="1"], input[type="tel"][maxlength="1"]'
        );
        if (digitEls.length >= 1) {{
          for (var i = 0; i < Math.min(digitEls.length, code.length); i++) {{
            setNativeValue(digitEls[i], code[i]);
            await sleep(80);
          }}
        }} else {{
          report('error', 'OTP input not found when filling code');
          return;
        }}
      }}

      await sleep(400);

      var submitBtn = await waitForEl([
        'button[type="submit"]',
        'button[data-action-button-primary="true"]'
      ], 3000).catch(function() {{ return null; }});

      if (submitBtn) {{
        submitBtn.click();
      }}

      await sleep(3000);

      // After code submit, there might be a consent page
      var postText = (document.body && document.body.innerText || '').toLowerCase();
      var postConsentKeywords = ['authorize', 'allow', 'codex', 'connect', '授权'];
      if (postConsentKeywords.some(function(k) {{ return postText.includes(k); }})) {{
        var consentBtn2 = await waitForEl([
          'button[data-testid="allow-btn"]',
          'button[name="action"][value="accept"]',
          'button[name="action"][value="allow"]',
          'form button[type="submit"]:not([disabled])'
        ], 4000).catch(function() {{ return null; }});
        if (consentBtn2) {{
          report('progress', 'clicking_consent_after_code');
          consentBtn2.click();
          await sleep(1000);
        }}
      }}

      report('completed', null);

    }} catch (err) {{
      report('error', String(err));
    }}
  }};

  /* Start on DOM ready */
  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', run);
  }} else {{
    run();
  }}
}})();
"#,
        account = account_js,
        password = password_js
    )
}

// ── Tauri commands: window control ───────────────────────────────────────────

#[tauri::command]
pub fn autologin_open_window(
    app: AppHandle,
    url: String,
    codex_account: String,
    codex_password: String,
) -> Result<(), String> {
    // Close existing window if still open
    if let Some(existing) = app.get_webview_window(AUTOLOGIN_WINDOW_LABEL) {
        // Use destroy() to force-close without triggering the CloseRequested
        // event handler (which on Windows would only hide the window).
        let _ = existing.destroy();
        std::thread::sleep(std::time::Duration::from_millis(600));
    }

    let parsed_url: url::Url = url
        .parse()
        .map_err(|e| format!("无效 OAuth URL: {e}"))?;

    let init_script = build_init_script(&codex_account, &codex_password);
    let navigation_app = app.clone();
    let page_load_app = app.clone();

    WebviewWindowBuilder::new(
        &app,
        AUTOLOGIN_WINDOW_LABEL,
        WebviewUrl::External(parsed_url),
    )
    .title("Codex 自动登录")
    .inner_size(960.0, 720.0)
    .resizable(true)
    // Override the default WebView2 user-agent which contains "WebView2".
    // OpenAI/Codex login pages detect this string and refuse to render
    // (white screen). Using a standard Chrome UA fixes the issue on Windows.
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    .initialization_script(&init_script)
    .on_navigation(move |navigation_url| {
        let _ = emit_autologin_event(
            &navigation_app,
            "progress",
            Value::String(format!("[RUST] navigation -> {navigation_url}")),
        );
        true
    })
    .on_page_load(move |_window, payload| {
        let stage = match payload.event() {
            PageLoadEvent::Started => "started",
            PageLoadEvent::Finished => "finished",
        };
        let _ = emit_autologin_event(
            &page_load_app,
            "progress",
            Value::String(format!("[RUST] page-load:{stage} -> {}", payload.url())),
        );
    })
    .build()
    .map_err(|e| format!("打开自动登录窗口失败: {e}"))?;

    Ok(())
}

/// Evaluate arbitrary JavaScript inside the automation webview.
/// Used to inject the verification code via `window.__CODEX_FILL_CODE__(code)`.
#[tauri::command]
pub fn autologin_eval_window(app: AppHandle, js: String) -> Result<(), String> {
    let window = app
        .get_webview_window(AUTOLOGIN_WINDOW_LABEL)
        .ok_or("自动登录窗口未打开")?;
    window.eval(&js).map_err(|e| format!("脚本执行失败: {e}"))
}

#[tauri::command]
pub fn autologin_close_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(AUTOLOGIN_WINDOW_LABEL) {
        // Use destroy() to force-close the window without triggering the
        // CloseRequested event handler (which on Windows would only hide it).
        window.destroy().map_err(|e| format!("关闭窗口失败: {e}"))?;
    }
    Ok(())
}

/// Called by the initialization script inside the automation webview.
/// Relays the event to the main window so the TypeScript orchestrator can react.
#[tauri::command]
pub fn autologin_webview_report(
    app: AppHandle,
    event_type: String,
    payload: Option<String>,
) -> Result<(), String> {
    let parsed_payload: Value = payload
        .and_then(|p| serde_json::from_str(&p).ok())
        .unwrap_or(Value::Null);

    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .emit(
                "autologin-event",
                json!({ "type": event_type, "payload": parsed_payload }),
            )
            .map_err(|e| format!("事件转发失败: {e}"))?;
    }
    Ok(())
}
