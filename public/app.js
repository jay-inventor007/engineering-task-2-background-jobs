const statusBox = document.getElementById('status');
const deadList = document.getElementById('dead');

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');

// One idempotency key per form submission. A double-click sends the same key twice, so the
// server returns the same job instead of making two.
let currentKey = crypto.randomUUID();
let pollTimer = null;

document.getElementById('create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = {
    title: form.get('title'),
    priceMinor: Math.round(Number(form.get('price')) * 100),
    currency: 'NGN',
    address: form.get('address'),
    bedrooms: Number(form.get('bedrooms')),
  };
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': currentKey },
    body: JSON.stringify({ type: 'listing_flyer', payload }),
  });
  const body = await res.json();
  if (!res.ok) {
    showStatus(`<p class="error">${escape(body.error?.message)}</p>`);
    return;
  }
  currentKey = crypto.randomUUID(); // the next submission is a new request
  watch(body.data.id);
});

function showStatus(html) {
  statusBox.hidden = false;
  statusBox.innerHTML = html;
}

// Polls the status endpoint every second until the job is finished one way or the other.
function watch(jobId) {
  clearInterval(pollTimer);
  const check = async () => {
    const res = await fetch(`/api/jobs/${jobId}`);
    const job = (await res.json()).data;
    let html = `<p><strong>Job</strong> <code>${job.id}</code></p>
      <p><span class="badge ${job.status}">${job.status}</span> attempt ${job.attempts} of ${job.maxAttempts}</p>`;
    if (job.lastError) html += `<p class="error">Last error: ${escape(job.lastError)}</p>`;
    if (job.status === 'failed') html += `<p>Next attempt at ${time(job.nextAttemptAt)}</p>`;
    if (job.resultUrl) html += `<p><a href="${job.resultUrl}" target="_blank">Open the flyer (PDF)</a></p>`;
    showStatus(html);
    if (job.status === 'succeeded' || job.status === 'dead') {
      clearInterval(pollTimer);
      loadDead();
    }
  };
  check();
  pollTimer = setInterval(check, 1000);
}

async function loadDead() {
  const res = await fetch('/api/jobs?status=dead');
  const jobs = (await res.json()).data;
  if (jobs.length === 0) {
    deadList.innerHTML = '<p class="hint">No dead jobs.</p>';
    return;
  }
  const cards = await Promise.all(
    jobs.map(async (job) => {
      const attempts = (await (await fetch(`/api/jobs/${job.id}/attempts`)).json()).data;
      const rows = attempts
        .map(
          (a) => `<tr><td>${a.attempt}</td><td>${escape(a.workerId)}</td><td>${time(a.startedAt)}</td>
            <td>${escape(a.outcome ?? 'running')}</td><td>${escape(a.error)}</td></tr>`,
        )
        .join('');
      return `<div class="box">
        <p><strong>Job</strong> <code>${job.id}</code> · created ${new Date(job.createdAt).toLocaleString()}</p>
        <p class="error">Last error: ${escape(job.lastError)}</p>
        <p>Payload:</p>
        <pre>${escape(JSON.stringify(job.payload, null, 2))}</pre>
        <table><thead><tr><th>#</th><th>Worker</th><th>Started</th><th>Outcome</th><th>Error</th></tr></thead>
          <tbody>${rows}</tbody></table>
        <button type="button" data-retry="${job.id}">Retry</button>
      </div>`;
    }),
  );
  deadList.innerHTML = cards.join('');
}

deadList.addEventListener('click', async (event) => {
  const id = event.target.dataset?.retry;
  if (!id) return;
  event.target.disabled = true;
  const res = await fetch(`/api/jobs/${id}/retry`, { method: 'POST' });
  if (res.ok) watch(id);
  else alert((await res.json()).error?.message);
  loadDead();
});

document.getElementById('refresh').addEventListener('click', loadDead);
loadDead();
