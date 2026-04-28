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
  // ─────────────────────────────────────────────
  // Transaction exceptions (304xxxx)
  // ─────────────────────────────────────────────
  3040000: 'transaction_exception',
  3040001: 'tx_decompression_error',
  3040002: 'tx_no_action',
  3040003: 'tx_no_auths',
  3040004: 'cfa_irrelevant_auth',
  3040005: 'expired_tx_exception',
  3040006: 'tx_exp_too_far_exception',
  3040007: 'invalid_ref_block_exception',
  3040008: 'tx_duplicate',
  3040009: 'deferred_tx_duplicate',
  3040010: 'cfa_inside_generated_tx',
  3040011: 'tx_not_found',
  3040012: 'too_many_tx_at_once',
  3040013: 'tx_too_big',
  3040014: 'unknown_transaction_compression',
  3040015: 'invalid_transaction_extension',
  3040016: 'ill_formed_deferred_transaction_generation_context',
  3040017: 'disallowed_transaction_extensions_bad_block_exception',
  3040018: 'tx_resource_exhaustion',

  // ─────────────────────────────────────────────
  // Authorization exceptions (309xxxx)
  // ─────────────────────────────────────────────
  3090000: 'authorization_exception',
  3090001: 'tx_duplicate_sig',
  3090002: 'tx_irrelevant_sig',
  3090003: 'unsatisfied_authorization',
  3090004: 'missing_auth_exception',
  3090005: 'irrelevant_auth_exception',
  3090006: 'insufficient_delay_exception',
  3090007: 'invalid_permission',
  3090008: 'unlinkable_min_permission_action',
  3090009: 'invalid_parent_permission',

  // ─────────────────────────────────────────────
  // Action validation exceptions (305xxxx)
  // ─────────────────────────────────────────────
  3050000: 'action_validate_exception',
  3050001: 'account_name_exists_exception',
  3050002: 'invalid_action_args_exception',
  3050003: 'eosio_assert_message_exception',
  3050004: 'eosio_assert_code_exception',
  3050005: 'action_not_found_exception',
  3050006: 'action_data_and_struct_mismatch',
  3050007: 'unaccessible_api',
  3050008: 'abort_called',
  3050009: 'inline_action_too_big',
  3050010: 'unauthorized_ram_usage_increase',
  3050011: 'restricted_error_code_exception',
  3050014: 'action_return_value_exception',
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
