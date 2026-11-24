// Boot guard (a plain script, so it runs even when the app's modules fail to load).
// If the app hasn't started a few seconds after the page loads — usually a stale copy of the
// app's files stuck in this browser — offer one tap that clears them and reloads fresh.
(function () {
  var shown = false;
  function offerReload(reason) {
    if (shown || window.__cbBooted) return;
    shown = true;
    var bar = document.createElement("div");
    bar.className = "boot-guard-bar";
    bar.setAttribute("role", "alert");
    var text = document.createElement("span");
    text.textContent = "The Chord Book didn’t finish loading.";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Reload fresh";
    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.textContent = "Reloading…";
      var jobs = [];
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        }));
      }
      if (window.caches && caches.keys) {
        jobs.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }));
      }
      Promise.all(jobs).catch(function () {}).then(function () {
        location.reload();
      });
    });
    bar.appendChild(text);
    bar.appendChild(btn);
    document.body.appendChild(bar);
    if (reason && window.console) console.error("Chord Book didn’t start:", reason);
  }
  // A module that fails to load reports here before the timer runs out.
  window.addEventListener("error", function (e) {
    if (!window.__cbBooted && e && (e.filename || "").indexOf("/js/") !== -1) offerReload(e.message);
  });
  window.addEventListener("load", function () {
    setTimeout(function () { offerReload("timed out"); }, 8000);
  });
})();
