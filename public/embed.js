(function () {
  var scriptEl = document.currentScript;
  var apiBase = new URL(scriptEl.src).origin;
  var data = scriptEl.dataset;

  var propertyName = data.propertyName || 'Your booking';
  var totalAmount = Math.round(parseFloat(data.totalAmount || '0') * 100);
  var currency = (data.currency || 'gbp').toLowerCase();
  var merchantKey = data.merchantKey || undefined;
  var minPeople = parseInt(data.minPeople || '2', 10);
  var maxPeople = parseInt(data.maxPeople || '20', 10);
  var defaultPeople = Math.min(Math.max(parseInt(data.defaultPeople || '2', 10), minPeople), maxPeople);

  var symbols = { gbp: '£', usd: '$', eur: '€' };
  var symbol = symbols[currency] || currency.toUpperCase() + ' ';

  var container = data.target ? document.getElementById(data.target) : scriptEl.previousElementSibling;
  if (!container) {
    container = document.createElement('div');
    scriptEl.parentNode.insertBefore(container, scriptEl);
  }

  var root = container.attachShadow({ mode: 'open' });
  root.innerHTML = ''
    + '<style>'
    + ':host{all:initial;}'
    + '.gl-widget{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border:1.5px solid #1D9E75;background:#f0faf6;border-radius:10px;padding:14px;box-sizing:border-box;max-width:420px;}'
    + '.gl-widget *{box-sizing:border-box;}'
    + '.gl-title{font-size:12px;font-weight:600;color:#0d6e52;margin-bottom:10px;display:flex;align-items:center;gap:5px;}'
    + '.gl-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}'
    + '.gl-row span{font-size:12px;color:#0d6e52;font-weight:500;}'
    + '.gl-stepper{display:flex;align-items:center;border:1.5px solid #9fe1cb;border-radius:8px;overflow:hidden;}'
    + '.gl-stepper button{width:30px;height:30px;background:#e0f5ec;border:none;cursor:pointer;font-size:16px;color:#0d6e52;line-height:1;}'
    + '.gl-stepper button:hover{background:#c5edd9;}'
    + '.gl-stepper output{padding:0 14px;font-size:14px;font-weight:600;color:#0d6e52;background:white;height:30px;display:flex;align-items:center;border-left:1.5px solid #9fe1cb;border-right:1.5px solid #9fe1cb;}'
    + '.gl-summary{display:flex;justify-content:space-between;font-size:12px;color:#0d6e52;padding:3px 0;}'
    + '.gl-summary strong{font-weight:600;}'
    + '.gl-note{font-size:11px;color:#0f6e56;margin:8px 0;line-height:1.5;}'
    + 'input,select{width:100%;border:1.5px solid #cdeee0;border-radius:8px;padding:9px 11px;font-size:13px;margin:8px 0;outline:none;font-family:inherit;background:white;}'
    + 'input:focus,select:focus{border-color:#1D9E75;}'
    + 'label{font-size:11px;color:#0f6e56;display:block;margin-top:6px;}'
    + 'button.gl-cta{display:block;width:100%;border:none;border-radius:8px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;background:#1D9E75;color:white;}'
    + 'button.gl-cta:hover{background:#178a65;}'
    + 'button.gl-cta:disabled{opacity:.6;cursor:not-allowed;}'
    + '.gl-error{color:#c0392b;font-size:11px;margin-top:6px;display:none;}'
    + '</style>'
    + '<div class="gl-widget">'
    + '  <div class="gl-title">🔒 Grouple · split this booking with your group</div>'
    + '  <div class="gl-row">'
    + '    <span>Number of people</span>'
    + '    <div class="gl-stepper">'
    + '      <button type="button" id="gl-minus">−</button>'
    + '      <output id="gl-count">' + defaultPeople + '</output>'
    + '      <button type="button" id="gl-plus">+</button>'
    + '    </div>'
    + '  </div>'
    + '  <div class="gl-summary"><span>Each person pays</span><strong id="gl-per-head"></strong></div>'
    + '  <div class="gl-summary"><span>Total</span><strong>' + symbol + (totalAmount / 100).toLocaleString() + '</strong></div>'
    + '  <div class="gl-note">Booking confirms only when everyone pays. If the group doesn\'t fill, everyone is refunded automatically.</div>'
    + '  <input type="email" id="gl-email" placeholder="Your email (for your dashboard link)" />'
    + '  <label for="gl-response-window">If the group fully pays, how long should the host have to confirm?</label>'
    + '  <select id="gl-response-window">'
    + '    <option value="24">24 hours</option>'
    + '    <option value="48" selected>48 hours</option>'
    + '    <option value="72">72 hours</option>'
    + '    <option value="168">1 week</option>'
    + '  </select>'
    + '  <button type="button" class="gl-cta" id="gl-submit">Start group payment →</button>'
    + '  <div class="gl-error" id="gl-error"></div>'
    + '</div>';

  var people = defaultPeople;
  var countEl = root.getElementById('gl-count');
  var perHeadEl = root.getElementById('gl-per-head');
  var errorEl = root.getElementById('gl-error');
  var submitBtn = root.getElementById('gl-submit');

  function renderPeople() {
    countEl.textContent = people;
    perHeadEl.textContent = symbol + Math.round(totalAmount / people / 100).toLocaleString();
  }
  renderPeople();

  root.getElementById('gl-minus').addEventListener('click', function () {
    if (people > minPeople) { people--; renderPeople(); }
  });
  root.getElementById('gl-plus').addEventListener('click', function () {
    if (people < maxPeople) { people++; renderPeople(); }
  });

  submitBtn.addEventListener('click', function () {
    errorEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Setting up...';

    var organiserEmail = root.getElementById('gl-email').value.trim() || undefined;
    var merchantResponseHours = parseInt(root.getElementById('gl-response-window').value, 10);

    fetch(apiBase + '/api/booking/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyName: propertyName, totalAmount: totalAmount, groupSize: people, currency: currency, organiserEmail: organiserEmail, merchantKey: merchantKey, merchantResponseHours: merchantResponseHours })
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (!result.success) throw new Error(result.error || 'Something went wrong');
        window.location.href = apiBase + '/?booking=' + result.bookingId;
      })
      .catch(function (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Start group payment →';
      });
  });
})();
