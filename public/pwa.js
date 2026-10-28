// "Install as app" prompt: Chrome/Edge/Android via beforeinstallprompt, iPhone/iPad with a short hint.
// "Später" hides it for 30 days.
(function () {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
  var standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  var KEY = "nl-install-later";
  function later() { try { return Date.now() < Number(localStorage.getItem(KEY) || 0); } catch (e) { return false; } }
  if (standalone || later()) return;
  function banner(text, action) {
    var bar = document.createElement("div");
    bar.className = "nl-install";
    bar.innerHTML = '<img src="/icon-192.png" alt=""><span></span>';
    bar.querySelector("span").textContent = text;
    if (action) { var ok = document.createElement("button"); ok.className = "ok"; ok.textContent = "Installieren"; ok.onclick = function () { action(); bar.remove(); }; bar.append(ok); }
    var no = document.createElement("button"); no.textContent = action ? "Später" : "OK";
    no.onclick = function () { try { localStorage.setItem(KEY, String(Date.now() + 30 * 864e5)); } catch (e) {} bar.remove(); };
    bar.append(no);
    document.body.append(bar);
  }
  var style = document.createElement("style");
  style.textContent = ".nl-install{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:50;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);padding:10px 12px;background:#fff;color:#1f2328;border:1px solid #dfe1e5;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.2);font:14px system-ui,sans-serif}.nl-install img{width:32px;height:32px;border-radius:8px}.nl-install button{font:13px system-ui,sans-serif;padding:6px 12px;border-radius:8px;border:1px solid #dfe1e5;background:none;color:inherit;cursor:pointer;white-space:nowrap}.nl-install button.ok{background:#2b579a;border-color:#2b579a;color:#fff}@media (prefers-color-scheme:dark){.nl-install{background:#26282c;color:#e8eaed;border-color:#383b40}}@media print{.nl-install{display:none}}";
  document.head.append(style);
  var deferred = null;
  addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e;
    setTimeout(function () { banner("Nexus Light als App installieren?", function () { deferred.prompt(); }); }, 2500);
  });
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) setTimeout(function () { banner("Als App nutzen: unten auf „Teilen“ und dann „Zum Home-Bildschirm“ tippen.", null); }, 2500);
})();
