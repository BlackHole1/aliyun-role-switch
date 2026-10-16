// ==UserScript==
// @name         Aliyun Role Switch
// @name:zh-CN   阿里云控制台一键切换身份
// @namespace    https://github.com/BlackHole1
// @version      4.1.0
// @description  Switch the Aliyun console to a preconfigured RAM role and back with one click.
// @description:zh-CN 在阿里云控制台一键切换到预先配置的 RAM 角色，再一键切回登录身份。
// @license      MIT
// @homepageURL  https://github.com/BlackHole1/aliyun-role-switch
// @supportURL   https://github.com/BlackHole1/aliyun-role-switch/issues
// @updateURL    https://raw.githubusercontent.com/BlackHole1/aliyun-role-switch/main/aliyun-role-switch.user.js
// @downloadURL  https://raw.githubusercontent.com/BlackHole1/aliyun-role-switch/main/aliyun-role-switch.user.js
// @match        https://*.aliyun.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

// 使用方法 (支持 Tampermonkey、Violentmonkey，不支持 Greasemonkey 4):
// 1. 打开任意阿里云控制台页面，点左侧边缘的「配置切换身份」(或 Tampermonkey 菜单里的「设置切换身份」)，
//    填入要切换的主账号 UID (或企业别名、默认域名) 和角色名，可以配置多个
// 2. 按钮平时收在页面边缘，只露出一个带箭头的小标签:
//    - 点一下小标签: 展开按钮，再点一下 (或按 Esc) 收起
//    - 按住小标签拖动: 调整位置，会吸附到左右边缘 (Tampermonkey 菜单里可以「重置按钮位置」)
// 3. 展开后的按钮:
//    - 直接点击: 在当前页切换，完成后刷新
//    - Command (Windows 上是 Ctrl) 加点击: 切换后在新标签页打开当前地址
//    - 配置了多个身份时，点按钮会先弹出身份列表
//
// 实现说明:
// - 切换接口的请求体里有防机器人脚本实时生成的参数，没法在别处直接调接口，
//   所以在隐藏 iframe 里加载官方「切换身份」页面并提交 (页面 CSP 允许 *.aliyun.com 嵌入)
// - 官方页面拿到结果后要等 1 秒多才跳转，这里拦截它的 fetch 拿到 session.htm 地址，
//   自己请求一次把会话 cookie 写好
// - 是否完成看 .aliyun.com 下的 login_aliyunid cookie 有没有变化
// - @grant 让脚本跑在沙箱里: 页面 CSP 很严，Firefox 上 @grant none 的脚本可能注入不进去

