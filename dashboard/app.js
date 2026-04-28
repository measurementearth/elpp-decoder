const el = id => document.getElementById(id)

async function fetchJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' })
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText)
    return await res.json()
  } catch (e) {
    return { error: String(e) }
  }
}

async function refresh() {
  const [devices, tapos] = await Promise.all([
    fetchJson('/api/device_states'),
    fetchJson('/api/tapos_manager_state')
  ])
  el('device_states').innerText = JSON.stringify(devices, null, 2)
  el('tapos_manager_state').innerText = JSON.stringify(tapos, null, 2)
  el('updatedAt').innerText = new Date().toLocaleTimeString()
}

function renderApStatus(data) {
  if (!data || data.error) {
    el('apStatusTable').innerHTML = '<span style="color:#991b1b">Error loading AP status: ' + (data && data.error) + '</span>'
    return
  }

  let html = ''
  for (const chain in data) {
    html += '<div class="chain-header">' + chain + '</div>'
    html += '<table><thead><tr>'
    html += '<th>Host</th><th>Status</th><th>Errors</th><th>Uses</th><th>Trx Sent</th><th>Version</th>'
    html += '</tr></thead><tbody>'
    const aps = data[chain]
    for (const ap of aps) {
      const badge = ap.valid
        ? '<span class="badge badge-ok">✓ Valid</span>'
        : '<span class="badge badge-err">✗ Invalid</span>'
      const version = ap.version_found || '<span style="color:#aaa">—</span>'
      html += '<tr>'
      html += '<td><code>' + ap.method + ap.host + '</code></td>'
      html += '<td>' + badge + '</td>'
      html += '<td>' + ap.errors + '</td>'
      html += '<td>' + ap.use_count + '</td>'
      html += '<td>' + ap.trx_count + '</td>'
      html += '<td>' + version + '</td>'
      html += '</tr>'
    }
    html += '</tbody></table>'
  }
  el('apStatusTable').innerHTML = html
}

/* Known unrecoverable error code names for display */
const UNRECOVERABLE_CODE_NAMES = {
  3040005: 'expired_tx_exception',
  3040006: 'tx_exp_too_far_exception',
  3040007: 'invalid_ref_block_exception',
  3040008: 'tx_duplicate',
  3040009: 'tx_duplicate_deferred'
}

function renderChainStats(chainName, stats) {
  let html = '<div class="chain-header">' + chainName + '</div>'
  html += '<table><thead><tr><th>Counter</th><th>Value</th></tr></thead><tbody>'
  html += '<tr><td>Trx dropped (total)</td><td>' + stats.trx_dropped_total + '</td></tr>'
  html += '<tr><td>Trx dropped (unrecoverable error)</td><td>' + stats.trx_dropped_unrecoverable + '</td></tr>'
  html += '<tr><td>Trx dropped (other)</td><td>' + stats.trx_dropped_other + '</td></tr>'
  html += '</tbody></table>'

  const errs = stats.unrecoverable_errors || {}
  const codes = Object.keys(errs)
  if (codes.length > 0) {
    html += '<div style="margin-top:8px;font-size:12px;font-weight:600;color:#0b2545">Unrecoverable Error Breakdown</div>'
    html += '<table><thead><tr><th>Code</th><th>Name</th><th>Count</th></tr></thead><tbody>'
    for (const code of codes) {
      const name = UNRECOVERABLE_CODE_NAMES[code] || '—'
      html += '<tr><td><code>' + code + '</code></td><td>' + name + '</td><td>' + errs[code] + '</td></tr>'
    }
    html += '</tbody></table>'
  } else {
    html += '<div style="margin-top:4px;font-size:12px;color:#556">No unrecoverable errors recorded.</div>'
  }
  return html
}

function renderServerStats(data) {
  if (!data || data.error) {
    el('serverStatsContent').innerHTML = '<span style="color:#991b1b">Error: ' + (data && data.error) + '</span>'
    return
  }

  let html = ''
  for (const chain in data) {
    html += renderChainStats(chain, data[chain])
  }
  el('serverStatsContent').innerHTML = html
}

async function refreshServerStats() {
  const data = await fetchJson('/api/server_stats')
  renderServerStats(data)
}

async function refreshApStatus() {
  const data = await fetchJson('/api/ap_status')
  renderApStatus(data)
}

async function triggerApRefresh() {
  const btn = el('refreshAPs')
  const status = el('refreshStatus')
  btn.disabled = true
  status.innerText = 'Checking all APs…'
  try {
    const res = await fetch('/api/tapos_refresh', { method: 'GET', cache: 'no-store' })
    const data = await res.json()
    renderApStatus(data)
    status.innerText = 'Done at ' + new Date().toLocaleTimeString()
  } catch (e) {
    status.innerText = 'Error: ' + String(e)
  }
  btn.disabled = false
}

el('refresh').addEventListener('click', refresh)
el('refreshAPs').addEventListener('click', triggerApRefresh)

refresh()
refreshApStatus()
refreshServerStats()
setInterval(refresh, 2000)
setInterval(refreshApStatus, 5000)
setInterval(refreshServerStats, 5000)
