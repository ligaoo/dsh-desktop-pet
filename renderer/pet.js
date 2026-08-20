/**
 * Desktop pet renderer logic: applies bridge snapshots to the CSS mood
 * classes and wires the chat panel to `window.desktopPet` (the preload API).
 */

const MOODS = ['idle', 'thinking', 'acting', 'speaking', 'error']

const pet = document.getElementById('pet')
const petImg = document.getElementById('pet-img')
const bubble = document.getElementById('bubble')
const chat = document.getElementById('chat')
const log = document.getElementById('log')
const form = document.getElementById('form')
const input = document.getElementById('input')
const sendButton = document.getElementById('send')
const approvalCard = document.getElementById('approval')
const approvalText = document.querySelector('.approval-text')
const approveButton = document.getElementById('approve')
const rejectButton = document.getElementById('reject')

// --- Image skin (零代码换宠): drop pet.png / pet-<mood>.png into renderer/.
// The <img> probes per-mood images first, falls back to pet.png, then to the
// CSS creature when no image exists at all.
const PET_IMAGES = { idle: 'pet-idle.png', thinking: 'pet-thinking.png', acting: 'pet-acting.png', speaking: 'pet-speaking.png', error: 'pet-error.png' }

// Image-skin state. The displayed <img> only switches when the RESOLVED
// source changes; per-mood images are probed in the background (no 404
// flicker) and their availability is cached so a missing mood image never
// causes repeated fallback flashes while streaming.
const availability = new Map() // src -> true (loads) | false (missing)
let imageSkinActive = false
let currentSrc = null
let genericOk = null // pet.png availability
let lastImageMood = null

function applyImg(src) {
  if (currentSrc === src) return
  currentSrc = src
  petImg.src = src
}

petImg.onload = () => {
  availability.set(petImg.dataset.probe, true)
  if (petImg.dataset.probe === 'pet.png') genericOk = true
  imageSkinActive = true
  pet.classList.add('using-image')
  petImg.classList.remove('hidden')
}
petImg.onerror = () => {
  availability.set(petImg.dataset.probe, false)
  if (petImg.dataset.probe === 'pet.png') genericOk = false
  if (petImg.dataset.probe !== 'pet.png' && genericOk !== false) {
    // A per-mood image is missing: fall back to the generic skin.
    petImg.dataset.probe = 'pet.png'
    applyImg('pet.png')
    return
  }
  // No usable image at all: stay on the CSS creature.
  petImg.classList.add('hidden')
  petImg.removeAttribute('src')
  pet.classList.remove('using-image')
  imageSkinActive = false
  currentSrc = null
}

/** Probe a per-mood image off-screen; adopt it only if it actually loads. */
function probeMoodImage(mood) {
  const src = PET_IMAGES[mood]
  if (src === undefined || availability.has(src)) return
  availability.set(src, false)
  const probe = new Image()
  probe.onload = () => {
    availability.set(src, true)
    if (lastImageMood === mood) applyImg(src)
  }
  probe.onerror = () => {
    availability.set(src, false)
  }
  probe.src = src
}

function renderImageSkin(mood) {
  if (mood === lastImageMood) return
  lastImageMood = mood
  const moodSrc = PET_IMAGES[mood]
  if (moodSrc !== undefined && availability.get(moodSrc) === true) {
    applyImg(moodSrc)
    return
  }
  if (genericOk !== false) {
    if (petImg.dataset.probe !== 'pet.png' || availability.get('pet.png') === undefined) {
      petImg.dataset.probe = 'pet.png'
      applyImg('pet.png')
    }
    // Adopt a per-mood image later if one exists (no visual flicker).
    probeMoodImage(mood)
  }
}

/** How long the speech bubble stays visible after a reply completes. */
const BUBBLE_TTL_MS = 8000
/** Long replies are clipped for the bubble (the chat panel keeps the full text). */
const BUBBLE_MAX_CHARS = 80

/** Render one bridge snapshot: mood class and (streaming) speech bubble. */
const MOOD_CLASSES = MOODS.map(m => `mood-${m}`)
let bubbleTimer = null
function applySnapshot(snapshot) {
  const mood = MOODS.includes(snapshot.mood) ? snapshot.mood : 'idle'
  // Swap only the mood class — `className =` would wipe the `using-image`
  // class the image skin adds, making the CSS creature overlay the image.
  for (const c of MOOD_CLASSES) pet.classList.remove(c)
  pet.classList.add(`mood-${mood}`)
  renderImageSkin(mood)

  const speech = snapshot.speech
  clearTimeout(bubbleTimer)
  if (speech === null || speech === '') {
    bubble.classList.add('hidden')
  } else {
    bubble.textContent = speech.length > BUBBLE_MAX_CHARS ? `${speech.slice(0, BUBBLE_MAX_CHARS)}…` : speech
    bubble.classList.remove('hidden')
    // While a turn is actively streaming (thinking/speaking) the bubble stays
    // live; once the reply is done (idle) it auto-hides after a short delay.
    if (mood === 'idle') {
      bubbleTimer = setTimeout(() => {
        bubble.classList.add('hidden')
      }, BUBBLE_TTL_MS)
    }
  }
}

