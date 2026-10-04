/*
 * Booking widget for a restaurant's own website.
 *
 *   <a href="https://YOUR-HOST/r/your-slug" data-freeheld-widget>Reserve a table</a>
 *   <script src="https://YOUR-HOST/widget.js" data-restaurant="your-slug" async></script>
 *
 * The link is plain HTML on purpose: it works without JavaScript, and it is
 * a real link search engines can follow to the restaurant's booking page.
 * The script upgrades it into a button that opens the form over the page.
 * (The older snippet, a script tag alone, still works: the script creates
 * the link itself.)
 *
 * Options (data attributes): data-label="Book now", data-color="#2F5D50",
 * data-inline="true" (embed the booking form in place instead of a button).
 * Bookings made here are tagged as coming from your website.
 */
(function () {
  var BASE = __BASE_URL__;
  var script = document.currentScript;
  if (!script) return;
  var slug = script.getAttribute('data-restaurant');
  if (!slug) return;
  var label = script.getAttribute('data-label');
  var color = script.getAttribute('data-color') || '#9C2F22';
  var inline = script.getAttribute('data-inline') === 'true';
  var page = BASE + '/r/' + encodeURIComponent(slug);
  var url = page + '?embed=1&ref=website';
  var prev = script.previousElementSibling;
  var link = prev && prev.tagName === 'A' && prev.hasAttribute('data-freeheld-widget') ? prev : null;

  function frame(height) {
    var f = document.createElement('iframe');
    f.src = url;
    f.title = 'Reserve a table';
    f.setAttribute('loading', 'lazy');
    f.style.cssText = 'border:0;width:100%;height:' + height + ';display:block;background:#fff;border-radius:10px';
    return f;
  }

  if (inline) {
    var holder = document.createElement('div');
    holder.style.cssText = 'max-width:520px;width:100%';
    holder.appendChild(frame('720px'));
    script.parentNode.insertBefore(holder, script.nextSibling);
    // Keep the link (it is the fallback and the crawlable path), quietly.
    if (link) {
      link.style.cssText = 'display:inline-block;margin-top:8px;font-size:13px';
      link.textContent = 'Open the booking page';
      holder.appendChild(link);
    }
    return;
  }

  var button = link || document.createElement('a');
  button.href = page + '?ref=website';
  button.setAttribute('role', 'button');
  if (label || !link) button.textContent = label || 'Reserve a table';
  button.style.cssText =
    'display:inline-block;text-decoration:none;font:600 16px/1 -apple-system,Segoe UI,Roboto,sans-serif;padding:14px 22px;border:0;border-radius:8px;cursor:pointer;color:#fff;background:' + color;
  if (!link) script.parentNode.insertBefore(button, script.nextSibling);
  // It acts as a button, so Space opens it too.
  button.addEventListener('keydown', function (e) {
    if (e.key === ' ') {
      e.preventDefault();
      button.click();
    }
  });

  var overlay = null;
  var lastFocus = null;

  function close() {
    if (!overlay) return;
    document.body.removeChild(overlay);
    document.removeEventListener('keydown', onKey);
    overlay = null;
    if (lastFocus) lastFocus.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  // Escape pressed inside the booking frame arrives as a message.
  window.addEventListener('message', function (e) {
    if (e.origin === new URL(BASE).origin && e.data && e.data.type === 'freeheld:close') close();
  });

  button.addEventListener('click', function (e) {
    // Modified clicks (new tab) follow the real link.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;
    e.preventDefault();
    lastFocus = button;
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', button.textContent);
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;background:rgba(20,16,12,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;width:100%;max-width:520px;height:min(760px,92vh)';
    var x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.textContent = '×';
    x.style.cssText =
      'position:absolute;top:-14px;right:-14px;width:36px;height:36px;border-radius:50%;border:0;background:#fff;font-size:22px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    x.addEventListener('click', close);
    var f = frame('100%');
    box.appendChild(f);
    box.appendChild(x);
    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    x.focus();
  });
})();
