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

/** Expand or collapse the chat panel (and the window with it). */
function setExpanded(next) {
  expanded = next
  chat.classList.toggle('hidden', !expanded)
  window.desktopPet.setExpanded(expanded)
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
// - move/up also listen on `window`, so the drag still works if capture is
//   unavailable (best-effort);
// - `event.buttons` ends a drag whose button was released outside the window.
let dragging = false
let dragStartX = 0
let dragStartY = 0
pet.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  dragging = true
  dragStartX = event.screenX
  dragStartY = event.screenY
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
    dragging = false
    return
  }
  const dx = event.screenX - dragStartX
  const dy = event.screenY - dragStartY
  if (dx === 0 && dy === 0) return
  dragStartX = event.screenX
  dragStartY = event.screenY
  window.desktopPet.dragBy(dx, dy)
})
const endDrag = () => {
  dragging = false
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)
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