window.desktopPet.onSnapshot(applySnapshot)
// Render the initial state immediately so the image-skin probe runs at
// startup instead of waiting for the first mood change.
applySnapshot({ mood: 'idle', speech: null, detail: null })

// Show the pet's name in the chat header, window title, and input placeholder.
window.desktopPet.getName().then((name) => {
  if (typeof name === 'string' && name !== '') {
    document.querySelector('.chat-head span').textContent = name
    document.title = name
    input.placeholder = `和${name}聊天…`
  }
}).catch(() => {})

let expanded = false
let anchorCleanup = null

/** The pet's layout bottom edge, window-relative (offset* ignores transforms). */
function petBottom() {
  return pet.offsetTop + pet.offsetHeight
}

/** The pet's layout horizontal center, window-relative. */
function petCenterX() {
  return pet.offsetLeft + pet.offsetWidth / 2
}

/**
 * Re-anchor the pet to a pre-toggle screen position after the window resize
 * lands. The pet is bottom-aligned and horizontally centered, so growing the
 * window (the chat panel appears below the pet, and the window gets wider)
 * would make it jump; a measured correction also absorbs the OS clamping a
 * window that would grow past a screen edge. Rapid toggles cancel the
 * previous pending correction.
 */
function reanchor(keepX, keepY) {
  if (anchorCleanup !== null) {
    clearTimeout(anchorCleanup.timer)
    window.removeEventListener('resize', anchorCleanup.onResize)
  }
  let corrected = false
  const correct = () => {
    if (corrected) return
    corrected = true
    if (anchorCleanup !== null) {
      clearTimeout(anchorCleanup.timer)
      window.removeEventListener('resize', anchorCleanup.onResize)
      anchorCleanup = null
    }
    // Wait one frame so the new layout is final before moving the window.
    requestAnimationFrame(() => {
      window.desktopPet.moveTo(Math.round(keepX - petCenterX()), Math.round(keepY - petBottom()))
    })
  }
  const onResize = () => correct()
  anchorCleanup = { timer: setTimeout(correct, 400), onResize }
  window.addEventListener('resize', onResize)
}

/**
 * Expand or collapse the chat panel (and the window with it), keeping the
 * pet glued to its current screen position.
 */
function setExpanded(next) {
  expanded = next
  chat.classList.toggle('hidden', !expanded)
  const keepX = window.screenX + petCenterX()
  const keepY = window.screenY + petBottom()
  window.desktopPet.setExpanded(expanded)
  reanchor(keepX, keepY)
  if (expanded) input.focus()
}

// Single click also fires after a drag, so the chat toggles on double click.
pet.addEventListener('dblclick', () => setExpanded(!expanded))
// The X in the chat panel collapses it back to the pet (the pet keeps
// running); quit lives in the tray's right-click menu (or closing the app).
document.getElementById('close').addEventListener('click', () => setExpanded(false))

// The notifier plugin asks to bring the pet to the front with the chat open.
window.desktopPet.onExpand(() => setExpanded(true))

// Host-forwarded approval requests render as a card with 批准/拒绝 buttons.
let currentApprovalId = null
function showApproval(payload) {
  currentApprovalId = payload.requestId ?? null
  const parts = []
  if (payload.toolName) parts.push(`工具 ${payload.toolName} 需要审批`)
  if (payload.reason) parts.push(payload.reason)
  approvalText.textContent = parts.length > 0 ? parts.join('：') : '有审批请求待处理'
  approvalCard.classList.remove('hidden')
}
function hideApproval() {
  currentApprovalId = null
  approvalCard.classList.add('hidden')
}
function respondApproval(outcome) {
  if (currentApprovalId === null) return
  const requestId = currentApprovalId
  hideApproval()
  window.desktopPet.respondApproval(requestId, outcome)
}
window.desktopPet.onApproval(showApproval)
approveButton.addEventListener('click', () => respondApproval('allowed-once'))
rejectButton.addEventListener('click', () => respondApproval('rejected'))

// Custom window dragging. The pet opts out of the OS drag region so it can
// receive clicks; movement is applied in the main process.
// - pointerdown captures the pointer, so pointermove/pointerup keep firing
//   even when the cursor races outside the window during a fast drag;
// - the grab point is fixed relative to the window at pointerdown, and every
//   pointermove computes the ABSOLUTE target position
//   (screenX - grabOffsetX, screenY - grabOffsetY). Absolute positioning
//   instead of accumulated deltas keeps the drag 1:1 with the cursor even
//   when display scaling, an OS edge clamp, or the resize that happens when
//   the chat panel expands/collapses has moved the window: there is no stale
//   baseline to drift from, and any scale mismatch cancels out because the
//   grab offset and the cursor share the same coordinate units;
// - moves are COALESCED: pointermove can fire far faster than the window can
//   follow (and faster than IPC can deliver), so only the newest position is
//   kept and sent at most once per animation frame. Intermediate positions
//   are dropped — with absolute coordinates that is safe, the last one wins,
//   and the window never plays catch-up behind a backlog;
// - `event.buttons` ends a drag whose button was released outside the window;
// - `lostpointercapture` covers Windows dropping the capture while the window
//   moves under the pointer during a fast drag.
let dragging = false
let grabOffsetX = 0
let grabOffsetY = 0
let pendingDragX = null
let pendingDragY = null
let dragFrame = null

