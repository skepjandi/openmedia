// Fill a saved login into the page in front: a function expression that Rust calls as
// `(this)(origin, username, password)` through the plugin's Rust-only `evaluate`, on one tap.
// It sets the values of one username field and one password field and nothing else: it never
// clicks, submits or navigates. It answers only which fields it filled, never a value, and it
// does nothing unless the page is still on the origin Rust checked the login against. Fields in
// frames are filled only for frames of that same origin; frames of other origins are out of reach
// and left alone.
(function (origin, username, password) {
  if (location.origin !== origin) return { user: false, password: false, origin: false };

  // The page's own document, then each frame whose origin is the same (reading a frame of
  // another origin throws, and that frame is skipped).
  function documents() {
    var found = [document];
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try {
        var inner = frames[i].contentDocument;
        var inside = frames[i].contentWindow;
        if (inner && (inside.origin || inside.location.origin) === origin) found.push(inner);
      } catch (_) {}
    }
    return found;
  }

  function visible(input) {
    var view = input.ownerDocument.defaultView;
    var style = view.getComputedStyle(input);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    var box = input.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && !input.disabled && !input.readOnly;
  }

  function setValue(input, value) {
    var view = input.ownerDocument.defaultView;
    var setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  var field = null;
  var all = documents();
  for (var d = 0; d < all.length && !field; d++) {
    var passwords = Array.prototype.filter.call(
      all[d].querySelectorAll('input[type="password"]'),
      visible
    );
    field = passwords[0] || null;
  }
  var scope = field ? field.form || field.ownerDocument : document;
  var candidates = Array.prototype.filter.call(
    scope.querySelectorAll(
      'input[type="text"],input[type="email"],input[type="tel"],input:not([type])'
    ),
    visible
  );
  var user = null;
  for (var i = 0; i < candidates.length; i++) {
    if (!field || candidates[i].compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING) {
      user = candidates[i];
    }
  }
  if (!user && candidates.length === 1 && !field) user = candidates[0];

  var filledUser = false;
  var filledPassword = false;
  if (user && username) {
    setValue(user, username);
    filledUser = true;
  }
  if (field && password) {
    setValue(field, password);
    filledPassword = true;
  }
  return { user: filledUser, password: filledPassword, origin: true };
})
