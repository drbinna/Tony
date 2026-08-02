'use strict';
const form = document.getElementById('form');
const code = document.getElementById('code');
const err = document.getElementById('err');
const go = document.getElementById('go');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  go.disabled = true;
  go.textContent = 'Checking…';
  const res = await window.tonySetup.submit(code.value);
  // On success the app relaunches out from under us; only failures return.
  if (res && !res.ok) {
    err.textContent = res.error;
    go.disabled = false;
    go.textContent = 'Wake Tony up';
  }
});
