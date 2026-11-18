// Fill a saved login into the page in front: a function expression that Rust calls as
// `(this)(origin, username, password)` through the plugin's Rust-only `evaluate`, on one tap.
// It sets the values of one username field and one password field and nothing else: it never
// clicks, submits or navigates. It answers only which fields it filled, never a value, and it
// does nothing unless the page is still on the origin Rust checked the login against.
(function (origin, username, password) {
  if (location.origin !== origin) return { user: false, password: false, origin: false };

  function visible(input) {
    var style = getComputedStyle(input);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    var box = input.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && !input.disabled && !input.readOnly;
  }

  function setValue(input, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var passwords = Array.prototype.filter.call(
    document.querySelectorAll('input[type="password"]'),
    visible
  );
  var field = passwords[0] || null;
  var scope = (field && field.form) || document;
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
