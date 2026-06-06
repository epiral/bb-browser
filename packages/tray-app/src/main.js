// bb-browser tray popup — frontend logic.
//
// Talks to the Rust shell via Tauri IPC (commands defined in app.rs):
//   get_status() -> { color, status_text, daemon_port, cdp_port, token,
//                     chrome_info, recent_commands }
//   copy_text(text)
//   restart_daemon()
//   start_daemon()
//   stop_daemon()
//   open_logs_folder()
//   open_control_panel()
//   quit_app()

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const currentWindow = window.__TAURI__.window.getCurrentWindow();

// ────────────────────────────────────────────────────────────────
// State refresh
// ────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const status = await invoke("get_status");
    render(status);
  } catch (e) {
    console.error("[popup] get_status failed:", e);
  }
}

function render(s) {
  // Status dot + header text
  const dot = document.getElementById("statusDot");
  dot.classList.remove("green", "yellow", "red");
  dot.classList.add(s.color || "red");

  document.getElementById("statusText").textContent =
    `bb-browser · ${s.status_text || "未运行"}`;

  // Chrome info
  document.getElementById("chromeInfo").textContent =
    s.chrome_info || "Chrome 未连接";

  // Ports + Token
  document.getElementById("daemonPort").textContent =
    s.daemon_port != null ? String(s.daemon_port) : "—";
  document.getElementById("cdpPort").textContent =
    s.cdp_port != null ? String(s.cdp_port) : "—";
  document.getElementById("token").textContent = s.token || "—";

  // Recent commands
  const list = document.getElementById("recentList");
  list.innerHTML = "";
  if (!s.recent_commands || s.recent_commands.length === 0) {
    const li = document.createElement("li");
    li.className = "recent-empty";
    li.textContent = "暂无命令";
    list.appendChild(li);
  } else {
    for (const cmd of s.recent_commands.slice(0, 3)) {
      const li = document.createElement("li");
      const c = document.createElement("span");
      c.className = "recent-cmd";
      c.textContent = cmd.text;
      const t = document.createElement("span");
      t.className = "recent-time";
      t.textContent = cmd.age || "";
      li.appendChild(c);
      li.appendChild(t);
      list.appendChild(li);
    }
  }

  // Error banner
  const banner = document.getElementById("errorBanner");
  if (s.error_message) {
    document.getElementById("errorMsg").textContent = s.error_message;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

// ────────────────────────────────────────────────────────────────
// Toast feedback (in-popup, lightweight)
// ────────────────────────────────────────────────────────────────

function showToast(msg) {
  const area = document.getElementById("toastArea");
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  area.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ────────────────────────────────────────────────────────────────
// Button wiring
// ────────────────────────────────────────────────────────────────

document.getElementById("closeBtn").addEventListener("click", () => {
  currentWindow.hide();
});

document.getElementById("settingsBtn").addEventListener("click", async () => {
  try {
    await invoke("open_control_panel");
  } catch (e) {
    console.error("[popup] open_control_panel failed:", e);
    showToast("无法打开控制面板");
  }
});

// Copy buttons — use [data-copy-target] = element id whose textContent
// holds the value.
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const targetId = btn.getAttribute("data-copy-target");
    const el = document.getElementById(targetId);
    if (!el) return;
    const text = el.textContent.trim();
    if (!text || text === "—") {
      showToast("无内容可复制");
      return;
    }
    try {
      await invoke("copy_text", { text });
      btn.classList.add("copied");
      btn.textContent = "已复制";
      showToast(`已复制 ${labelFor(targetId)}`);
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.textContent = "复制";
      }, 1200);
    } catch (e) {
      console.error("[popup] copy failed:", e);
      showToast("复制失败");
    }
  });
});

function labelFor(id) {
  return (
    {
      daemonPort: "daemon 端口",
      cdpPort: "CDP 端口",
      token: "Token",
    }[id] || id
  );
}

document.getElementById("openPanelBtn").addEventListener("click", async () => {
  try {
    await invoke("open_control_panel");
  } catch (e) {
    console.error("[popup] open_control_panel failed:", e);
    showToast("无法打开控制面板");
  }
});

document.getElementById("restartBtn").addEventListener("click", async () => {
  try {
    await invoke("restart_daemon");
    showToast("已重启 daemon");
    refresh();
  } catch (e) {
    console.error("[popup] restart failed:", e);
    showToast("重启失败");
  }
});

document.getElementById("quitBtn").addEventListener("click", async () => {
  await invoke("quit_app");
});

// Esc anywhere closes the popup (light-dismiss).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    currentWindow.hide();
  }
});

// ────────────────────────────────────────────────────────────────
// Live updates from Rust ("state-changed" event)
// ────────────────────────────────────────────────────────────────

listen("state-changed", () => {
  refresh();
});

// First paint
refresh();