(function () {
  "use strict";

  const SWITCH_URL = "https://signin.aliyun.com/switchRole.htm";
  const EXIT_URL = "https://signin.aliyun.com/exitSwitchedRole.htm";
  const SIGNIN_ORIGIN = "https://signin.aliyun.com";
  const FRAME_PREFIX = "aliyun-role-switch-frame:";
  const STORAGE_KEY = "identities";
  const TIMEOUT_MS = 20 * 1000;
  const NEW_TAB_TIP = "Command/Ctrl + 点击: 在新标签页打开";
  const POSITION_KEY = "dockPosition";
  const DEFAULT_POSITION = { edge: "left", ratio: 0.85 };
  const DRAG_THRESHOLD_PX = 5;

  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  function waitFor(fn, timeoutMs, intervalMs = 50) {
    return new Promise((resolve) => {
      const begin = Date.now();
      const timer = setInterval(() => {
        const value = fn();
        if (value || Date.now() - begin > timeoutMs) {
          clearInterval(timer);
          resolve(value || null);
        }
      }, intervalMs);
    });
  }

  function encode(data) {
    return JSON.stringify({ source: FRAME_PREFIX, ...data });
  }

  function decode(event, expectedOrigin) {
    if (expectedOrigin ? event.origin !== expectedOrigin : !/^https:\/\/([a-z0-9-]+\.)*aliyun\.com$/.test(event.origin)) {
      return null;
    }
    if (typeof event.data !== "string") return null;
    try {
      const data = JSON.parse(event.data);
      return data.source === FRAME_PREFIX ? data : null;
    } catch {
      return null;
    }
  }

  // ---------- 配置 ----------

  function loadIdentities() {
    const list = GM_getValue(STORAGE_KEY, []);
    return Array.isArray(list) ? list.filter((item) => item && item.account && item.role) : [];
  }

  function identityLabel(item) {
    return item.label || `${item.role} @ ${item.account}`;
  }

  // 当前身份读 .aliyun.com 下的 login_aliyunid cookie，所有控制台都能读到:
  // RAM 用户形如 "alice @ 1234567890"，角色形如 "admin/alice @ dev-env"
  function currentIdentity() {
    const match = document.cookie.match(/(?:^|;\s*)login_aliyunid=([^;]*)/);
    if (!match) return null;
    const label = decodeURIComponent(match[1]).replace(/^"|"$/g, "").trim();
    if (!label) return null;
    return { isRole: label.split("@")[0].includes("/"), label };
  }

  // ---------- 隐藏 iframe 里: 官方切换页面 ----------

  function setInputValue(input, value) {
    // 页面是 React 受控组件，直接赋值不会触发状态更新
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function runInFrame(nonce) {
    if (location.origin !== SIGNIN_ORIGIN || location.pathname !== "/switchRole.htm") return;
    const post = (data) => window.parent.postMessage(encode({ nonce, ...data }), "*");
    const originalFetch = pageWindow.fetch;
    // Firefox 沙箱里要用 exportFunction / cloneInto 才能把函数和对象交给页面
    const toPage = (value) =>
      typeof value === "function"
        ? typeof exportFunction === "function" ? exportFunction(value, pageWindow) : value
        : typeof cloneInto === "function" ? cloneInto(value, pageWindow) : value;

    let active = false;
    const onResult = (result) => {
      const redirect = result && result.ResultData && result.ResultData.RedirectAddress;
      if (redirect) {
        originalFetch
          .call(pageWindow, redirect, toPage({ credentials: "include", redirect: "manual" }))
          .catch(() => {}); // 失败也没关系，官方页面稍后会自己跳转
        return;
      }
      const needCaptcha = result && result.ResultContext && result.ResultContext.NcNeed === "true";
      post({
        status: "error",
        message: needCaptcha
          ? "阿里云要求人机验证，请用控制台右上角的「切换身份」手动切换一次"
          : (result && (result.ErrorMessage || result.ResultCode)) || "切换接口返回了未知结果",
      });
    };

    try {
      pageWindow.fetch = toPage(function (input, init) {
        const promise = originalFetch.call(pageWindow, input, init);
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (active && url.includes("V2SwitchToRole")) {
          promise.then((response) => response.clone().json()).then(onResult, () => {});
        }
        return promise;
      });
    } catch {
      // 拦截不了就等官方页面自己跳转，只是慢一点
    }

    window.addEventListener("message", async (event) => {
      const data = decode(event);
      if (!data || data.nonce !== nonce || data.command !== "switch") return;
      const form = await waitFor(() => {
        const alias = document.getElementById("alias");
        const role = document.getElementById("role");
        const submit = document.querySelector('form button[type="submit"]');
        return alias && role && submit ? { alias, role, submit } : null;
      }, 10000);
      if (!form) {
        post({ status: "error", message: "没有找到切换身份的表单" });
        return;
      }
      setInputValue(form.alias, data.account);
      setInputValue(form.role, data.role);
      active = true;
      form.submit.click();
    });

    post({ status: "ready" });
  }

  // ---------- 顶层控制台页面: 切换逻辑 ----------

  function createHiddenFrame(name, src) {
    const iframe = document.createElement("iframe");
    if (name) iframe.name = name;
    iframe.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;visibility:hidden;";
    iframe.src = src;
    document.body.appendChild(iframe);
    return iframe;
  }

  // 预加载的切换页面，每次切换后换一个新的
  let switchFrame = null;
  function prepareSwitchFrame() {
    if (switchFrame) return switchFrame;
    const nonce = Math.random().toString(36).slice(2);
    const iframe = createHiddenFrame(FRAME_PREFIX + nonce, SWITCH_URL);
    const ready = new Promise((resolve) => {
      const onMessage = (event) => {
        const data = decode(event, SIGNIN_ORIGIN);
        if (!data || data.nonce !== nonce || data.status !== "ready") return;
        window.removeEventListener("message", onMessage);
        resolve();
      };
      window.addEventListener("message", onMessage);
    });
    switchFrame = { iframe, nonce, ready };
    return switchFrame;
  }

  function discardSwitchFrame() {
    if (switchFrame) switchFrame.iframe.remove();
    switchFrame = null;
  }

  // 完成的标志统一用身份 cookie 变化来判断，不等 iframe 加载控制台首页
  function waitIdentityChange(before, onError) {
    return new Promise((resolve, reject) => {
      const begin = Date.now();
      const timer = setInterval(() => {
        const now = currentIdentity();
        if (now && now.label !== before.label) {
          clearInterval(timer);
          resolve(now);
        } else if (Date.now() - begin > TIMEOUT_MS) {
          clearInterval(timer);
          reject(new Error("切换超时"));
        }
      }, 50);
      onError((error) => {
        clearInterval(timer);
        reject(error);
      });
    });
  }

  async function switchToRole(target, before) {
    const frame = prepareSwitchFrame();
    let onFrameError = null;
    const onMessage = (event) => {
      const data = decode(event, SIGNIN_ORIGIN);
      if (data && data.nonce === frame.nonce && data.status === "error" && onFrameError) {
        onFrameError(new Error(data.message));
      }
    };
    window.addEventListener("message", onMessage);
    try {
      await Promise.race([
        frame.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("切换页面加载超时")), TIMEOUT_MS)),
      ]);
      const changed = waitIdentityChange(before, (fail) => (onFrameError = fail));
      frame.iframe.contentWindow.postMessage(
        encode({ nonce: frame.nonce, command: "switch", account: target.account, role: target.role }),
        SIGNIN_ORIGIN,
      );
      await changed;
    } finally {
      window.removeEventListener("message", onMessage);
      discardSwitchFrame();
    }
  }

  // 返回登录身份必须是页面导航，用 fetch 请求会被当成未登录并让会话失效
  async function exitRole(before) {
    const iframe = createHiddenFrame(null, EXIT_URL);
    try {
      await waitIdentityChange(before, () => {});
    } finally {
      iframe.remove();
    }
  }

  // ---------- 顶层控制台页面: 界面 ----------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 12px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .dock { position: fixed; z-index: 2147483646; display: flex; align-items: center; gap: 10px; transform: translateY(-50%); pointer-events: none; user-select: none; -webkit-user-select: none; }
    .dock[data-edge="left"] { left: 0; }
    .dock[data-edge="right"] { right: 0; flex-direction: row-reverse; }
    .tab { pointer-events: auto; touch-action: none; width: 14px; height: 44px; padding: 0; border: none; color: #fff; cursor: grab; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,.2); opacity: .7; transition: width .15s, margin .15s, opacity .15s; }
    .dock[data-edge="left"] .tab { border-radius: 0 8px 8px 0; }
    .dock[data-edge="right"] .tab { border-radius: 8px 0 0 8px; }
    .tab:hover, .tab:focus-visible, .dock:not(.collapsed) .tab, .dock.dragging .tab { opacity: 1; }
    /* 悬停时标签加宽，更容易点中；用负 margin 抵消，展开的按钮不会跟着移动 */
    .tab:hover, .dock.dragging .tab { width: 24px; }
    .dock[data-edge="left"] .tab:hover, .dock[data-edge="left"].dragging .tab { margin-right: -10px; }
    .dock[data-edge="right"] .tab:hover, .dock[data-edge="right"].dragging .tab { margin-left: -10px; }
    .dock.dragging .tab { cursor: grabbing; }
    .arrow { width: 6px; height: 6px; border: solid currentColor; border-width: 0 2px 2px 0; transition: transform .2s; }
    .dock[data-edge="left"].collapsed .arrow, .dock[data-edge="right"]:not(.collapsed) .arrow { transform: translateX(-1px) rotate(-45deg); }
    .dock[data-edge="right"].collapsed .arrow, .dock[data-edge="left"]:not(.collapsed) .arrow { transform: translateX(1px) rotate(135deg); }
    .body { pointer-events: auto; position: relative; transition: opacity .15s, transform .15s, visibility 0s; }
    .dock.collapsed .body, .dock.dragging .body { pointer-events: none; visibility: hidden; opacity: 0; transform: translateX(-8px); transition: opacity .15s, transform .15s, visibility 0s .15s; }
    .dock[data-edge="right"].collapsed .body, .dock[data-edge="right"].dragging .body { transform: translateX(8px); }
    .main { display: block; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 6px 12px; border: none; border-radius: 16px; color: #fff; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    .dock.busy .main { cursor: wait; opacity: .7; }
    .menu { position: absolute; bottom: calc(100% + 6px); left: 0; background: #fff; color: #333; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.18); padding: 4px; min-width: 200px; width: max-content; max-width: 60vw; }
    .dock[data-edge="right"] .menu { left: auto; right: 0; }
    .dock.menu-down .menu { bottom: auto; top: calc(100% + 6px); }
    .menu button { display: block; width: 100%; text-align: left; padding: 6px 10px; border: none; background: none; border-radius: 6px; cursor: pointer; color: #333; }
    .menu button:hover { background: #f2f3f5; }
    .menu .hint { padding: 4px 10px; color: #999; border-top: 1px solid #eee; margin-top: 4px; }
    .mask { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; }
    .panel { background: #fff; color: #333; border-radius: 10px; padding: 18px 20px; width: 640px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto; box-shadow: 0 8px 32px rgba(0,0,0,.25); }
    .title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
    .desc { color: #666; margin-bottom: 12px; }
    .row { display: grid; grid-template-columns: 1fr 1.4fr 1fr 36px; gap: 8px; margin-bottom: 8px; align-items: center; }
    .row.head { color: #999; margin-bottom: 4px; }
    input { width: 100%; padding: 5px 8px; border: 1px solid #d0d3d9; border-radius: 6px; color: #333; background: #fff; }
    input:focus { outline: none; border-color: #ff6a00; }
    .link { border: none; background: none; color: #0064c8; cursor: pointer; padding: 4px 0; }
    .error { color: #d93026; min-height: 18px; margin-top: 6px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
    .btn { padding: 5px 14px; border-radius: 6px; border: 1px solid #d0d3d9; background: #fff; color: #333; cursor: pointer; }
    .btn.primary { background: #ff6a00; border-color: #ff6a00; color: #fff; }
  `;

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  function createRoot() {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.appendChild(el("style", { text: STYLE }));
    document.body.appendChild(host);
    return root;
  }

  function openSettings(root, onSaved) {
    if (root.querySelector(".mask")) return;
    const rows = el("div");
    const error = el("div", { class: "error" });

    const addRow = (item = {}) => {
      const row = el("div", { class: "row" }, [
        el("input", { "data-field": "label", placeholder: "例如 dev admin" }),
        el("input", { "data-field": "account", placeholder: "例如 1234567890123456" }),
        el("input", { "data-field": "role", placeholder: "例如 admin" }),
        el("button", { class: "link", text: "删除", onclick: () => row.remove() }),
      ]);
      for (const input of row.querySelectorAll("input")) input.value = item[input.dataset.field] || "";
      rows.appendChild(row);
      return row;
    };

    const saved = loadIdentities();
    (saved.length ? saved : [{}]).forEach((item) => addRow(item));

    const close = () => mask.remove();
    const save = () => {
      const list = [];
      for (const row of rows.children) {
        const item = {};
        for (const input of row.querySelectorAll("input")) item[input.dataset.field] = input.value.trim();
        if (!item.label && !item.account && !item.role) continue;
        if (!item.account || !item.role) {
          error.textContent = "每一行的主账号和角色名都要填写";
          return;
        }
        list.push(item);
      }
      GM_setValue(STORAGE_KEY, list);
      close();
      onSaved();
    };

    const mask = el("div", { class: "mask", onclick: (event) => event.target === mask && close() }, [
      el("div", { class: "panel" }, [
        el("div", { class: "title", text: "阿里云切换身份设置" }),
        el("div", {
          class: "desc",
          text: "填写要切换到的 RAM 角色，和控制台「切换身份」页面填的内容一致。显示名称可以不填。配置只保存在本机的脚本管理器里。",
        }),
        el("div", { class: "row head" }, [
          el("div", { text: "显示名称" }),
          el("div", { text: "主账号 UID / 企业别名 / 默认域名" }),
          el("div", { text: "角色名" }),
          el("div"),
        ]),
        rows,
        el("button", { class: "link", text: "+ 添加身份", onclick: () => addRow().querySelector("input").focus() }),
        error,
        el("div", { class: "actions" }, [
          el("button", { class: "btn", text: "取消", onclick: close }),
          el("button", { class: "btn primary", text: "保存", onclick: save }),
        ]),
      ]),
    ]);
    // 不让按键冒泡到控制台页面，免得触发页面自己的快捷键
    mask.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") close();
      if (event.key === "Enter" && event.target.tagName === "INPUT") save();
    });
    root.appendChild(mask);
    rows.querySelector("input").focus();
  }

  function loadPosition() {
    const value = GM_getValue(POSITION_KEY, null);
    if (value && (value.edge === "left" || value.edge === "right") && value.ratio >= 0 && value.ratio <= 1) {
      return value;
    }
    return DEFAULT_POSITION;
  }

  function renderDock(root) {
    const menu = el("div", { class: "menu" });
    const main = el("button", { class: "main" });
    const tab = el("button", { class: "tab", "aria-label": "阿里云切换身份" }, [el("span", { class: "arrow" })]);
    const body = el("div", { class: "body" }, [menu, main]);
    const dock = el("div", { class: "dock collapsed" }, [tab, body]);
    root.appendChild(dock);

    let identity = null;
    let identities = [];
    let busy = false;
    let position = loadPosition();
    let drag = null;
    let suppressClick = false;

    const hideMenu = () => (menu.style.display = "none");
    const menuOpen = () => menu.style.display !== "none";

    // 停靠在左右边缘，纵向位置按视口高度的比例保存，窗口大小变了也不会跑出屏幕
    const place = () => {
      dock.dataset.edge = position.edge;
      const y = Math.min(Math.max(position.ratio * innerHeight, 32), innerHeight - 32);
      dock.style.top = `${y}px`;
      dock.classList.toggle("menu-down", y < innerHeight / 2);
    };

    // 平时只露出边缘的小标签，点一下展开，再点一下收起，不会自己收回去
    const setExpanded = (expanded) => {
      if (!expanded) hideMenu();
      dock.classList.toggle("collapsed", !expanded);
    };

    // 身份 cookie 和配置都是全局的，每次都重新读: 别的标签页里切换过身份或改过配置，
    // 回到这个页面时按钮也要跟着变
    const refresh = () => {
      if (busy || drag) return;
      identity = currentIdentity();
      identities = loadIdentities();
      position = loadPosition();
      place();
      hideMenu();
      if (!identity) {
        dock.style.display = "none";
        return;
      }
      dock.style.display = "";
      let color = "#ff6a00";
      if (identity.isRole) {
        main.textContent = `返回登录身份 (当前 ${identity.label})`;
        main.title = NEW_TAB_TIP;
        color = "#0064c8";
      } else if (identities.length === 0) {
        main.textContent = "配置切换身份";
        main.title = "";
        color = "#8a8f99";
      } else if (identities.length === 1) {
        main.textContent = `切到 ${identityLabel(identities[0])}`;
        main.title = `${identities[0].account} / ${identities[0].role}\n${NEW_TAB_TIP}`;
      } else {
        main.textContent = "切换身份";
        main.title = "";
      }
      tab.style.background = main.style.background = color;
      tab.title = `${main.textContent}\n按住拖动可以调整位置`;
    };

    const isNewTabClick = (event) => event.metaKey || event.ctrlKey;

    const run = async (action, inNewTab) => {
      hideMenu();
      setExpanded(true);
      busy = true;
      dock.classList.add("busy");
      main.textContent = "切换中...";
      // 新标签页要在点击时同步打开，异步回调里再开会被拦截弹窗
      const newTab = inNewTab ? window.open("about:blank", "_blank") : null;
      const done = () => {
        busy = false;
        dock.classList.remove("busy");
        refresh();
      };
      try {
        await action();
      } catch (error) {
        if (newTab) newTab.close();
        done();
        alert(`阿里云身份切换失败: ${error.message}`);
        return;
      }
      if (!inNewTab) {
        location.reload();
        return;
      }
      done();
      if (newTab && !newTab.closed) {
        newTab.location.href = location.href;
      } else {
        window.open(location.href, "_blank");
      }
    };

    const showMenu = () => {
      menu.replaceChildren(
        ...identities.map((item) =>
          el("button", {
            text: identityLabel(item),
            title: `${item.account} / ${item.role}`,
            onclick: (event) => run(() => switchToRole(item, identity), isNewTabClick(event)),
          }),
        ),
        el("div", { class: "hint", text: NEW_TAB_TIP }),
      );
      menu.style.display = "";
    };

    // 按住标签拖动调整位置: 移动超过几个像素才算拖动，跟着鼠标吸附到较近的左右边缘
    tab.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || busy) return;
      drag = { x: event.clientX, y: event.clientY, moved: false };
      tab.setPointerCapture(event.pointerId);
    });
    tab.addEventListener("pointermove", (event) => {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        hideMenu();
        dock.classList.add("dragging");
      }
      position = {
        edge: event.clientX < innerWidth / 2 ? "left" : "right",
        ratio: Math.min(Math.max(event.clientY / innerHeight, 0), 1),
      };
      place();
    });
    const endDrag = () => {
      if (!drag) return;
      if (drag.moved) {
        dock.classList.remove("dragging");
        GM_setValue(POSITION_KEY, position);
        // 松开后浏览器还会补发一次 click，吞掉它，免得拖完又展开或收起
        suppressClick = true;
        setTimeout(() => (suppressClick = false));
      }
      drag = null;
    };
    tab.addEventListener("pointerup", endDrag);
    tab.addEventListener("pointercancel", endDrag);

    // 点标签只负责展开和收起，不会直接触发切换
    tab.addEventListener("click", () => {
      if (!suppressClick) setExpanded(dock.classList.contains("collapsed"));
    });

    // 鼠标移到按钮上时才预加载切换页面，点击时能省掉约 0.7 秒；
    // 不在打开页面时就加载，免得每次打开或刷新控制台都多请求一次
    main.addEventListener("mouseenter", () => {
      if (!busy && identity && !identity.isRole && identities.length) prepareSwitchFrame();
    });

    main.addEventListener("click", (event) => {
      if (busy) return;
      const wasMenuOpen = menuOpen();
      refresh();
      if (!identity) return;
      if (identity.isRole) {
        run(() => exitRole(identity), isNewTabClick(event));
      } else if (identities.length === 0) {
        openSettings(root, refresh);
      } else if (identities.length === 1) {
        run(() => switchToRole(identities[0], identity), isNewTabClick(event));
      } else if (!wasMenuOpen) {
        showMenu();
      }
    });

    dock.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setExpanded(false);
    });
    document.addEventListener("click", (event) => {
      if (!event.composedPath().includes(dock)) hideMenu();
    });
    window.addEventListener("focus", refresh);
    window.addEventListener("resize", place);

    refresh();
    // 还没配置身份时先展开，让人知道从哪里开始配置
    if (identity && !identity.isRole && identities.length === 0) setExpanded(true);
    return refresh;
  }

  function main() {
    if (window.top !== window) {
      if (window.name.startsWith(FRAME_PREFIX)) runInFrame(window.name.slice(FRAME_PREFIX.length));
      return;
    }
    // 只在各产品的控制台页面上显示按钮
    if (!location.hostname.endsWith(".console.aliyun.com")) return;
    const root = createRoot();
    const refresh = renderDock(root);
    GM_registerMenuCommand("设置切换身份", () => openSettings(root, refresh));
    GM_registerMenuCommand("重置按钮位置", () => {
      GM_setValue(POSITION_KEY, DEFAULT_POSITION);
      refresh();
    });
  }

  main();
})();
