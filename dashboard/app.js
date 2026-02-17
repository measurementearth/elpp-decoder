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

document.getElementById('refresh').addEventListener('click', refresh)

refresh()
setInterval(refresh, 2000)
