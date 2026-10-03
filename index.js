window.onload = () => {
  const qrc = qrcodegen // nayuki-dist.js
  const qrCanvas = document.getElementById("qr-canvas")
  const qrCtx = qrCanvas.getContext("2d")
  const stencilCanvas = document.getElementById("stencil-canvas")
  const stencilCtx = stencilCanvas.getContext("2d")

  const CANVAS_SIZE = 800
  qrCanvas.width = CANVAS_SIZE
  qrCanvas.height = CANVAS_SIZE
  stencilCanvas.width = CANVAS_SIZE
  stencilCanvas.height = CANVAS_SIZE

  let qrCodeObj = null
  let customPaddingBits = []
  let textBitsLength = 0
  let dataCapacityBits = 0
  let padStartLength = 0
  let padEndLength = 0
  let indexToCoord = {}
  let currentMapVersion = null
  let gridMap = []
  let interleaveMap = null

  let stencilImg = new Image()
  let stencilLoaded = false

  const verSelect = document.getElementById("ctrl-version")
  for (let i = 1; i <= 40; i++) {
    const opt = document.createElement("option"); opt.value = i; opt.innerText = `v${i}`
    if (i === 40) opt.selected = true
    verSelect.appendChild(opt)
  }

  const stringToBits = (str) => {
    const bytes = new TextEncoder().encode(str); const bits = []
    for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)
    return bits
  }

  const getInterleaveMap = (v, eclObj) => {
    const D = qrc.QrCode.getNumDataCodewords(v, eclObj)
    const B = qrc.QrCode.NUM_ERROR_CORRECTION_BLOCKS[eclObj.ordinal][v]
    const B1 = B - (D % B), D1 = Math.floor(D / B)
    const blockLengths = [], logicalStarts = []
    let currentStart = 0
    for (let j = 0; j < B; j++) {
      const len = (j < B1) ? D1 : D1 + 1
      blockLengths.push(len); logicalStarts.push(currentStart); currentStart += len
    }
    const logicalToInterleaved = new Array(D), interleavedToLogical = new Array(D)
    let interleavedIdx = 0
    for (let i = 0; i <= D1; i++) {
      for (let j = 0; j < B; j++) {
        if (i < blockLengths[j]) {
          const logicalIdx = logicalStarts[j] + i
          logicalToInterleaved[logicalIdx] = interleavedIdx
          interleavedToLogical[interleavedIdx] = logicalIdx
          interleavedIdx++
        }
      }
    }
    return { logicalToInterleaved, interleavedToLogical }
  }

  const buildGridMap = (v) => {
    if (currentMapVersion === v) return
    const size = 4 * v + 17
    gridMap = Array(size).fill(null).map(() => Array(size).fill(null))
    indexToCoord = {}
    const alignCenters = (() => {
      if (v === 1) return []
      const last = size - 7, count = Math.floor(v / 7) + 2
      let step = Math.round((last - 6) / (count - 1)); if (step % 2 !== 0) step++
      const temp = []
      for (let i = 0; i < count - 1; i++) temp.unshift(last - i * step)
      return [6].concat(temp)
    })()

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8)) gridMap[y][x] = { area: "finder" }
        else if ((x === 8 && y <= 8 && y !== 6) || (y === 8 && x <= 8 && x !== 6) || (x >= size - 8 && y === 8) || (x === 8 && y >= size - 7)) gridMap[y][x] = { area: "format" }
        else if (x === 8 && y === size - 8) gridMap[y][x] = { area: "dark" }
        else if (x === 6 || y === 6) gridMap[y][x] = { area: "timing" }
        else if (v >= 7 && ((x >= size - 11 && x <= size - 9 && y <= 5) || (x <= 5 && y >= size - 11 && y <= size - 9))) gridMap[y][x] = { area: "version" }
        else {
          for (const cx of alignCenters) {
            for (const cy of alignCenters) {
              if ((cx === 6 && cy === 6) || (cx === size - 7 && cy === 6) || (cx === 6 && cy === size - 7)) continue
              if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) gridMap[y][x] = { area: "alignment" }
            }
          }
        }
      }
    }
    let cx = size - 1, cy = size - 1, goingUp = true, idx = 0
    while (cx >= 0) {
      if (cx === 6) cx--
      for (let c = 0; c < 2; c++) {
        const tx = cx - c, ty = cy
        if (gridMap[ty][tx] === null) {
          gridMap[ty][tx] = { area: "data", bitIndex: idx }; indexToCoord[idx] = { x: tx, y: ty }; idx++
        }
      }
      if (goingUp) { cy--; if (cy < 0) { cy = 0; goingUp = false; cx -= 2 } }
      else { cy++; if (cy >= size) { cy = size - 1; goingUp = true; cx -= 2 } }
    }
    currentMapVersion = v
  }

  const getMaskBit = (mask, x, y) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0
      case 1: return y % 2 === 0
      case 2: return x % 3 === 0
      case 3: return (x + y) % 3 === 0
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    }
    return false
  }

  const checkWoundTarget = (x, y, woundTarget) => {
    const info = gridMap[y][x]
    if (!info) return false

    const isBone = info.area !== "data"
    let isPadding = false
    let isData = false

    if (!isBone) {
      if (info.bitIndex < dataCapacityBits) {
        const logicalByte = interleaveMap.interleavedToLogical[Math.floor(info.bitIndex / 8)]
        const padIdx = (logicalByte * 8 + (info.bitIndex % 8)) - textBitsLength
        const numPaddingBits = dataCapacityBits - textBitsLength
        if (padIdx >= padStartLength && padIdx < numPaddingBits - padEndLength) {
          isPadding = true
        } else {
          isData = true
        }
      } else {
        isData = true
      }
    }

    if (isPadding) return true
    if (isBone && (woundTarget === "structural" || woundTarget === "both")) return true
    if (isData && (woundTarget === "data" || woundTarget === "both")) return true

    return false
  }

  const buildQrObject = (paddingBitsOverride = null) => {
    const v = parseInt(document.getElementById("ctrl-version").value)
    const eclObj = qrc.QrCode.Ecc[document.getElementById("ctrl-ecl").value]
    const mask = parseInt(document.getElementById("ctrl-mask").value)
    const text = document.getElementById("ctrl-text").value
    const textMode = document.getElementById("ctrl-text-mode").value

    dataCapacityBits = qrc.QrCode.getNumDataCodewords(v, eclObj) * 8
    interleaveMap = getInterleaveMap(v, eclObj)

    const packedBits = []
    const append = (val, len) => { for (let i = len - 1; i >= 0; i--) packedBits.push((val >>> i) & 1) }

    if (document.getElementById("ctrl-sa-enable").checked) {
      append(3, 4)
      append(parseInt(document.getElementById("ctrl-sa-seq").value) || 0, 4)
      append((parseInt(document.getElementById("ctrl-sa-tot").value) || 1) - 1, 4)
      append(parseInt(document.getElementById("ctrl-sa-par").value) || 0, 8)
    }

    let segs
    try {
      if (textMode === "numeric") segs = [qrc.QrSegment.makeNumeric(text)]
      else if (textMode === "alphanumeric") segs = [qrc.QrSegment.makeAlphanumeric(text)]
      else if (textMode === "byte") {
        const bytes = Array.from(new TextEncoder().encode(text))
        segs = [qrc.QrSegment.makeBytes(bytes)]
      }
      else segs = qrc.QrSegment.makeSegments(text)
    } catch (e) {
      console.warn(`Text cannot be encoded in ${textMode} mode, falling back to auto.`)
      segs = qrc.QrSegment.makeSegments(text)
    }

    for (const seg of segs) {
      append(seg.mode.modeBits, 4)
      append(seg.numChars, seg.mode.numCharCountBits(v))
      for (const b of seg.bitData) packedBits.push(b)
    }

    const termLen = Math.min(4, dataCapacityBits - packedBits.length)
    for (let i = 0; i < termLen; i++) packedBits.push(0)
    while (packedBits.length % 8 !== 0) packedBits.push(0)

    textBitsLength = packedBits.length
    const numPadBits = dataCapacityBits - textBitsLength

    if (customPaddingBits.length !== numPadBits) {
      customPaddingBits = []
      for (let i = 0; i < numPadBits; i++) customPaddingBits.push((((Math.floor(i / 8) % 2 === 0) ? 236 : 17) >> (7 - (i % 8))) & 1)
    }

    const sBits = stringToBits(document.getElementById("ctrl-pad-start").value)
    const eBits = stringToBits(document.getElementById("ctrl-pad-end").value)

    padStartLength = Math.min(sBits.length, numPadBits)
    padEndLength = Math.min(eBits.length, numPadBits - padStartLength)

    for (let i = 0; i < padStartLength; i++) customPaddingBits[i] = sBits[i]
    const eStart = numPadBits - padEndLength
    for (let i = 0; i < padEndLength; i++) customPaddingBits[eStart + i] = eBits[i]

    const activePadding = paddingBitsOverride || customPaddingBits
    for (let i = 0; i < numPadBits; i++) packedBits.push(activePadding[i])

    const dataCodewords = []
    for (let i = 0; i < dataCapacityBits / 8; i++) {
      let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | packedBits[i * 8 + j]; dataCodewords.push(b)
    }

    buildGridMap(v)
    return new qrc.QrCode(v, eclObj, dataCodewords, mask)
  }

  const generateQR = () => { qrCodeObj = buildQrObject(); drawCanvas() }

  const drawCanvas = () => {
    const size = qrCodeObj.size, scale = CANVAS_SIZE / size
    qrCtx.fillStyle = "#ffffff"; qrCtx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    const numPaddingBits = dataCapacityBits - textBitsLength

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const isDark = qrCodeObj.getModule(x, y), info = gridMap[y][x]
        let color = isDark ? "#000000" : "#ffffff"

        if (info.area !== "data") color = isDark ? "#b30000" : "#ffcccc"
        else {
          if (info.bitIndex < dataCapacityBits) {
            const logicalByte = interleaveMap.interleavedToLogical[Math.floor(info.bitIndex / 8)]
            const logicalBitIdx = logicalByte * 8 + (info.bitIndex % 8)
            if (logicalBitIdx < textBitsLength) color = isDark ? "#0044cc" : "#cce0ff"
            else {
              const padIdx = logicalBitIdx - textBitsLength
              if (padIdx < padStartLength || padIdx >= numPaddingBits - padEndLength) color = isDark ? "#ff8c00" : "#ffebcc"
              else color = isDark ? "#008800" : "#ccffcc"
            }
          } else color = isDark ? "#cc6600" : "#ffe6cc"
        }
        qrCtx.fillStyle = color
        qrCtx.fillRect(x * scale, y * scale, scale + 0.5, scale + 0.5)
      }
    }
  }

  qrCanvas.addEventListener("click", e => {
    if (!qrCodeObj) return
    const rect = qrCanvas.getBoundingClientRect(), displayScale = rect.width / qrCodeObj.size
    const tx = Math.floor((e.clientX - rect.left) / displayScale), ty = Math.floor((e.clientY - rect.top) / displayScale)
    if (tx >= 0 && tx < qrCodeObj.size && ty >= 0 && ty < qrCodeObj.size) {
      const info = gridMap[ty][tx]
      if (info.area === "data" && info.bitIndex < dataCapacityBits) {
        const padIdx = (interleaveMap.interleavedToLogical[Math.floor(info.bitIndex / 8)] * 8 + (info.bitIndex % 8)) - textBitsLength
        if (padIdx >= padStartLength && padIdx < (dataCapacityBits - textBitsLength) - padEndLength) {
          customPaddingBits[padIdx] ^= 1; generateQR()
        }
      }
    }
  })

  document.getElementById("btn-whiteout").addEventListener("click", () => {
    const mask = parseInt(document.getElementById("ctrl-mask").value)
    for (let padIdx = padStartLength; padIdx < (dataCapacityBits - textBitsLength) - padEndLength; padIdx++) {
      const logicalBitIdx = textBitsLength + padIdx
      const interleavedByte = interleaveMap.logicalToInterleaved[Math.floor(logicalBitIdx / 8)]
      const coord = indexToCoord[interleavedByte * 8 + (logicalBitIdx % 8)]
      if (coord) customPaddingBits[padIdx] = getMaskBit(mask, coord.x, coord.y) ? 1 : 0
    }
    generateQR()
  })

  const switchPanel = (showId) => {
    ["panel-generator", "panel-stencil", "panel-mask", "panel-qr-stencil"].forEach(id => {
      document.getElementById(id).style.display = (id === showId) ? "flex" : "none"
    })
    stencilCanvas.style.display = (showId === "panel-generator") ? "none" : "block"
  }

  document.getElementById("btn-open-stencil").addEventListener("click", () => { switchPanel("panel-stencil"); updateStencilPreview() })
  document.getElementById("btn-cancel-stencil").addEventListener("click", () => switchPanel("panel-generator"))
  document.getElementById("btn-open-mask").addEventListener("click", () => { switchPanel("panel-mask"); updateMaskPreview() })
  document.getElementById("btn-cancel-mask").addEventListener("click", () => switchPanel("panel-generator"))
  document.getElementById("btn-cancel-qr").addEventListener("click", () => switchPanel("panel-generator"))

  const refreshSavedMatrices = () => {
    const select = document.getElementById("ctrl-qr-select")
    select.innerHTML = ""
    const saves = JSON.parse(localStorage.getItem("qr_matrices") || "{}")
    for (const name in saves) {
      const opt = document.createElement("option"); opt.value = name; opt.innerText = name
      select.appendChild(opt)
    }
  }

  document.getElementById("btn-save-qr").addEventListener("click", () => {
    if (!qrCodeObj) return
    const size = qrCodeObj.size, matrix = []
    for (let y = 0; y < size; y++) {
      matrix[y] = []; for (let x = 0; x < size; x++) matrix[y][x] = qrCodeObj.getModule(x, y) ? 1 : 0
    }
    const name = `QR_v${qrCodeObj.version}_${new Date().toLocaleTimeString()}`
    const saves = JSON.parse(localStorage.getItem("qr_matrices") || "{}")
    saves[name] = matrix
    localStorage.setItem("qr_matrices", JSON.stringify(saves))
    refreshSavedMatrices()
    alert(`Saved as ${name}`)
  })

  document.getElementById("btn-open-qr-stencil").addEventListener("click", () => {
    refreshSavedMatrices()
    switchPanel("panel-qr-stencil")
    updateQrPreview()
  })

  document.getElementById("ctrl-file").addEventListener("change", e => {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = event => {
      stencilImg.onload = () => {
        stencilLoaded = true
        document.getElementById("ctrl-scale").value = 1; document.getElementById("ctrl-x").value = 0; document.getElementById("ctrl-y").value = 0; document.getElementById("ctrl-rot").value = 0
        updateStencilPreview()
      }
      stencilImg.src = event.target.result
    }
    reader.readAsDataURL(file)
  })

  const updateStencilPreview = () => {
    if (!stencilLoaded) return
    stencilCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    const scale = parseFloat(document.getElementById("ctrl-scale").value)
    const dx = parseInt(document.getElementById("ctrl-x").value), dy = parseInt(document.getElementById("ctrl-y").value)
    const rot = parseInt(document.getElementById("ctrl-rot").value) || 0
    const thresh = parseInt(document.getElementById("ctrl-thresh").value), invert = document.getElementById("ctrl-invert-stencil").checked
    const woundTarget = document.getElementById("ctrl-img-wound").value

    document.getElementById("lbl-scale").innerText = scale.toFixed(2)
    document.getElementById("lbl-x").innerText = dx; document.getElementById("lbl-y").innerText = dy
    document.getElementById("lbl-thresh").innerText = thresh

    const offscreen = document.createElement("canvas"); offscreen.width = CANVAS_SIZE; offscreen.height = CANVAS_SIZE
    const oCtx = offscreen.getContext("2d"), w = stencilImg.width * scale, h = stencilImg.height * scale
    oCtx.save()
    oCtx.translate((CANVAS_SIZE / 2) + dx, (CANVAS_SIZE / 2) + dy)
    oCtx.rotate(rot * Math.PI / 180)
    oCtx.drawImage(stencilImg, -w / 2, -h / 2, w, h)
    oCtx.restore()

    const imgData = oCtx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data
    const qrSize = qrCodeObj.size, modScale = CANVAS_SIZE / qrSize

    stencilCtx.fillStyle = "rgba(255, 0, 255, 0.7)"
    for (let y = 0; y < qrSize; y++) {
      for (let x = 0; x < qrSize; x++) {
        if (checkWoundTarget(x, y, woundTarget)) {
          const i = (Math.floor((y + 0.5) * modScale) * CANVAS_SIZE + Math.floor((x + 0.5) * modScale)) * 4
          let trigger = false
          if (invert) trigger = imgData[i+3] <= 128 || ((imgData[i] + imgData[i+1] + imgData[i+2]) / 3) >= thresh
          else trigger = imgData[i+3] > 128 && ((imgData[i] + imgData[i+1] + imgData[i+2]) / 3) < thresh
          if (trigger) stencilCtx.fillRect(x * modScale, y * modScale, modScale + 0.5, modScale + 0.5)
        }
      }
    }
  }
  ["ctrl-scale", "ctrl-x", "ctrl-y", "ctrl-thresh", "ctrl-invert-stencil", "ctrl-img-wound", "ctrl-rot"].forEach(id => document.getElementById(id).addEventListener("input", updateStencilPreview))

  const applyStencilToPadding = (paddingArray) => {
    if (!stencilLoaded) return false
    const scale = parseFloat(document.getElementById("ctrl-scale").value), dx = parseInt(document.getElementById("ctrl-x").value), dy = parseInt(document.getElementById("ctrl-y").value)
    const rot = parseInt(document.getElementById("ctrl-rot").value) || 0
    const thresh = parseInt(document.getElementById("ctrl-thresh").value), mode = document.getElementById("ctrl-blend").value, invert = document.getElementById("ctrl-invert-stencil").checked
    const forceMask = parseInt(document.getElementById("ctrl-mask").value)
    const offscreen = document.createElement("canvas"); offscreen.width = CANVAS_SIZE; offscreen.height = CANVAS_SIZE
    const oCtx = offscreen.getContext("2d"), w = stencilImg.width * scale, h = stencilImg.height * scale
    oCtx.save()
    oCtx.translate((CANVAS_SIZE / 2) + dx, (CANVAS_SIZE / 2) + dy)
    oCtx.rotate(rot * Math.PI / 180)
    oCtx.drawImage(stencilImg, -w / 2, -h / 2, w, h)
    oCtx.restore()

    const imgData = oCtx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data, qrSize = qrCodeObj.size, modScale = CANVAS_SIZE / qrSize
    let changed = false
    for (let y = 0; y < qrSize; y++) {
      for (let x = 0; x < qrSize; x++) {
        const info = gridMap[y][x]
        if (info && info.area === "data" && info.bitIndex < dataCapacityBits) {
          const padIdx = (interleaveMap.interleavedToLogical[Math.floor(info.bitIndex / 8)] * 8 + (info.bitIndex % 8)) - textBitsLength
          if (padIdx >= padStartLength && padIdx < (dataCapacityBits - textBitsLength) - padEndLength) {
            const i = (Math.floor((y + 0.5) * modScale) * CANVAS_SIZE + Math.floor((x + 0.5) * modScale)) * 4
            let trigger = false
            if (invert) trigger = imgData[i+3] <= 128 || ((imgData[i] + imgData[i+1] + imgData[i+2]) / 3) >= thresh
            else trigger = imgData[i+3] > 128 && ((imgData[i] + imgData[i+1] + imgData[i+2]) / 3) < thresh
            if (trigger) {
              const mBit = getMaskBit(forceMask, x, y)
              if (mode === "draw") paddingArray[padIdx] = mBit ? 0 : 1
              else if (mode === "erase") paddingArray[padIdx] = mBit ? 1 : 0
              else if (mode === "xor") paddingArray[padIdx] ^= 1
              changed = true
            }
          }
        }
      }
    }
    return changed
  }
  document.getElementById("btn-commit").addEventListener("click", () => { if (applyStencilToPadding(customPaddingBits)) generateQR(); switchPanel("panel-generator") })

  const updateMaskPreview = () => {
    stencilCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    const mx = parseInt(document.getElementById("ctrl-mx").value), my = parseInt(document.getElementById("ctrl-my").value)
    const mw = parseInt(document.getElementById("ctrl-mw").value), mh = parseInt(document.getElementById("ctrl-mh").value)
    const sMask = parseInt(document.getElementById("ctrl-mask-algo").value)
    const woundTarget = document.getElementById("ctrl-mask-wound").value
    const qrSize = qrCodeObj.size, modScale = CANVAS_SIZE / qrSize
    stencilCtx.fillStyle = "rgba(255, 170, 0, 0.7)"

    for (let y = my; y < my + mh; y++) {
      for (let x = mx; x < mx + mw; x++) {
        if (x >= qrSize || y >= qrSize || x < 0 || y < 0) continue
        if (checkWoundTarget(x, y, woundTarget)) {
          if (getMaskBit(sMask, x, y)) stencilCtx.fillRect(x * modScale, y * modScale, modScale + 0.5, modScale + 0.5)
        }
      }
    }
  }
  ["ctrl-mx", "ctrl-my", "ctrl-mw", "ctrl-mh", "ctrl-mask-algo", "ctrl-mask-wound"].forEach(id => document.getElementById(id).addEventListener("input", updateMaskPreview))

  const applyMaskToPadding = (paddingArray) => {
    const mx = parseInt(document.getElementById("ctrl-mx").value), my = parseInt(document.getElementById("ctrl-my").value)
    const mw = parseInt(document.getElementById("ctrl-mw").value), mh = parseInt(document.getElementById("ctrl-mh").value)
    const sMask = parseInt(document.getElementById("ctrl-mask-algo").value), mode = document.getElementById("ctrl-mblend").value, primaryMask = parseInt(document.getElementById("ctrl-mask").value)
    const qrSize = qrCodeObj.size, numPaddingBits = dataCapacityBits - textBitsLength
    let changed = false
    for (let y = my; y < my + mh; y++) {
      for (let x = mx; x < mx + mw; x++) {
        if (x >= qrSize || y >= qrSize || x < 0 || y < 0) continue
        const info = gridMap[y][x]
        if (info && info.area === "data" && info.bitIndex < dataCapacityBits) {
          const padIdx = (interleaveMap.interleavedToLogical[Math.floor(info.bitIndex / 8)] * 8 + (info.bitIndex % 8)) - textBitsLength
          if (padIdx >= padStartLength && padIdx < numPaddingBits - padEndLength) {
            const sMaskBit = getMaskBit(sMask, x, y), pMaskBit = getMaskBit(primaryMask, x, y)
            if (mode === "draw") paddingArray[padIdx] = (sMaskBit !== pMaskBit) ? 1 : 0
            else if (mode === "erase") paddingArray[padIdx] = (sMaskBit === pMaskBit) ? 1 : 0
            else if (mode === "xor" && sMaskBit) paddingArray[padIdx] ^= 1
            changed = true
          }
        }
      }
    }
    return changed
  }
  document.getElementById("btn-commit-mask").addEventListener("click", () => { if (applyMaskToPadding(customPaddingBits)) generateQR(); switchPanel("panel-generator") })

  const updateQrPreview = () => {
    stencilCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    const selectedName = document.getElementById("ctrl-qr-select").value
    if (!selectedName) return
    const saves = JSON.parse(localStorage.getItem("qr_matrices") || "{}")
    const savedMatrix = saves[selectedName]
    if (!savedMatrix) return

    const scale = parseInt(document.getElementById("ctrl-qscale").value)
    const dx = parseInt(document.getElementById("ctrl-qx").value), dy = parseInt(document.getElementById("ctrl-qy").value)
    const qrot = parseInt(document.getElementById("ctrl-qrot").value) || 0
    const invert = document.getElementById("ctrl-invert-qr").checked
    const woundTarget = document.getElementById("ctrl-qr-wound").value

    document.getElementById("lbl-qscale").innerText = scale
    document.getElementById("lbl-qx").innerText = dx; document.getElementById("lbl-qy").innerText = dy

    const qrSize = qrCodeObj.size, modScale = CANVAS_SIZE / qrSize, stencilSize = savedMatrix.length
    stencilCtx.fillStyle = "rgba(0, 255, 255, 0.7)"

    for (let y = 0; y < qrSize; y++) {
      for (let x = 0; x < qrSize; x++) {
        if (checkWoundTarget(x, y, woundTarget)) {
          const sx = Math.floor((x - dx) / scale), sy = Math.floor((y - dy) / scale)
          if (sx >= 0 && sx < stencilSize && sy >= 0 && sy < stencilSize) {
            let rsx = sx, rsy = sy
            if (qrot === 90) { rsx = sy; rsy = stencilSize - 1 - sx }
            else if (qrot === 180) { rsx = stencilSize - 1 - sx; rsy = stencilSize - 1 - sy }
            else if (qrot === 270) { rsx = stencilSize - 1 - sy; rsy = sx }

            if (savedMatrix[rsy][rsx] === (invert ? 0 : 1)) {
              stencilCtx.fillRect(x * modScale, y * modScale, modScale + 0.5, modScale + 0.5)
            }
          }
        }
      }
    }
  }
  ["ctrl-qr-select", "ctrl-qscale", "ctrl-qx", "ctrl-qy", "ctrl-invert-qr", "ctrl-qr-wound", "ctrl-qrot"].forEach(id => document.getElementById(id).addEventListener("input", updateQrPreview))

  const applyQrStencilToPadding = (paddingArray) => {
    const selectedName = document.getElementById("ctrl-qr-select").value
    if (!selectedName) return false
    const saves = JSON.parse(localStorage.getItem("qr_matrices") || "{}")
    const savedMatrix = saves[selectedName]
    if (!savedMatrix) return false

    const scale = parseInt(document.getElementById("ctrl-qscale").value)
    const dx = parseInt(document.getElementById("ctrl-qx").value), dy = parseInt(document.getElementById("ctrl-qy").value)
    const qrot = parseInt(document.getElementById("ctrl-qrot").value) || 0
    const invert = document.getElementById("ctrl-invert-qr").checked, mode = document.getElementById("ctrl-qblend").value
    const primaryMask = parseInt(document.getElementById("ctrl-mask").value)

    const qrSize = qrCodeObj.size, stencilSize = savedMatrix.length
    let changed = false

    for (let y = 0; y < qrSize; y++) {
      for (let x = 0; x < qrSize; x++) {
        const info = gridMap[y][x]
        if (info && info.area === "data" && info.bitIndex < dataCapacityBits) {
          const padIdx = (interleaveMap.interleavedToLogical[Math.floor(info.bitIndex / 8)] * 8 + (info.bitIndex % 8)) - textBitsLength
          if (padIdx >= padStartLength && padIdx < (dataCapacityBits - textBitsLength) - padEndLength) {
            const sx = Math.floor((x - dx) / scale), sy = Math.floor((y - dy) / scale)
            if (sx >= 0 && sx < stencilSize && sy >= 0 && sy < stencilSize) {
              let rsx = sx, rsy = sy
              if (qrot === 90) { rsx = sy; rsy = stencilSize - 1 - sx }
              else if (qrot === 180) { rsx = stencilSize - 1 - sx; rsy = stencilSize - 1 - sy }
              else if (qrot === 270) { rsx = stencilSize - 1 - sy; rsy = sx }

              if (savedMatrix[rsy][rsx] === (invert ? 0 : 1)) {
                const mBit = getMaskBit(primaryMask, x, y)
                if (mode === "draw") paddingArray[padIdx] = mBit ? 0 : 1
                else if (mode === "erase") paddingArray[padIdx] = mBit ? 1 : 0
                else if (mode === "xor") paddingArray[padIdx] ^= 1
                changed = true
              }
            }
          }
        }
      }
    }
    return changed
  }
  document.getElementById("btn-commit-qr").addEventListener("click", () => { if (applyQrStencilToPadding(customPaddingBits)) generateQR(); switchPanel("panel-generator") })

  const exportQrImage = () => {
    const offscreen = document.createElement("canvas"), quiet = 4, size = qrCodeObj.size, scale = 10
    offscreen.width = (size + quiet * 2) * scale; offscreen.height = (size + quiet * 2) * scale
    const ctx = offscreen.getContext("2d")
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, offscreen.width, offscreen.height)
    ctx.fillStyle = "#000000"
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (qrCodeObj.getModule(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)
    }
    const link = document.createElement("a"); link.download = `matrix-qr-v${qrCodeObj.version}.png`; link.href = offscreen.toDataURL(); link.click()
  }

  const exportWoundedQrImage = (source) => {
    const size = qrCodeObj.size
    const modules = []
    for (let y = 0; y < size; y++) {
      modules[y] = []; for (let x = 0; x < size; x++) modules[y][x] = qrCodeObj.getModule(x, y)
    }

    let woundTarget = "none"
    if (source === "stencil") woundTarget = document.getElementById("ctrl-img-wound").value
    else if (source === "mask") woundTarget = document.getElementById("ctrl-mask-wound").value
    else if (source === "qr") woundTarget = document.getElementById("ctrl-qr-wound").value

    if (source === "stencil" && stencilLoaded) {
      const scale = parseFloat(document.getElementById("ctrl-scale").value), dx = parseInt(document.getElementById("ctrl-x").value), dy = parseInt(document.getElementById("ctrl-y").value)
      const rot = parseInt(document.getElementById("ctrl-rot").value) || 0
      const thresh = parseInt(document.getElementById("ctrl-thresh").value), mode = document.getElementById("ctrl-blend").value, invert = document.getElementById("ctrl-invert-stencil").checked
      const offscreen = document.createElement("canvas"); offscreen.width = CANVAS_SIZE; offscreen.height = CANVAS_SIZE
      const oCtx = offscreen.getContext("2d"), w = stencilImg.width * scale, h = stencilImg.height * scale
      oCtx.save()
      oCtx.translate((CANVAS_SIZE / 2) + dx, (CANVAS_SIZE / 2) + dy)
      oCtx.rotate(rot * Math.PI / 180)
      oCtx.drawImage(stencilImg, -w / 2, -h / 2, w, h)
      oCtx.restore()

      const imgData = oCtx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data, modScale = CANVAS_SIZE / size
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (checkWoundTarget(x, y, woundTarget)) {
            const i = (Math.floor((y + 0.5) * modScale) * CANVAS_SIZE + Math.floor((x + 0.5) * modScale)) * 4
            let trigger = false
            if (invert) trigger = imgData[i+3] <= 128 || ((imgData[i] + imgData[i+1] + imgData[i+2]) / 3) >= thresh
            else trigger = imgData[i+3] > 128 && ((imgData[i] + imgData[i+1] + imgData[i+2]) / 3) < thresh
            if (trigger) {
              if (mode === "draw") modules[y][x] = true; else if (mode === "erase") modules[y][x] = false; else if (mode === "xor") modules[y][x] = !modules[y][x]
            }
          }
        }
      }
    } else if (source === "mask") {
      const mx = parseInt(document.getElementById("ctrl-mx").value), my = parseInt(document.getElementById("ctrl-my").value)
      const mw = parseInt(document.getElementById("ctrl-mw").value), mh = parseInt(document.getElementById("ctrl-mh").value)
      const sMask = parseInt(document.getElementById("ctrl-mask-algo").value), mode = document.getElementById("ctrl-mblend").value
      for (let y = my; y < my + mh; y++) {
        for (let x = mx; x < mx + mw; x++) {
          if (x >= size || y >= size || x < 0 || y < 0) continue
          if (checkWoundTarget(x, y, woundTarget)) {
            const sMaskBit = getMaskBit(sMask, x, y)
            if (mode === "draw") modules[y][x] = sMaskBit; else if (mode === "erase") modules[y][x] = !sMaskBit; else if (mode === "xor" && sMaskBit) modules[y][x] = !modules[y][x]
          }
        }
      }
    } else if (source === "qr") {
      const selectedName = document.getElementById("ctrl-qr-select").value
      const saves = JSON.parse(localStorage.getItem("qr_matrices") || "{}"); const savedMatrix = saves[selectedName]
      if (savedMatrix) {
        const scale = parseInt(document.getElementById("ctrl-qscale").value)
        const dx = parseInt(document.getElementById("ctrl-qx").value), dy = parseInt(document.getElementById("ctrl-qy").value)
        const qrot = parseInt(document.getElementById("ctrl-qrot").value) || 0
        const invert = document.getElementById("ctrl-invert-qr").checked, mode = document.getElementById("ctrl-qblend").value
        const stencilSize = savedMatrix.length
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (checkWoundTarget(x, y, woundTarget)) {
              const sx = Math.floor((x - dx) / scale), sy = Math.floor((y - dy) / scale)
              if (sx >= 0 && sx < stencilSize && sy >= 0 && sy < stencilSize) {
                let rsx = sx, rsy = sy
                if (qrot === 90) { rsx = sy; rsy = stencilSize - 1 - sx }
                else if (qrot === 180) { rsx = stencilSize - 1 - sx; rsy = stencilSize - 1 - sy }
                else if (qrot === 270) { rsx = stencilSize - 1 - sy; rsy = sx }

                if (savedMatrix[rsy][rsx] === (invert ? 0 : 1)) {
                  if (mode === "draw") modules[y][x] = true; else if (mode === "erase") modules[y][x] = false; else if (mode === "xor") modules[y][x] = !modules[y][x]
                }
              }
            }
          }
        }
      }
    }

    const finalCanvas = document.createElement("canvas"), quiet = 4, scale = 10
    finalCanvas.width = (size + quiet * 2) * scale; finalCanvas.height = (size + quiet * 2) * scale
    const ctx = finalCanvas.getContext("2d")
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height)
    ctx.fillStyle = "#000000"
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)
    }
    const link = document.createElement("a"); link.download = `matrix-qr-v${qrCodeObj.version}-wound.png`; link.href = finalCanvas.toDataURL(); link.click()
  }

  document.getElementById("btn-download").addEventListener("click", exportQrImage)
  document.getElementById("btn-download-stencil").addEventListener("click", () => exportWoundedQrImage("stencil"))
  document.getElementById("btn-download-mask").addEventListener("click", () => exportWoundedQrImage("mask"))
  document.getElementById("btn-download-qr").addEventListener("click", () => exportWoundedQrImage("qr"))

  const structuralControls = ["ctrl-version", "ctrl-ecl", "ctrl-text", "ctrl-text-mode", "ctrl-pad-start", "ctrl-pad-end", "ctrl-sa-enable", "ctrl-sa-seq", "ctrl-sa-tot", "ctrl-sa-par"]
  structuralControls.forEach(id => {
    document.getElementById(id).addEventListener("change", () => { customPaddingBits = []; generateQR() })
  })
  document.getElementById("ctrl-mask").addEventListener("change", generateQR)

  generateQR()
}
