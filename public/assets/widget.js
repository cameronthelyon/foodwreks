/*
 * Booking widget for a restaurant's own website.
 *
 *   <script src="https://YOUR-HOST/widget.js" data-restaurant="your-slug" async></script>
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
  var label = script.getAttribute('data-label') || 'Reserve a table';
  var color = script.getAttribute('data-color') || '#9C2F22';
  var inline = script.getAttribute('data-inline') === 'true';
  var url = BASE + '/r/' + encodeURIComponent(slug) + '?embed=1&ref=website';

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
    return;
  }

  var button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText =
    'font:600 16px/1 -apple-system,Segoe UI,Roboto,sans-serif;padding:14px 22px;border:0;border-radius:8px;cursor:pointer;color:#fff;background:' + color;
  script.parentNode.insertBefore(button, script.nextSibling);

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
    if (e.origin === new URL(BASE).origin && e.data && e.data.type === 'freehold:close') close();
  });

  button.addEventListener('click', function () {
    lastFocus = document.activeElement;
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', label);
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
