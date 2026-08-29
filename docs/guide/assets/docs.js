/* PacketBench docs: theme persistence, mobile nav, code copy,
   scroll-spy for the on-this-page rail, and client-side search.
   Hand-authored — the generator only writes search-index.json into this dir. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ theme
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem("packetbench-docs-theme");
    if (saved) root.setAttribute("data-theme", saved);
  } catch (e) {
    /* private mode or blocked storage — keep the default theme */
  }
  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem("packetbench-docs-theme", next);
      } catch (e) {
        /* not persisting is fine */
      }
    });
  }

  // ------------------------------------------------------------- mobile nav
  var menu = document.querySelector(".menu-toggle");
  var sidebar = document.querySelector(".sidebar");
  if (menu && sidebar) {
    menu.addEventListener("click", function () {
      var open = sidebar.classList.toggle("open");
      menu.setAttribute("aria-expanded", String(open));
    });
  }

  // -------------------------------------------------------------- copy code
  document.querySelectorAll(".code-block .copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.parentElement.querySelector("code");
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(
        function () {
          btn.textContent = "Copied";
          setTimeout(function () {
            btn.textContent = "Copy";
          }, 1400);
        },
        function () {
          btn.textContent = "Failed";
          setTimeout(function () {
            btn.textContent = "Copy";
          }, 1400);
        },
      );
    });
  });

  // -------------------------------------------------------------- scroll spy
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length) {
    var targets = tocLinks
      .map(function (a) {
        return document.getElementById(a.getAttribute("href").slice(1));
      })
      .filter(Boolean);
    var spy = function () {
      var best = 0;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].getBoundingClientRect().top <= 96) best = i;
      }
      tocLinks.forEach(function (a, i) {
        a.classList.toggle("active", i === best);
      });
    };
    window.addEventListener("scroll", spy, { passive: true });
    spy();
  }

  // ----------------------------------------------------------------- search
  var input = document.getElementById("search");
  var results = document.getElementById("search-results");
  if (!input || !results) return;

  var index = null;
  var loading = false;

  function load() {
    if (index || loading) return;
    loading = true;
    fetch("assets/search-index.json")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        index = data;
        loading = false;
        if (input.value) run();
      })
      .catch(function () {
        loading = false;
      });
  }
  input.addEventListener("focus", load);

  function snippet(text, terms) {
    var lower = text.toLowerCase();
    var at = -1;
    for (var i = 0; i < terms.length && at < 0; i++) at = lower.indexOf(terms[i]);
    if (at < 0) at = 0;
    var start = Math.max(0, at - 45);
    return (start > 0 ? "…" : "") + text.slice(start, start + 150).trim() + "…";
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function run() {
    var q = input.value.trim().toLowerCase();
    if (!q || !index) {
      results.hidden = true;
      return;
    }
    var terms = q.split(/\s+/).filter(Boolean);
    var hits = [];

    index.forEach(function (page) {
      var hay = (page.title + " " + page.group + " " + page.text).toLowerCase();
      // Every term must appear somewhere, so multi-word queries narrow.
      var all = terms.every(function (t) {
        return hay.indexOf(t) >= 0;
      });
      if (!all) return;
      var score = 0;
      terms.forEach(function (t) {
        if (page.title.toLowerCase().indexOf(t) >= 0) score += 12;
        score += Math.min(hay.split(t).length - 1, 8);
      });
      if (score > 0) hits.push({ page: page, score: score });
    });

    hits.sort(function (a, b) {
      return b.score - a.score;
    });

    if (!hits.length) {
      results.innerHTML = '<div class="empty">No matches for “' + esc(q) + "”.</div>";
      results.hidden = false;
      return;
    }

    results.innerHTML = hits
      .slice(0, 8)
      .map(function (h) {
        return (
          '<a href="' +
          h.page.page +
          '"><span class="r-group">' +
          esc(h.page.group) +
          '</span><br><span class="r-title">' +
          esc(h.page.title) +
          '</span><br><span class="r-snip">' +
          esc(snippet(h.page.text, terms)) +
          "</span></a>"
        );
      })
      .join("");
    results.hidden = false;
  }

  var timer = null;
  input.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(run, 110);
  });

  input.addEventListener("keydown", function (e) {
    var items = Array.prototype.slice.call(results.querySelectorAll("a"));
    if (!items.length) return;
    var cur = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains("sel")) cur = i;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (cur >= 0) items[cur].classList.remove("sel");
      var next =
        e.key === "ArrowDown" ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
      items[next].classList.add("sel");
      items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && cur >= 0) {
      e.preventDefault();
      window.location.href = items[cur].getAttribute("href");
    } else if (e.key === "Escape") {
      results.hidden = true;
      input.blur();
    }
  });

  document.addEventListener("click", function (e) {
    if (!results.contains(e.target) && e.target !== input) results.hidden = true;
  });

  // "/" focuses search, the way most docs sites behave.
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
  });
})();
