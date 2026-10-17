// Side panel shell. MV3 extension pages can't run the inline scripts in
// index.html, so the panel frames the hosted page and acts as its bridge to
// the SHEIN tab. Read-only: it runs SheinParser.captureAny() in the tab and
// passes back that capture. It never clicks, submits or changes anything.

var APP_URL = "https://maryfreitas97-gif.github.io/shein-optimizer/";

// Development: panel.html?app=http://localhost:8000/ frames a local copy.
var override = new URLSearchParams(location.search).get("app");
if (override && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(override)) APP_URL = override;
var APP_ORIGIN = new URL(APP_URL).origin;

var frame = document.getElementById("app");
var offline = document.getElementById("offline");
document.getElementById("appUrl").textContent = APP_URL;

function loadApp() {
  offline.hidden = true;
  fetch(APP_URL, { cache: "no-store" }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    frame.hidden = false;
    frame.src = APP_URL;
  }).catch(function () {
    frame.hidden = true;
    offline.hidden = false;
  });
}
document.getElementById("retry").addEventListener("click", loadApp);

frame.addEventListener("load", function () {
  frame.contentWindow.postMessage({ app: "sco-ext", type: "hello" }, APP_ORIGIN);
});

function reply(msg) {
  msg.app = "sco-ext";
  msg.type = "capture";
  frame.contentWindow.postMessage(msg, APP_ORIGIN);
}

var SHEIN_URL = /^https:\/\/([a-z0-9-]+\.)*shein\.com\//i;

async function captureActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs[0];
  // tab.url is only visible for sites in host_permissions, i.e. SHEIN.
  if (!tab || !tab.url || !SHEIN_URL.test(tab.url)) {
    return { error: "Open your SHEIN cart or My Coupons page in this window's active tab, then import again." };
  }
  var target = { tabId: tab.id };
  await chrome.scripting.executeScript({ target: target, world: "MAIN", files: ["parsers/shein.js"] });
  var results = await chrome.scripting.executeScript({
    target: target,
    world: "MAIN",
    func: function () {
      try { return { data: window.SheinParser.captureAny() }; }
      catch (e) { return { error: e.message }; }
      finally { delete window.SheinParser; }
    }
  });
  return (results[0] && results[0].result) || { error: "The SHEIN tab did not answer. Reload it and try again." };
}

window.addEventListener("message", function (e) {
  if (e.source !== frame.contentWindow || e.origin !== APP_ORIGIN) return;
  var m = e.data;
  if (!m || m.app !== "sco" || m.type !== "capture-request") return;
  captureActiveTab().then(reply, function (err) {
    reply({ error: "Could not read the SHEIN tab: " + err.message });
  });
});

loadApp();