/** Send the newest pending target (if any) to the main process. */
function flushDrag() {
  dragFrame = null
  if (pendingDragX === null || pendingDragY === null) return
  const x = pendingDragX
  const y = pendingDragY
  pendingDragX = null
  pendingDragY = null
  window.desktopPet.dragTo(x, y)
}

pet.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  dragging = true
  grabOffsetX = event.screenX - window.screenX
  grabOffsetY = event.screenY - window.screenY
  try {
    pet.setPointerCapture(event.pointerId)
  } catch {
    // Best-effort; window-level listeners still handle the drag.
  }
})
window.addEventListener('pointermove', (event) => {
  if (!dragging) return
  // Button no longer held (released outside the window): end the drag.
  if ((event.buttons & 1) === 0) {
    endDrag()
    return
  }
  pendingDragX = event.screenX - grabOffsetX
  pendingDragY = event.screenY - grabOffsetY
  if (dragFrame === null) {
    dragFrame = requestAnimationFrame(flushDrag)
  }
})
const endDrag = () => {
  dragging = false
  if (dragFrame !== null) {
    cancelAnimationFrame(dragFrame)
    dragFrame = null
  }
  // Deliver the final pending position so the window lands exactly under
  // the cursor (covers a rAF that never fired before the drag ended).
  flushDrag()
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)
window.addEventListener('lostpointercapture', endDrag)
window.addEventListener('blur', endDrag)

/** Append one message row to the chat log. */
function appendMessage(role, text) {
  const row = document.createElement('div')
  row.className = `msg ${role}`
  row.textContent = text
  log.append(row)
  log.scrollTop = log.scrollHeight
}

/** Unwrap Electron's invoke-error prefix so the raw bridge message shows. */
function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const marker = message.lastIndexOf('Error: ')
  return marker === -1 ? message : message.slice(marker + 'Error: '.length)
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (text === '') return
  input.value = ''
  appendMessage('user', text)
  input.disabled = true
  sendButton.disabled = true
  window.desktopPet.prompt(text)
    .then((reply) => appendMessage('assistant', reply === '' ? '（这一轮没有文本回复）' : reply))
    .catch((error) => appendMessage('error', cleanError(error)))
    .finally(() => {
      input.disabled = false
      sendButton.disabled = false
      input.focus()
    })
})

// ---------- todo panel ----------
const todoToggle = document.getElementById('todo-toggle')
const todoPanel = document.getElementById('todo')
const todoList = document.getElementById('todo-list')
const todoEmpty = document.getElementById('todo-empty')
const todoForm = document.getElementById('todo-form')
const todoInput = document.getElementById('todo-input')
let todoPanelActive = false

/** Render the todo list; the button badge shows the number of open items. */
function renderTodos(items) {
  todoList.textContent = ''
  for (const item of items) {
    const row = document.createElement('div')
    row.className = `todo-item${item.done ? ' done' : ''}`
    const checkbox = document.createElement('button')
    checkbox.type = 'button'
    checkbox.className = 'todo-check'
    checkbox.textContent = item.done ? '✓' : ''
    checkbox.title = item.done ? '标记为未完成' : '标记为完成'
    checkbox.addEventListener('click', () => {
      window.desktopPet.todo.toggle(item.id).catch(() => {})
    })
    const label = document.createElement('span')
    label.className = 'todo-text'
    label.textContent = item.text
    label.title = item.text
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'todo-del'
    del.textContent = '×'
    del.title = '删除这条待办'
    del.addEventListener('click', () => {
      window.desktopPet.todo.remove(item.id).catch(() => {})
    })
    row.append(checkbox, label, del)
    todoList.append(row)
  }
  todoEmpty.classList.toggle('hidden', items.length > 0)
  const open = items.filter((item) => !item.done).length
  todoToggle.textContent = open > 0 ? `待办(${open})` : '待办'
  todoToggle.classList.toggle('active', todoPanelActive && open > 0)
}

// Live sync: chat commands ("记个待办：X") update the panel too.
window.desktopPet.todo.onChanged(renderTodos)
// The todo plugin may be disabled; then the IPC handlers do not exist.
window.desktopPet.todo.list().then(renderTodos).catch(() => {
  todoToggle.classList.add('hidden')
})

todoToggle.addEventListener('click', () => {
  todoPanelActive = !todoPanelActive
  todoPanel.classList.toggle('hidden', !todoPanelActive)
  log.classList.toggle('hidden', todoPanelActive)
  form.classList.toggle('hidden', todoPanelActive)
  todoToggle.classList.toggle('active', todoPanelActive)
  if (todoPanelActive) todoInput.focus()
})

todoForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = todoInput.value.trim()
  if (text === '') return
  todoInput.value = ''
  window.desktopPet.todo.add(text).catch(() => {})
})
