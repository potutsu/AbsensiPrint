import { useState, useEffect, useCallback } from 'react'
import * as XLSX from 'xlsx'

/* ═══════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════ */

const timeToMins = (t) => {
  if (!t || typeof t !== 'string') return null
  const parts = t.trim().split(':')
  if (parts.length < 2) return null
  const h = parseInt(parts[0]), m = parseInt(parts[1])
  if (isNaN(h) || isNaN(m)) return null
  return h * 60 + m
}

const minsToDisplay = (mins) => {
  if (!mins || mins <= 0) return '0'
  const h = Math.floor(mins / 60), m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}j`
  return `${h}j ${m}m`
}

const formatDate = (date) => {
  if (!date) return ''
  return `${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}`
}

const DEFAULT_SETTINGS = {
  scheduleStart: '08:00',
  scheduleEnd: '17:00',
  graceMinutes: '5',
  graceOutMinutes: '5',
  includeSaturday: false,
  printFontSize: 'normal',
  // Sheet column mapping
  sheetIndex: '4',
  blockWidth: '15',
  nameRow: '2',
  nameOffset: '9',
  idRow: '3',
  idOffset: '9',
  dataStartRow: '11',
  amInOffset: '1',
  amOutOffset: '3',
  pmInOffset: '6',
  pmOutOffset: '8',
  otInOffset: '10',
  otOutOffset: '12',
  // Bluetooth
  btPreset: 'generic',
  btServiceUUID: '0000ff00-0000-1000-8000-00805f9b34fb',
  btCharUUID: '0000ff02-0000-1000-8000-00805f9b34fb',
}

const BT_PRESETS = {
  generic:  { label: 'Generic BLE Printer',  svc: '0000ff00-0000-1000-8000-00805f9b34fb', chr: '0000ff02-0000-1000-8000-00805f9b34fb' },
  pt210:    { label: 'PT-210 / EC204',        svc: '000018f0-0000-1000-8000-00805f9b34fb', chr: '00002af1-0000-1000-8000-00805f9b34fb' },
  rongta:   { label: 'Rongta / Xprinter BLE', svc: '49535343-fe7d-4ae5-8fa9-9fafd205e455', chr: '49535343-8841-43f4-a8d4-ecbe34729bb3' },
  custom:   { label: 'Custom (manual)',        svc: '',                                     chr: '' },
}

/* ═══════════════════════════════════════════════════
   FILE PARSER
═══════════════════════════════════════════════════ */

function parseFile(workbook, s) {
  const idx = parseInt(s.sheetIndex)
  const sheetName = workbook.SheetNames[idx]
  if (!sheetName) throw new Error(`Sheet ke-${idx+1} tidak ditemukan. File ini hanya punya ${workbook.SheetNames.length} sheet.`)
  const sheet = workbook.Sheets[sheetName]
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

  // Parse period string
  let period = '', startDate = null
  for (const row of data.slice(0, 6)) {
    for (const cell of row) {
      if (typeof cell === 'string' && cell.includes('~')) {
        period = cell.trim()
        const m = period.match(/(\d{4})\/(\d{2})\/(\d{2})/)
        if (m) startDate = new Date(+m[1], +m[2] - 1, +m[3])
        break
      }
    }
    if (period) break
  }

  const bw     = parseInt(s.blockWidth)
  const nRow   = parseInt(s.nameRow)
  const nOff   = parseInt(s.nameOffset)
  const idRow  = parseInt(s.idRow)
  const idOff  = parseInt(s.idOffset)
  const dStart = parseInt(s.dataStartRow)

  const employees = []
  let blockCol = 0, attempts = 0

  while (attempts < 60) {
    attempts++
    const nameVal = String(data[nRow]?.[blockCol + nOff] || '').trim()
    if (!nameVal || nameVal === 'Name' || nameVal === 'Dept.') {
      blockCol += bw
      if (blockCol > (data[nRow]?.length || 0) + bw) break
      continue
    }

    const idVal = String(data[idRow]?.[blockCol + idOff] || '').trim()

    const days = []
    for (let r = dStart; r < data.length; r++) {
      const row = data[r]
      const dateCell = String(row[blockCol] || '').trim()
      if (!dateCell) continue
      const dayMatch = dateCell.match(/^(\d{1,2})\s+(\w{2})/)
      if (!dayMatch) continue

      const dayNum   = parseInt(dayMatch[1])
      const dayOfWeek = dayMatch[2]
      const isSun    = dayOfWeek === 'Su'
      const isSat    = dayOfWeek === 'Sa'
      if (isSun) continue
      if (isSat && !s.includeSaturday) continue

      // Collect all slot values from Sheet 5 — treat as raw punches, assign first/last
      const slots = [
        String(row[blockCol + parseInt(s.amInOffset)]  || '').trim(),
        String(row[blockCol + parseInt(s.amOutOffset)] || '').trim(),
        String(row[blockCol + parseInt(s.pmInOffset)]  || '').trim(),
        String(row[blockCol + parseInt(s.pmOutOffset)] || '').trim(),
        String(row[blockCol + parseInt(s.otInOffset)]  || '').trim(),
        String(row[blockCol + parseInt(s.otOutOffset)] || '').trim(),
      ]
      const hasAbsence = slots.some(t => t.toLowerCase().includes('absence'))
      const validPunches = slots
        .filter(t => t && /^\d{2}:\d{2}/.test(t))
        .sort()

      const masuk  = validPunches[0] || ''
      const pulang = validPunches.length > 1 ? validPunches[validPunches.length - 1] : ''
      const middlePunches = validPunches.slice(1, -1)
      const isAbsent = hasAbsence || validPunches.length === 0

      let date = null
      if (startDate) {
        date = new Date(startDate)
        date.setDate(startDate.getDate() + dayNum - 1)
      }

      days.push({ dayNum, dayOfWeek, date, masuk, pulang, middlePunches, isAbsent })
    }

    employees.push({ name: nameVal, id: idVal, period, startDate, days })
    blockCol += bw
    if (employees.length >= 100) break
  }

  if (employees.length === 0) throw new Error('Tidak ada data karyawan ditemukan. Periksa pengaturan kolom.')
  return employees
}

/* ═══════════════════════════════════════════════════
   PASTE PARSERS
═══════════════════════════════════════════════════ */

// Convert TSV/clipboard text → 2D array
// Handles tab-separated OR multi-space-separated (tabs lost when copying from txt viewer)
function tsvTo2D(text) {
  const lines = text.split('\n').map(l => l.replace(/\r/g, ''))
  const hasTab = lines.some(l => l.includes('\t'))
  if (hasTab) {
    return lines.map(row => row.split('\t').map(c => c.trim()))
  }
  // No tabs: split on 2+ consecutive spaces
  return lines.map(row => {
    if (!row.trim()) return ['']
    const cols = row.split(/  +/).map(c => c.trim()).filter(c => c.length > 0)
    // Rejoin date + time that got split: "2026/03/09" + "08:42:00"
    const rejoined = []
    for (let i = 0; i < cols.length; i++) {
      if (
        /^\d{4}[\/\-]\d{2}[\/\-]\d{2}$/.test(cols[i]) &&
        i + 1 < cols.length &&
        /^\d{2}:\d{2}/.test(cols[i + 1])
      ) {
        rejoined.push(cols[i] + ' ' + cols[i + 1])
        i++
      } else {
        rejoined.push(cols[i])
      }
    }
    return rejoined
  })
}

// Detect format: 'block' (Sheet 5 layout) or 'raw' (punch rows)
function detectFormat(data) {
  // Datetime pattern in any cell → definitely raw punch
  const dtPattern = /\d{4}[\/\-]\d{2}[\/\-]\d{2}[\s T]\d{2}:\d{2}/
  let dtMatches = 0
  for (const row of data.slice(0, 20)) {
    for (const cell of row) {
      if (dtPattern.test(String(cell))) { dtMatches++; break }
    }
  }
  if (dtMatches >= 2) return 'raw'

  // Block layout: wide table, first col has day patterns like "01 Mo"
  const dayPattern = /^\d{1,2}\s+(Su|Mo|Tu|We|Th|Fr|Sa)$/
  let dayMatches = 0, maxCols = 0
  for (const row of data) {
    if (row.length > maxCols) maxCols = row.length
    if (dayPattern.test(String(row[0] || ''))) dayMatches++
  }
  if (dayMatches >= 3 && maxCols >= 10) return 'block'

  // Standalone HH:MM time cells → raw
  const timePattern = /^\d{2}:\d{2}(:\d{2})?$/
  let timeMatches = 0
  for (const row of data.slice(1, 20)) {
    for (const cell of row) {
      if (timePattern.test(String(cell))) { timeMatches++; break }
    }
  }
  if (timeMatches >= 2) return 'raw'

  return 'block'
}

// Parse block layout 2D array (same logic as parseFile but from array)
function parseBlockData(data, s) {
  let period = '', startDate = null
  for (const row of data.slice(0, 8)) {
    for (const cell of row) {
      if (typeof cell === 'string' && cell.includes('~')) {
        period = cell.trim()
        const m = period.match(/(\d{4})\/(\d{2})\/(\d{2})/)
        if (m) startDate = new Date(+m[1], +m[2]-1, +m[3])
        break
      }
    }
    if (period) break
  }

  const bw     = parseInt(s.blockWidth)
  const nRow   = parseInt(s.nameRow)
  const nOff   = parseInt(s.nameOffset)
  const idRow  = parseInt(s.idRow)
  const idOff  = parseInt(s.idOffset)
  const dStart = parseInt(s.dataStartRow)

  const employees = []
  let blockCol = 0, attempts = 0

  while (attempts < 60) {
    attempts++
    const nameVal = String(data[nRow]?.[blockCol + nOff] || '').trim()
    if (!nameVal || nameVal === 'Name' || nameVal === 'Dept.') {
      blockCol += bw
      if (blockCol > (data[nRow]?.length || 0) + bw) break
      continue
    }

    const idVal = String(data[idRow]?.[blockCol + idOff] || '').trim()
    const days  = []

    for (let r = dStart; r < data.length; r++) {
      const row      = data[r]
      const dateCell = String(row[blockCol] || '').trim()
      if (!dateCell) continue
      const dayMatch = dateCell.match(/^(\d{1,2})\s+(\w{2})/)
      if (!dayMatch) continue

      const dayNum    = parseInt(dayMatch[1])
      const dayOfWeek = dayMatch[2]
      if (dayOfWeek === 'Su') continue
      if (dayOfWeek === 'Sa' && !s.includeSaturday) continue

      const get = (off) => String(row[blockCol + parseInt(off)] || '').trim()
      const slots2 = [
        get(s.amInOffset), get(s.amOutOffset),
        get(s.pmInOffset), get(s.pmOutOffset),
        get(s.otInOffset), get(s.otOutOffset),
      ]
      const hasAbsence2 = slots2.some(t => t.toLowerCase().includes('absence'))
      const validPunches2 = slots2.filter(t => t && /^\d{2}:\d{2}/.test(t)).sort()
      const masuk2  = validPunches2[0] || ''
      const pulang2 = validPunches2.length > 1 ? validPunches2[validPunches2.length - 1] : ''
      const middlePunches2 = validPunches2.slice(1, -1)
      const isAbsent = hasAbsence2 || validPunches2.length === 0

      let date = null
      if (startDate) {
        date = new Date(startDate)
        date.setDate(startDate.getDate() + dayNum - 1)
      }
      days.push({ dayNum, dayOfWeek, date, masuk: masuk2, pulang: pulang2, middlePunches: middlePunches2, isAbsent })
    }

    employees.push({ name: nameVal, id: idVal, period, startDate, days })
    blockCol += bw
    if (employees.length >= 100) break
  }

  if (employees.length === 0) throw new Error('Format blok tidak terdeteksi. Coba format raw punch atau sesuaikan pengaturan kolom.')
  return employees
}

// Parse raw punch rows: each row = one punch event
// Handles: No | DevId | UserId | UName | Verify | DateTime
//       OR: No | Name  | Date   | Time
//       OR: any reasonable variation
function parseRawData(data) {
  // Find header row — flexible: matches Name/UName, DateTime/Date+Time
  let headerIdx = -1, cols = {}
  const heuristics = {
    id:       /^(no\.?|id|no)$/i,
    name:     /^(name|uname|u\.?name|nama)$/i,
    date:     /^(date|tanggal)$/i,
    time:     /^(time|jam)$/i,
    datetime: /^(date\s*[-\/]?\s*time|datetime|tanggal\s*jam)$/i,
  }
  for (let r = 0; r < Math.min(10, data.length); r++) {
    const row = data[r].map(c => String(c).toLowerCase().trim())
    const found = {}
    row.forEach((cell, i) => {
      if (heuristics.id.test(cell))       found.id       = i
      if (heuristics.name.test(cell))     found.name     = i
      if (heuristics.date.test(cell))     found.date     = i
      if (heuristics.time.test(cell))     found.time     = i
      if (heuristics.datetime.test(cell)) found.datetime = i
    })
    // Need at least a name column AND some time info
    const hasTime = found.time !== undefined || found.datetime !== undefined
    // Also accept if a column value looks like a datetime (fallback)
    if (found.name !== undefined && hasTime) {
      headerIdx = r; cols = found; break
    }
  }

  // If still not found, scan data rows for datetime pattern and name-like column
  if (headerIdx === -1) {
    const dtRE = /\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}/
    for (let r = 0; r < Math.min(10, data.length); r++) {
      const row = data[r]
      const dtCol = row.findIndex(c => dtRE.test(String(c)))
      if (dtCol > 0) {
        // Name is likely the column before datetime that has letters
        let nameCol = dtCol - 1
        for (let c = dtCol - 1; c >= 0; c--) {
          if (/[a-zA-Z]{2,}/.test(String(row[c]))) { nameCol = c; break }
        }
        cols = { name: nameCol, datetime: dtCol }
        headerIdx = r - 1 // treat this row as first data row
        break
      }
    }
    if (headerIdx === -1) {
      // Last resort: assume No(0) Name(1) Date(2) Time(3)
      cols = { id: 0, name: 1, date: 2, time: 3 }
      headerIdx = 0
    }
  }

  const timeRE = /(\d{2}:\d{2})/
  const dtFullRE = /(\d{4}[\/\-]\d{2}[\/\-]\d{2})\s+(\d{2}:\d{2})/

  // Collect all punches
  const punchMap = {} // name → { dateKey → [times] }
  let minDate = null, maxDate = null

  for (let r = headerIdx + 1; r < data.length; r++) {
    const row  = data[r]
    const name = String(row[cols.name] || '').trim().replace(/\s+/g, ' ')
    if (!name || name.toLowerCase() === 'name' || name.toLowerCase() === 'uname') continue

    let dateStr = '', timeStr = ''

    if (cols.datetime !== undefined) {
      const dt = String(row[cols.datetime] || '')
      // Try full datetime pattern first: 2026/03/15  00:29:19
      const fullMatch = dt.match(dtFullRE)
      if (fullMatch) {
        dateStr = fullMatch[1]
        timeStr = fullMatch[2]
      } else {
        const tm = dt.match(timeRE)
        timeStr = tm ? tm[1] : ''
        dateStr = dt.split(/\s+/)[0] || ''
      }
    } else {
      dateStr = String(row[cols.date] || '').trim()
      // Time col might also have seconds: 07:42:15 → take HH:MM
      const tm = String(row[cols.time] || '').match(timeRE)
      timeStr = tm ? tm[1] : ''
    }

    if (!timeStr || !dateStr) continue

    // Normalize date key: replace / with - for consistent keys
    const dateKey = dateStr.replace(/\//g, '-')
    const dateObj = new Date(dateKey)
    if (isNaN(dateObj.getTime())) continue
    if (!minDate || dateObj < minDate) minDate = dateObj
    if (!maxDate || dateObj > maxDate) maxDate = dateObj

    if (!punchMap[name]) punchMap[name] = {}
    if (!punchMap[name][dateKey]) punchMap[name][dateKey] = []
    punchMap[name][dateKey].push(timeStr)
  }

  if (Object.keys(punchMap).length === 0) throw new Error('Tidak ada data absen ditemukan. Pastikan kolom Name dan Time tersedia.')

  const periodStr = minDate && maxDate
    ? `${minDate.toLocaleDateString('id-ID')} ~ ${maxDate.toLocaleDateString('id-ID')}`
    : ''

  const employees = Object.entries(punchMap).map(([name, dateMap]) => {
    const days = Object.entries(dateMap).map(([dateStr, punches]) => {
      const sorted = [...punches].sort()
      const date   = new Date(dateStr)
      const dow    = ['Su','Mo','Tu','We','Th','Fr','Sa'][date.getDay()]
      return {
        dayNum:       date.getDate(),
        dayOfWeek:    dow,
        date,
        masuk:        sorted[0] || '',
        pulang:       sorted.length > 1 ? sorted[sorted.length - 1] : '',
        middlePunches: sorted.slice(1, -1),
        isAbsent:     false,
      }
    }).sort((a, b) => a.date - b.date)

    return { name, id: '', period: periodStr, startDate: minDate, days }
  })

  return employees
}

// Main paste entry point — auto-detects format
function parsePaste(text, settings) {
  const data = tsvTo2D(text.trim())
  if (data.length < 3) throw new Error('Data terlalu sedikit. Pastikan sudah menyalin seluruh tabel.')
  const format = detectFormat(data)
  if (format === 'block') return { employees: parseBlockData(data, settings), format: 'block' }
  return { employees: parseRawData(data), format: 'raw' }
}

/* ═══════════════════════════════════════════════════
   STATS CALCULATOR
═══════════════════════════════════════════════════ */

function calcStats(employee, s) {
  const graceIn     = parseInt(s.graceMinutes    || 0)
  const graceOut    = parseInt(s.graceOutMinutes || 0)
  const schedStart    = timeToMins(s.scheduleStart)  // e.g. 420 (07:00)
  const lateThreshold = schedStart + graceIn          // e.g. 425 (07:05)
  const schedEnd      = timeToMins(s.scheduleEnd)    // e.g. 1020 (17:00)
  const otThreshold   = schedEnd + graceOut           // e.g. 1025 (17:05)

  let totalPresent = 0, totalAbsent = 0, totalLate = 0, totalOT = 0

  const dailyData = employee.days.map(day => {
    if (day.isAbsent) {
      totalAbsent++
      return { ...day, lateMinutes: 0, otMinutes: 0, firstIn: null, lastOut: null }
    }

    const firstIn = day.masuk  || null
    const lastOut = day.pulang || null

    if (!firstIn && !lastOut) {
      totalAbsent++
      return { ...day, lateMinutes: 0, otMinutes: 0, firstIn: null, lastOut: null }
    }

    totalPresent++

    const inMins = timeToMins(firstIn)
    let outMins  = timeToMins(lastOut)

    // Midnight clock-out: if clock-out time is earlier than schedule start
    // (e.g. 02:18 on a 07:00 schedule) treat as next-day by adding 1440 mins
    if (outMins !== null && outMins < schedStart) {
      outMins += 1440
    }

    // Late: only if past threshold; counted from threshold
    const late = inMins !== null && inMins > lateThreshold
      ? inMins - lateThreshold
      : 0

    // OT: only if past OT threshold; counted from threshold
    const ot = outMins !== null && outMins > otThreshold
      ? outMins - otThreshold
      : 0

    totalLate += late
    totalOT   += ot

    return { ...day, lateMinutes: late, otMinutes: ot, firstIn, lastOut }
  })

  return { dailyData, totalPresent, totalAbsent, totalLate, totalOT }
}

/* ═══════════════════════════════════════════════════
   ESC/POS BUILDER
═══════════════════════════════════════════════════ */

function buildEscPos(employee, stats, settings) {
  const bytes = []
  const push  = (...b) => bytes.push(...b)
  const text  = (str) => {
    for (const ch of String(str)) {
      const c = ch.charCodeAt(0)
      bytes.push(c < 128 ? c : 0x3F)
    }
  }
  const line    = (str = '') => { text(str); push(0x0A) }
  const center  = ()         => push(0x1B, 0x61, 0x01)
  const left    = ()         => push(0x1B, 0x61, 0x00)
  const bold    = (on)       => push(0x1B, 0x45, on ? 1 : 0)
  const bigFont = (on)       => push(0x1D, 0x21, on ? 0x01 : 0x00) // double height only

  push(0x1B, 0x40) // init

  const large = settings.printFontSize === 'large'
  const W     = large ? 32 : 32 // 58mm = ~32 chars normal

  bigFont(large)
  center(); bold(true)
  line('================================')
  line(employee.name.toUpperCase())
  bold(false)
  line(`Periode: ${employee.period}`)
  line('--------------------------------')

  left()
  if (!large) {
    text('TGL   '); text('IN    '); text('OUT   '); text('LATE  '); line('OT')
    line('--------------------------------')
  }

  stats.dailyData.forEach(day => {
    const d = formatDate(day.date) || `${String(day.dayNum).padStart(2,'0')}/${day.dayOfWeek}`
    if (!day.firstIn && !day.lastOut) {
      const pad = large ? '  ' : '      '
      line(`${d}${pad}ABSEN`)
    } else {
      const inT  = (day.firstIn  || '-').padEnd(6)
      const outT = (day.lastOut  || '-').padEnd(6)
      const late = (day.lateMinutes > 0 ? `${minsToDisplay(day.lateMinutes)}` : '0').padEnd(6)
      const ot   = minsToDisplay(day.otMinutes)
      if (large) {
        line(`${d} ${inT}${outT}`)
        line(`     L:${(day.lateMinutes > 0 ? minsToDisplay(day.lateMinutes) : '0').padEnd(5)} OT:${ot}`)
      } else {
        line(`${d} ${inT}${outT}${late}${ot}`)
      }
    }
  })

  line('--------------------------------')
  line(`Hadir        : ${stats.totalPresent} hari`)
  line(`Absen        : ${stats.totalAbsent} hari`)
  line(`Tot.Terlambat: ${minsToDisplay(stats.totalLate)}`)
  line(`Tot.Lembur   : ${minsToDisplay(stats.totalOT)}`)
  center()
  line('================================')
  line(new Date().toLocaleDateString('id-ID', { day:'2-digit', month:'2-digit', year:'numeric' }))

  push(0x1B, 0x64, 0x05) // feed 5 lines
  return new Uint8Array(bytes)
}

/* ═══════════════════════════════════════════════════
   BLUETOOTH PRINT
═══════════════════════════════════════════════════ */

async function printBluetooth(data, settings) {
  if (!navigator.bluetooth) throw new Error('WebBluetooth tidak didukung. Gunakan Chrome di Android.')
  const svcUUID = settings.btServiceUUID.toLowerCase()
  const chrUUID = settings.btCharUUID.toLowerCase()

  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [svcUUID],
  })
  const server  = await device.gatt.connect()
  const service = await server.getPrimaryService(svcUUID)
  const char    = await service.getCharacteristic(chrUUID)

  const CHUNK = 512
  for (let i = 0; i < data.length; i += CHUNK) {
    try {
      await char.writeValueWithoutResponse(data.slice(i, i + CHUNK))
    } catch {
      await char.writeValue(data.slice(i, i + CHUNK))
    }
    await new Promise(r => setTimeout(r, 60))
  }
  device.gatt.disconnect()
}

/* ═══════════════════════════════════════════════════
   STYLES (injected once)
═══════════════════════════════════════════════════ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:     #0b1120;
  --card:   #131f35;
  --card2:  #1a2942;
  --border: #1e3251;
  --teal:   #2dd4bf;
  --teal2:  #0d9488;
  --amber:  #f59e0b;
  --red:    #f43f5e;
  --muted:  #64748b;
  --text:   #e2e8f0;
  --text2:  #94a3b8;
  --mono:   'IBM Plex Mono', monospace;
  --sans:   'IBM Plex Sans', sans-serif;
}

body { background: var(--bg); color: var(--text); font-family: var(--sans); }

#app-root {
  max-width: 480px;
  margin: 0 auto;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

/* ── Header ── */
.app-header {
  padding: 14px 16px 10px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 10px;
}
.app-header .logo {
  width: 32px; height: 32px;
  background: var(--teal);
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
}
.app-header h1 { font-size: 15px; font-weight: 700; letter-spacing: .02em; }
.app-header p  { font-size: 11px; color: var(--muted); font-family: var(--mono); margin-top: 1px; }

/* ── Scrollable body ── */
.app-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  padding-bottom: 80px;
}

/* ── Bottom nav ── */
.bottom-nav {
  position: fixed;
  bottom: 0; left: 50%; transform: translateX(-50%);
  width: 100%; max-width: 480px;
  background: var(--card);
  border-top: 1px solid var(--border);
  display: flex;
  z-index: 100;
}
.nav-btn {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px;
  padding: 10px 0 12px;
  background: none; border: none; color: var(--muted);
  font-family: var(--sans); font-size: 10px; font-weight: 500;
  cursor: pointer; transition: color .15s;
}
.nav-btn.active { color: var(--teal); }
.nav-btn svg { width: 20px; height: 20px; }

/* ── Cards ── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
}
.card-title {
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); margin-bottom: 12px;
}

/* ── Upload zone ── */
.upload-zone {
  border: 2px dashed var(--border);
  border-radius: 12px;
  padding: 32px 16px;
  text-align: center;
  cursor: pointer;
  transition: border-color .2s, background .2s;
}
.upload-zone:hover, .upload-zone.drag { border-color: var(--teal); background: rgba(45,212,191,.05); }
.upload-zone .icon { font-size: 32px; margin-bottom: 8px; }
.upload-zone h3 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.upload-zone p  { font-size: 12px; color: var(--muted); }
.upload-zone input { display: none; }

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 10px 18px; border-radius: 8px; font-family: var(--sans);
  font-size: 13px; font-weight: 600; cursor: pointer; border: none;
  transition: opacity .15s, transform .1s;
}
.btn:active { transform: scale(.97); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn-primary { background: var(--teal); color: #0b1120; }
.btn-primary:hover:not(:disabled) { background: #5eead4; }
.btn-secondary { background: var(--card2); color: var(--text); border: 1px solid var(--border); }
.btn-secondary:hover:not(:disabled) { background: #223154; }
.btn-danger { background: rgba(244,63,94,.15); color: var(--red); border: 1px solid rgba(244,63,94,.3); }
.btn-sm { padding: 7px 12px; font-size: 12px; }
.btn-full { width: 100%; }

/* ── Employee list ── */
.emp-item {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px;
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 10px; margin-bottom: 8px;
  cursor: pointer; transition: border-color .15s;
}
.emp-item:hover { border-color: var(--teal); }
.emp-avatar {
  width: 40px; height: 40px; border-radius: 10px;
  background: linear-gradient(135deg, var(--teal2), #0d7490);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700; color: white; flex-shrink: 0;
}
.emp-info { flex: 1; min-width: 0; }
.emp-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.emp-meta { font-size: 11px; color: var(--muted); font-family: var(--mono); margin-top: 2px; }
.emp-arrow { color: var(--muted); }

/* ── Stats chips ── */
.stats-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
.stats-row.four { grid-template-columns: 1fr 1fr 1fr 1fr; }
.stat-chip {
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px; text-align: center;
}
.stat-chip .val { font-size: 18px; font-weight: 700; font-family: var(--mono); color: var(--teal); }
.stat-chip .lbl { font-size: 10px; color: var(--muted); margin-top: 2px; text-transform: uppercase; letter-spacing: .05em; }
.stat-chip.red  .val { color: var(--red); }
.stat-chip.amber .val { color: var(--amber); }

/* ── Day table ── */
.day-table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
.day-table th {
  text-align: left; padding: 6px 8px;
  font-size: 10px; color: var(--muted);
  border-bottom: 1px solid var(--border);
  text-transform: uppercase; letter-spacing: .06em;
}
.day-table td { padding: 7px 8px; border-bottom: 1px solid rgba(30,50,81,.6); }
.day-table tr:last-child td { border-bottom: none; }
.day-table .absent td { color: var(--muted); font-style: italic; }
.badge {
  display: inline-block; padding: 2px 6px; border-radius: 4px;
  font-size: 10px; font-weight: 600; font-family: var(--sans);
}
.badge-red    { background: rgba(244,63,94,.15);  color: var(--red); }
.badge-amber  { background: rgba(245,158,11,.15); color: var(--amber); }
.badge-teal   { background: rgba(45,212,191,.15); color: var(--teal); }
.badge-muted  { background: rgba(100,116,139,.15); color: var(--muted); }

/* ── Settings ── */
.field { margin-bottom: 14px; }
.field label {
  display: block; font-size: 11px; font-weight: 600;
  color: var(--muted); text-transform: uppercase; letter-spacing: .06em;
  margin-bottom: 6px;
}
.field input, .field select {
  width: 100%; padding: 10px 12px;
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); font-family: var(--mono);
  font-size: 13px; outline: none; transition: border-color .15s;
}
.field input:focus, .field select:focus { border-color: var(--teal); }
.field input[type=number] { appearance: textfield; }
.toggle-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 8px; margin-bottom: 14px;
}
.toggle-row span { font-size: 13px; }
.toggle {
  width: 40px; height: 22px; border-radius: 11px;
  background: var(--border); border: none; cursor: pointer;
  position: relative; transition: background .2s;
}
.toggle.on { background: var(--teal2); }
.toggle::after {
  content: ''; position: absolute;
  top: 3px; left: 3px;
  width: 16px; height: 16px; border-radius: 50%;
  background: white; transition: left .2s;
}
.toggle.on::after { left: 21px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.section-divider {
  font-size: 11px; font-weight: 700; color: var(--teal);
  text-transform: uppercase; letter-spacing: .1em;
  padding: 6px 0 10px; border-bottom: 1px solid var(--border); margin-bottom: 14px;
}
.advanced-toggle {
  width: 100%; background: none; border: 1px dashed var(--border);
  border-radius: 8px; padding: 10px; color: var(--muted);
  font-family: var(--sans); font-size: 12px; cursor: pointer;
  margin-bottom: 14px; transition: color .15s;
}
.advanced-toggle:hover { color: var(--text); }

/* ── Toast / Alert ── */
.toast {
  padding: 12px 16px; border-radius: 10px; margin-bottom: 12px;
  font-size: 13px; display: flex; align-items: flex-start; gap: 8px;
}
.toast-error   { background: rgba(244,63,94,.12);  border: 1px solid rgba(244,63,94,.3);  color: #fb7185; }
.toast-success { background: rgba(45,212,191,.12); border: 1px solid rgba(45,212,191,.3); color: var(--teal); }
.toast-info    { background: rgba(100,116,139,.12); border: 1px solid rgba(100,116,139,.3); color: var(--text2); }

/* ── Back button ── */
.back-btn {
  display: flex; align-items: center; gap: 6px;
  background: none; border: none; color: var(--teal);
  font-family: var(--sans); font-size: 13px; font-weight: 600;
  cursor: pointer; padding: 0; margin-bottom: 16px;
}

/* ── Mode toggle (File / Paste) ── */
.mode-toggle {
  display: flex;
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 10px; padding: 4px; gap: 4px; margin-bottom: 14px;
}
.mode-btn {
  flex: 1; padding: 8px; border-radius: 7px; border: none;
  background: none; color: var(--muted); font-family: var(--sans);
  font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s;
}
.mode-btn.active { background: var(--card); color: var(--teal); box-shadow: 0 1px 4px rgba(0,0,0,.3); }

/* ── Paste area ── */
.paste-area {
  width: 100%; min-height: 160px;
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px;
  color: var(--text); font-family: var(--mono); font-size: 11px;
  line-height: 1.6; resize: vertical; outline: none;
  transition: border-color .15s;
}
.paste-area:focus { border-color: var(--teal); }
.paste-area::placeholder { color: var(--muted); }
.format-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;
  margin-bottom: 8px;
}

/* ── Edit Modal ── */
.modal-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,.7); backdrop-filter: blur(4px);
  display: flex; align-items: flex-end; justify-content: center;
}
.modal-sheet {
  background: var(--card);
  border-radius: 20px 20px 0 0;
  width: 100%; max-width: 480px;
  max-height: 92dvh;
  display: flex; flex-direction: column;
  border-top: 1px solid var(--border);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 16px 10px;
  border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.modal-header h2 { font-size: 15px; font-weight: 700; }
.modal-close {
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; cursor: pointer;
}
.modal-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.modal-footer {
  padding: 12px 16px 20px; border-top: 1px solid var(--border);
  display: flex; gap: 8px; flex-shrink: 0;
}

/* Edit day card */
.edit-day-card {
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 10px; margin-bottom: 10px; overflow: hidden;
}
.edit-day-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: rgba(30,50,81,.5);
  font-size: 12px; font-weight: 700;
}
.edit-day-header .dow { font-size: 10px; color: var(--muted); font-weight: 400; margin-left: 6px; }
.edit-day-body { padding: 10px 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.edit-field label {
  display: block; font-size: 10px; color: var(--muted);
  text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px;
}
.edit-field input[type=time] {
  width: 100%; padding: 7px 8px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: 6px; color: var(--text);
  font-family: var(--mono); font-size: 13px; outline: none;
  -webkit-appearance: none; appearance: none;
}
.edit-field input[type=time]:focus { border-color: var(--teal); }
/* Force 24h clock on all browsers/Android */
.edit-field input[type=time]::-webkit-datetime-edit-ampm-field { display: none; }
.edit-field input[type=time]::-webkit-inner-spin-button { display: none; }
.edited-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--amber); display: inline-block; margin-left: 6px;
}

/* ── Print preview ── */
.print-preview {
  background: #f8f8f8; color: #111;
  border-radius: 8px; padding: 16px;
  font-family: var(--mono); font-size: 11px;
  line-height: 1.7; white-space: pre;
  overflow-x: auto; margin-bottom: 12px;
  border: 1px solid var(--border);
}

/* ── Empty state ── */
.empty { text-align: center; padding: 48px 16px; }
.empty .icon { font-size: 40px; margin-bottom: 12px; }
.empty h3 { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.empty p  { font-size: 13px; color: var(--muted); line-height: 1.5; }

/* ── File info pill ── */
.file-pill {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; background: rgba(45,212,191,.08);
  border: 1px solid rgba(45,212,191,.2); border-radius: 10px; margin-bottom: 12px;
}
.file-pill .name { font-size: 13px; font-weight: 600; flex: 1; }
.file-pill .meta { font-size: 11px; color: var(--muted); font-family: var(--mono); }

/* ── Search ── */
.search-input {
  width: 100%; padding: 10px 12px 10px 36px;
  background: var(--card2); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); font-family: var(--sans);
  font-size: 13px; outline: none; transition: border-color .15s;
  margin-bottom: 12px;
}
.search-input:focus { border-color: var(--teal); }
.search-wrap { position: relative; }
.search-wrap .search-icon {
  position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
  color: var(--muted); pointer-events: none;
}
`

/* ═══════════════════════════════════════════════════
   COMPONENTS
═══════════════════════════════════════════════════ */

function Toast({ type, msg }) {
  if (!msg) return null
  const icons = { error: '⚠️', success: '✅', info: 'ℹ️' }
  return (
    <div className={`toast toast-${type}`}>
      <span>{icons[type]}</span>
      <span>{msg}</span>
    </div>
  )
}

/* ── Settings Tab ── */
function SettingsTab({ settings, onSave }) {
  const [s, setS] = useState(settings)
  const [advanced, setAdvanced] = useState(false)
  const [saved, setSaved] = useState(false)

  const set = (k, v) => setS(p => ({ ...p, [k]: v }))

  const handlePreset = (preset) => {
    if (preset !== 'custom') {
      set('btServiceUUID', BT_PRESETS[preset].svc)
      set('btCharUUID',    BT_PRESETS[preset].chr)
    }
    set('btPreset', preset)
  }

  const save = () => {
    onSave(s)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div>
      {saved && <Toast type="success" msg="Pengaturan disimpan!" />}

      <div className="card">
        <div className="section-divider">⏰ Jadwal Kerja</div>
        <div className="field-row">
          <div className="field">
            <label>Jam Masuk</label>
            <input type="time" value={s.scheduleStart} onChange={e => set('scheduleStart', e.target.value)} />
          </div>
          <div className="field">
            <label>Jam Keluar</label>
            <input type="time" value={s.scheduleEnd} onChange={e => set('scheduleEnd', e.target.value)} />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>Toleransi Masuk (menit)</label>
            <input type="number" min="0" max="60" value={s.graceMinutes} onChange={e => set('graceMinutes', e.target.value)} />
          </div>
          <div className="field">
            <label>Toleransi Keluar (menit)</label>
            <input type="number" min="0" max="60" value={s.graceOutMinutes} onChange={e => set('graceOutMinutes', e.target.value)} />
          </div>
        </div>
        <div className="toggle-row">
          <span>Masuk Sabtu</span>
          <button className={`toggle ${s.includeSaturday ? 'on' : ''}`} onClick={() => set('includeSaturday', !s.includeSaturday)} />
        </div>
      </div>

      <div className="card">
        <div className="section-divider">🖨️ Cetak</div>
        <div className="field">
          <label>Ukuran Font</label>
          <select value={s.printFontSize} onChange={e => set('printFontSize', e.target.value)}>
            <option value="normal">Normal (32 karakter/baris)</option>
            <option value="large">Besar (tinggi ganda)</option>
          </select>
        </div>
        <div className="field">
          <label>Model Printer Bluetooth</label>
          <select value={s.btPreset} onChange={e => handlePreset(e.target.value)}>
            {Object.entries(BT_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>
        {s.btPreset === 'custom' && (
          <>
            <div className="field">
              <label>Service UUID</label>
              <input value={s.btServiceUUID} onChange={e => set('btServiceUUID', e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            </div>
            <div className="field">
              <label>Characteristic UUID</label>
              <input value={s.btCharUUID} onChange={e => set('btCharUUID', e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            </div>
          </>
        )}
        {s.btPreset !== 'custom' && (
          <div className="toast toast-info" style={{ marginBottom: 0 }}>
            <span>ℹ️</span>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, marginBottom: 2 }}>SVC: {s.btServiceUUID}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>CHR: {s.btCharUUID}</div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="section-divider">🗂️ Mapping Kolom File</div>
        <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}>
          {advanced ? '▲ Sembunyikan' : '▼ Tampilkan'} pengaturan lanjutan (untuk mesin baru)
        </button>
        {advanced && (
          <>
            <Toast type="info" msg="Ubah ini jika format file dari mesin baru berbeda. Default sudah sesuai untuk mesin saat ini." />
            <div className="field-row">
              <div className="field">
                <label>Nomor Sheet (0=pertama)</label>
                <input type="number" min="0" value={s.sheetIndex} onChange={e => set('sheetIndex', e.target.value)} />
              </div>
              <div className="field">
                <label>Lebar Blok Karyawan</label>
                <input type="number" min="1" value={s.blockWidth} onChange={e => set('blockWidth', e.target.value)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Baris Nama (0=pertama)</label>
                <input type="number" min="0" value={s.nameRow} onChange={e => set('nameRow', e.target.value)} />
              </div>
              <div className="field">
                <label>Offset Kolom Nama</label>
                <input type="number" min="0" value={s.nameOffset} onChange={e => set('nameOffset', e.target.value)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Baris ID</label>
                <input type="number" min="0" value={s.idRow} onChange={e => set('idRow', e.target.value)} />
              </div>
              <div className="field">
                <label>Offset Kolom ID</label>
                <input type="number" min="0" value={s.idOffset} onChange={e => set('idOffset', e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>Baris Mulai Data Harian</label>
              <input type="number" min="0" value={s.dataStartRow} onChange={e => set('dataStartRow', e.target.value)} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, fontFamily: 'var(--mono)' }}>
              Offset kolom dalam tiap blok karyawan:
            </div>
            <div className="field-row">
              <div className="field"><label>Masuk 1</label>  <input type="number" min="0" value={s.amInOffset}  onChange={e => set('amInOffset',  e.target.value)} /></div>
              <div className="field"><label>Keluar 1</label> <input type="number" min="0" value={s.amOutOffset} onChange={e => set('amOutOffset', e.target.value)} /></div>
            </div>
            <div className="field-row">
              <div className="field"><label>Masuk 2</label>  <input type="number" min="0" value={s.pmInOffset}  onChange={e => set('pmInOffset',  e.target.value)} /></div>
              <div className="field"><label>Keluar 2</label> <input type="number" min="0" value={s.pmOutOffset} onChange={e => set('pmOutOffset', e.target.value)} /></div>
            </div>
            <div className="field-row">
              <div className="field"><label>OT Masuk</label>  <input type="number" min="0" value={s.otInOffset}  onChange={e => set('otInOffset',  e.target.value)} /></div>
              <div className="field"><label>OT Keluar</label> <input type="number" min="0" value={s.otOutOffset} onChange={e => set('otOutOffset', e.target.value)} /></div>
            </div>
          </>
        )}
      </div>

      <button className="btn btn-primary btn-full" onClick={save}>
        💾 Simpan Pengaturan
      </button>
    </div>
  )
}

/* ═══════════════════════════════════════════════════
   OCR via Tesseract.js (loaded from CDN in index.html)
═══════════════════════════════════════════════════ */

async function runOCR(imageFile, onProgress) {
  // window.Tesseract is injected via CDN script in index.html
  if (!window.Tesseract) throw new Error('Tesseract.js belum dimuat. Coba refresh halaman.')

  const worker = await window.Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(Math.round(m.progress * 100))
      }
    },
  })

  try {
    const { data: { text } } = await worker.recognize(imageFile)
    return text
  } finally {
    await worker.terminate()
  }
}

// Post-process OCR text → clean up common OCR errors in tabular data
function cleanOcrText(raw) {
  return raw
    .split('\n')
    .map(line => line
      // Fix common OCR substitutions in time fields
      .replace(/\bO(\d)/g, '0$1')   // O7:42 → 07:42
      .replace(/(\d)O\b/g, '$10')   // 1O:00 → 10:00
      .replace(/[|l]{1}(?=\d{2}[:/])/g, '1') // |7:30 → 17:30
      .replace(/\s{2,}/g, '\t')     // multiple spaces → tab (treat as column separator)
      .trim()
    )
    .filter(l => l.length > 0)
    .join('\n')
}

/* ── Upload Tab ── */
function UploadTab({ settings, onParsed, fileInfo, setFileInfo }) {
  const [mode, setMode]           = useState('file')
  const [drag, setDrag]           = useState(false)
  const [error, setError]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [detectedFmt, setDetectedFmt] = useState(null)
  // OCR state
  const [ocrImage, setOcrImage]   = useState(null)   // { url, file }
  const [ocrText, setOcrText]     = useState('')      // editable OCR result
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrDone, setOcrDone]     = useState(false)

  /* ── File mode ── */
  const processFile = useCallback((file) => {
    if (!file) return
    setError('')
    setLoading(true)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' })
        const employees = parseFile(wb, settings)
        const fi = { name: file.name, sheets: wb.SheetNames, count: employees.length, source: 'file' }
        setFileInfo(fi)
        localStorage.setItem('att_fileinfo', JSON.stringify(fi))
        onParsed(employees)
      } catch (err) {
        setError(err.message)
      } finally { setLoading(false) }
    }
    reader.readAsArrayBuffer(file)
  }, [settings, onParsed, setFileInfo])

  /* ── Paste mode ── */
  const processPaste = useCallback((textOverride) => {
    const txt = textOverride ?? pasteText
    if (!txt.trim()) return
    setError('')
    setLoading(true)
    try {
      const { employees, format } = parsePaste(txt, settings)
      setDetectedFmt(format)
      const fi2 = { name: textOverride ? 'Data OCR' : 'Data tempel', sheets: [], count: employees.length, source: 'paste', format }
      setFileInfo(fi2)
      localStorage.setItem('att_fileinfo', JSON.stringify(fi2))
      onParsed(employees)
    } catch (err) {
      setError(err.message)
    } finally { setLoading(false) }
  }, [pasteText, settings, onParsed, setFileInfo])

  const handlePasteChange = (e) => {
    const val = e.target.value
    setPasteText(val)
    if (val.trim().split('\n').length >= 5) {
      try { setDetectedFmt(detectFormat(tsvTo2D(val.trim()))) }
      catch { setDetectedFmt(null) }
    } else { setDetectedFmt(null) }
  }

  /* ── OCR mode ── */
  const handleImageSelect = (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setError('Pilih file gambar (JPG, PNG, dll).')
      return
    }
    setError('')
    setOcrText('')
    setOcrDone(false)
    setOcrProgress(0)
    setOcrImage({ url: URL.createObjectURL(file), file })
  }

  const runOcrOnImage = async () => {
    if (!ocrImage) return
    setError('')
    setLoading(true)
    setOcrProgress(0)
    try {
      const raw     = await runOCR(ocrImage.file, setOcrProgress)
      const cleaned = cleanOcrText(raw)
      setOcrText(cleaned)
      setOcrDone(true)
      // Auto-detect format
      try { setDetectedFmt(detectFormat(tsvTo2D(cleaned))) }
      catch { setDetectedFmt(null) }
    } catch (err) {
      setError(err.message)
    } finally { setLoading(false) }
  }

  const onDrop  = (e) => { e.preventDefault(); setDrag(false); processFile(e.dataTransfer.files[0]) }
  const onFile  = (e) => processFile(e.target.files[0])
  const onImage = (e) => handleImageSelect(e.target.files[0])
  const onImageDrop = (e) => { e.preventDefault(); setDrag(false); handleImageSelect(e.dataTransfer.files[0]) }

  const fmtLabels = { block: '📊 Format blok karyawan', raw: '📋 Format raw punch' }

  return (
    <div>
      {/* ── 3-way mode toggle ── */}
      <div className="mode-toggle">
        <button className={`mode-btn ${mode === 'file'  ? 'active' : ''}`} onClick={() => setMode('file')}>📂 File</button>
        <button className={`mode-btn ${mode === 'paste' ? 'active' : ''}`} onClick={() => setMode('paste')}>📋 Tempel</button>
        <button className={`mode-btn ${mode === 'ocr'   ? 'active' : ''}`} onClick={() => setMode('ocr')}>📷 Foto</button>
      </div>

      {error && <Toast type="error" msg={error} />}

      {/* ════ FILE MODE ════ */}
      {mode === 'file' && (
        <>
          <Toast type="info" msg="Ekspor .xls / .xlsx dari mesin absensi, lalu unggah di sini." />
          {fileInfo?.source === 'file' && (
            <div className="file-pill">
              <span>📄</span>
              <div style={{ flex: 1 }}>
                <div className="name">{fileInfo.name}</div>
                <div className="meta">{fileInfo.count} karyawan · {fileInfo.sheets.length} sheet</div>
              </div>
              <span style={{ color: 'var(--teal)', fontWeight: 700 }}>✓</span>
            </div>
          )}
          <label
            className={`upload-zone ${drag ? 'drag' : ''}`}
            onDragOver={e => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop} style={{ display: 'block' }}
          >
            <input type="file" accept=".xls,.xlsx,.csv" onChange={onFile} />
            <div className="icon">{loading ? '⏳' : '📂'}</div>
            <h3>{loading ? 'Membaca file...' : 'Unggah File Absensi'}</h3>
            <p>{loading ? 'Harap tunggu' : 'Klik atau seret file .xls / .xlsx ke sini'}</p>
          </label>
          {fileInfo?.source === 'file' && fileInfo.sheets.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="card" style={{ marginBottom: 0 }}>
                <div className="card-title">Sheet ditemukan</div>
                {fileInfo.sheets.map((name, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: i < fileInfo.sheets.length - 1 ? '1px solid var(--border)' : 'none', fontSize: 13 }}>
                    <span style={{ fontFamily: 'var(--mono)' }}>{name}</span>
                    {i === parseInt(settings.sheetIndex) && <span className="badge badge-teal">aktif</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ════ PASTE MODE ════ */}
      {mode === 'paste' && (
        <>
          <Toast type="info" msg="Di Excel: pilih tabel → Ctrl+C → tempel di sini." />
          {fileInfo?.source === 'paste' && (
            <div className="file-pill">
              <span>📋</span>
              <div style={{ flex: 1 }}>
                <div className="name">Data tempel</div>
                <div className="meta">{fileInfo.count} karyawan · {fmtLabels[fileInfo.format]}</div>
              </div>
              <span style={{ color: 'var(--teal)', fontWeight: 700 }}>✓</span>
            </div>
          )}
          {detectedFmt && (
            <div className={`format-badge ${detectedFmt === 'block' ? 'badge-teal' : 'badge-amber'}`} style={{ marginBottom: 8 }}>
              {fmtLabels[detectedFmt]} terdeteksi
            </div>
          )}
          <textarea
            className="paste-area"
            placeholder={'Tempel data dari Excel di sini...\n\nKolom yang didukung:\n• Format blok (Sheet 5): tabel lebar per tanggal\n• Format raw: No | DevId | UserId | UName | Verify | DateTime'}
            value={pasteText}
            onChange={handlePasteChange}
            spellCheck={false}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => processPaste()} disabled={!pasteText.trim() || loading}>
              {loading ? '⏳ Memproses...' : '▶ Proses Data'}
            </button>
            {pasteText && (
              <button className="btn btn-secondary btn-sm" onClick={() => { setPasteText(''); setDetectedFmt(null) }}>🗑️</button>
            )}
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
            💡 Di Excel: klik sel pertama → Ctrl+Shift+End → Ctrl+C → tempel di sini.
          </div>
        </>
      )}

      {/* ════ OCR / FOTO MODE ════ */}
      {mode === 'ocr' && (
        <>
          <Toast type="info" msg="Unggah foto/screenshot tabel absensi. Teks akan diekstrak otomatis — bisa diedit sebelum diproses." />
          <Toast type="info" msg="💡 Format raw punch (daftar baris) lebih akurat dari format blok (tabel lebar) saat di-OCR." />

          {/* Image drop zone */}
          {!ocrImage ? (
            <label
              className={`upload-zone ${drag ? 'drag' : ''}`}
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={onImageDrop} style={{ display: 'block' }}
            >
              <input type="file" accept="image/*" onChange={onImage} />
              <div className="icon">📷</div>
              <h3>Unggah Foto / Screenshot</h3>
              <p>JPG, PNG, atau gambar lainnya</p>
            </label>
          ) : (
            <>
              {/* Image preview */}
              <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 10 }}>
                <img src={ocrImage.url} alt="preview" style={{ width: '100%', display: 'block', maxHeight: 220, objectFit: 'contain', background: '#111' }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {!ocrDone && (
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={runOcrOnImage} disabled={loading}>
                    {loading
                      ? <span>🔍 Membaca teks... {ocrProgress > 0 ? `${ocrProgress}%` : ''}</span>
                      : '🔍 Baca Teks (OCR)'}
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => { setOcrImage(null); setOcrText(''); setOcrDone(false); setOcrProgress(0); setDetectedFmt(null) }}>
                  🗑️ Ganti foto
                </button>
              </div>

              {/* OCR progress bar */}
              {loading && ocrProgress > 0 && (
                <div style={{ background: 'var(--border)', borderRadius: 4, height: 6, marginBottom: 10, overflow: 'hidden' }}>
                  <div style={{ background: 'var(--teal)', height: '100%', width: `${ocrProgress}%`, transition: 'width .3s' }} />
                </div>
              )}

              {/* Editable OCR result */}
              {ocrText && (
                <>
                  {detectedFmt && (
                    <div className={`format-badge ${detectedFmt === 'block' ? 'badge-teal' : 'badge-amber'}`} style={{ marginBottom: 8 }}>
                      {fmtLabels[detectedFmt]} terdeteksi
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                    ✏️ Periksa dan perbaiki hasil OCR sebelum diproses:
                  </div>
                  <textarea
                    className="paste-area"
                    value={ocrText}
                    onChange={e => {
                      setOcrText(e.target.value)
                      try { setDetectedFmt(detectFormat(tsvTo2D(e.target.value.trim()))) }
                      catch { setDetectedFmt(null) }
                    }}
                    spellCheck={false}
                    style={{ minHeight: 140 }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => processPaste(ocrText)} disabled={!ocrText.trim() || loading}>
                      {loading ? '⏳ Memproses...' : '▶ Proses Data OCR'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/* ── Edit Modal ── */
function EditModal({ days, originalDays, onChange, onClose }) {
  const FIELDS = [
    { key: 'masuk',  label: 'Masuk'  },
    { key: 'pulang', label: 'Pulang' },
  ]

  const isEdited = (day, i) => {
    const orig = originalDays[i]
    if (!orig) return true
    // Check all 6 fields including OT (OT edits may come from raw parser)
    return ['masuk','pulang'].some(k => (day[k] || '') !== (orig[k] || ''))
  }

  const setField = (dayIdx, field, value) => {
    const next = days.map((d, i) => i === dayIdx ? { ...d, [field]: value } : d)
    // Auto-recalc isAbsent: if both masuk and pulang empty → absent
    const d = next[dayIdx]
    next[dayIdx] = { ...d, isAbsent: !d.masuk && !d.pulang }
    onChange(next)
  }

  const DOW_ID = { Mo:'Sen', Tu:'Sel', We:'Rab', Th:'Kam', Fr:'Jum', Sa:'Sab', Su:'Min' }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-sheet">
        <div className="modal-header">
          <h2>✏️ Edit Data Absen</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
            Edit jam langsung di kolom. Kosongkan untuk hapus. Titik kuning = sudah diubah.
          </div>
          {days.map((day, i) => {
            const edited = isEdited(day, i)
            const label  = formatDate(day.date) || String(day.dayNum).padStart(2,'0')
            const dow    = DOW_ID[day.dayOfWeek] || day.dayOfWeek
            return (
              <div key={i} className="edit-day-card">
                <div className="edit-day-header">
                  <span>
                    {label}
                    <span className="dow">{dow}</span>
                    {edited && <span className="edited-dot" title="Diubah" />}
                  </span>
                  {day.isAbsent && <span className="badge badge-muted" style={{ fontSize: 9 }}>ABSEN</span>}
                </div>
                <div className="edit-day-body">
                  {FIELDS.map(({ key, label: lbl }) => (
                    <div key={key} className="edit-field">
                      <label>{lbl}</label>
                      <input
                        type="time"
                        value={day[key] || ''}
                        onChange={e => setField(i, key, e.target.value)}
                      />
                    </div>
                  ))}
                  {day.middlePunches && day.middlePunches.length > 0 && (
                    <div className="edit-field" style={{ gridColumn: '1 / -1' }}>
                      <label>Scan Tengah (hanya tampil)</label>
                      <div style={{ padding: '7px 8px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
                        {(day.middlePunches || []).join('  ·  ')}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>
            ✓ Selesai
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Employee Detail ── */
function EmployeeDetail({ employee, settings, onBack }) {
  const [printMsg, setPrintMsg]     = useState('')
  const [printStatus, setPrintStatus] = useState('idle')
  const [showPreview, setShowPreview] = useState(false)
  const [showEdit, setShowEdit]     = useState(false)
  // Editable copy of days — restore from localStorage if available
  const storageKey = `att_edits_${employee.name}`
  const [editedDays, setEditedDays] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (parsed.length === employee.days.length) {
          // Sanitize: ensure new fields exist (guards against stale cache structure)
          return parsed.map((d, i) => ({
            ...employee.days[i],  // base from fresh data
            masuk:  d.masuk  ?? d.amIn  ?? '',
            pulang: d.pulang ?? d.amOut ?? '',
            middlePunches: Array.isArray(d.middlePunches) ? d.middlePunches : (employee.days[i].middlePunches || []),
            isAbsent: d.isAbsent ?? employee.days[i].isAbsent,
          }))
        }
      }
    } catch {}
    return employee.days.map(d => ({ ...d }))
  })

  const saveEdits = (days) => {
    setEditedDays(days)
    localStorage.setItem(storageKey, JSON.stringify(days))
  }
  const hasEdits = editedDays.some((d, i) => {
    const o = employee.days[i]
    return ['masuk','pulang'].some(k => (d[k]||'') !== (o[k]||''))
  })

  // Use editedDays for stats + print
  const workingEmployee = { ...employee, days: editedDays }
  const stats = calcStats(workingEmployee, settings)

  const handlePrint = async () => {
    setPrintStatus('printing')
    setPrintMsg('Menghubungkan ke printer...')
    try {
      const data = buildEscPos(workingEmployee, stats, settings)
      await printBluetooth(data, settings)
      setPrintStatus('success')
      setPrintMsg('Berhasil dicetak!')
    } catch (err) {
      setPrintStatus('error')
      setPrintMsg(err.message)
    }
    setTimeout(() => { setPrintStatus('idle'); setPrintMsg('') }, 4000)
  }

  const buildPreview = () => {
    const line = (s = '') => s + '\n'
    let out = ''
    out += line('================================')
    out += line(workingEmployee.name.toUpperCase())
    out += line(`Periode: ${workingEmployee.period}`)
    out += line('--------------------------------')
    out += line('TGL   IN    OUT   LATE  OT')
    out += line('--------------------------------')
    stats.dailyData.forEach(day => {
      const d = formatDate(day.date) || `${String(day.dayNum).padStart(2,'0')}`
      if (!day.firstIn && !day.lastOut) {
        out += line(`${d}      -      -     ABSEN`)
      } else {
        const inT  = (day.firstIn  || '-').padEnd(6)
        const outT = (day.lastOut  || '-').padEnd(6)
        const late = (day.lateMinutes > 0 ? `${minsToDisplay(day.lateMinutes)}` : '0').padEnd(6)
        const ot   = minsToDisplay(day.otMinutes)
        out += line(`${d} ${inT}${outT}${late}${ot}`)
      }
    })
    out += line('--------------------------------')
    out += line(`Hadir        : ${stats.totalPresent} hari`)
    out += line(`Absen        : ${stats.totalAbsent} hari`)
    out += line(`Tot.Terlambat: ${minsToDisplay(stats.totalLate)}`)
    out += line(`Tot.Lembur   : ${minsToDisplay(stats.totalOT)}`)
    out += line('================================')
    return out
  }

  return (
    <div>
      {showEdit && (
        <EditModal
          days={editedDays}
          originalDays={employee.days}
          onChange={saveEdits}
          onClose={() => setShowEdit(false)}
        />
      )}

      <button className="back-btn" onClick={onBack}>
        ← Kembali ke daftar
      </button>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="emp-avatar" style={{ width: 48, height: 48, fontSize: 20 }}>
            {employee.name[0]?.toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {employee.name}
              {hasEdits && <span className="badge badge-amber" style={{ marginLeft: 8, fontSize: 10 }}>Diedit</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
              ID: {employee.id || '-'} · {employee.period}
            </div>
          </div>
        </div>
      </div>

      <div className="stats-row four">
        <div className="stat-chip">
          <div className="val">{stats.totalPresent}</div>
          <div className="lbl">Hadir</div>
        </div>
        <div className="stat-chip red">
          <div className="val">{stats.totalAbsent}</div>
          <div className="lbl">Absen</div>
        </div>
        <div className="stat-chip amber">
          <div className="val">{minsToDisplay(stats.totalLate)}</div>
          <div className="lbl">Terlambat</div>
        </div>
        <div className="stat-chip">
          <div className="val">{minsToDisplay(stats.totalOT)}</div>
          <div className="lbl">Lembur</div>
        </div>
      </div>

      {printMsg && (
        <Toast type={printStatus === 'error' ? 'error' : printStatus === 'success' ? 'success' : 'info'} msg={printMsg} />
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={handlePrint} disabled={printStatus === 'printing'}>
          {printStatus === 'printing' ? '⏳ Mencetak...' : '🖨️ Cetak ke Printer'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowEdit(true)} title="Edit data">
          ✏️
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowPreview(!showPreview)} title="Preview cetak">
          {showPreview ? '🙈' : '👁️'}
        </button>
        {hasEdits && (
          <button className="btn btn-danger btn-sm" onClick={() => { saveEdits(employee.days.map(d => ({ ...d }))); localStorage.removeItem(storageKey) }} title="Reset ke data asli">
            ↩️
          </button>
        )}
      </div>

      {showPreview && (
        <div className="print-preview">{buildPreview()}</div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="day-table">
          <thead>
            <tr>
              <th>Tgl</th>
              <th>Masuk</th>
              <th>Keluar</th>
              <th>Tlb</th>
              <th>OT</th>
            </tr>
          </thead>
          <tbody>
            {stats.dailyData.map((day, i) => {
              const wasEdited = ['masuk','pulang'].some(k =>
                (editedDays[i]?.[k]||'') !== (employee.days[i]?.[k]||'')
              )
              return (
                <tr key={i} className={!day.firstIn && !day.lastOut ? 'absent' : ''}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {formatDate(day.date) || String(day.dayNum).padStart(2,'0')}
                      {wasEdited && <span className="edited-dot" style={{ marginLeft: 4 }} />}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--muted)' }}>{day.dayOfWeek}</div>
                  </td>
                  <td>{day.firstIn || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td>{day.lastOut || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td>
                    {!day.firstIn && !day.lastOut
                      ? <span className="badge badge-muted">ABSEN</span>
                      : day.lateMinutes > 0
                        ? <span className="badge badge-red">{minsToDisplay(day.lateMinutes)}</span>
                        : <span style={{ color: 'var(--muted)' }}>0</span>
                    }
                  </td>
                  <td>
                    {day.otMinutes > 0
                      ? <span className="badge badge-amber">{minsToDisplay(day.otMinutes)}</span>
                      : <span style={{ color: 'var(--muted)' }}>—</span>
                    }
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {editedDays.some(d => d.middlePunches && d.middlePunches.length > 0) && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-title">Scan Tengah (Istirahat)</div>
          <table className="day-table">
            <thead>
              <tr><th>Tgl</th><th>Waktu Scan</th></tr>
            </thead>
            <tbody>
              {editedDays
                .filter(d => d.middlePunches && d.middlePunches.length > 0)
                .map((day, i) => (
                  <tr key={i}>
                    <td>{formatDate(day.date) || String(day.dayNum).padStart(2,'0')}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{(day.middlePunches || []).join('  ·  ')}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ── Employees Tab ── */
function EmployeesTab({ employees, settings }) {
  const [selected, setSelected] = useState(null)
  const [search, setSearch]     = useState('')

  if (selected) return (
    <EmployeeDetail
      key={selected.name}
      employee={selected}
      settings={settings}
      onBack={() => setSelected(null)}
    />
  )

  if (!employees.length) return (
    <div className="empty">
      <div className="icon">👥</div>
      <h3>Belum ada data</h3>
      <p>Unggah file absensi di tab Upload terlebih dahulu.</p>
    </div>
  )

  const filtered = employees.filter(e =>
    e.name.toLowerCase().includes(search.toLowerCase()) ||
    e.id.toString().includes(search)
  )

  return (
    <div>
      <div className="search-wrap">
        <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
          <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
        </svg>
        <input
          className="search-input"
          placeholder="Cari nama atau ID..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, fontFamily: 'var(--mono)' }}>
        {filtered.length} dari {employees.length} karyawan
      </div>

      {filtered.map((emp, i) => {
        const stats = calcStats(emp, settings)
        return (
          <div key={i} className="emp-item" onClick={() => setSelected(emp)}>
            <div className="emp-avatar">{emp.name[0]?.toUpperCase()}</div>
            <div className="emp-info">
              <div className="emp-name">{emp.name}</div>
              <div className="emp-meta">
                Hadir {stats.totalPresent} · Absen {stats.totalAbsent} ·
                Tlb {minsToDisplay(stats.totalLate)} · OT {minsToDisplay(stats.totalOT)}
              </div>
            </div>
            <svg className="emp-arrow" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </div>
        )
      })}
    </div>
  )
}

/* ═══════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════ */

export default function App() {
  const [tab, setTab]           = useState('upload')
  const [employees, setEmployees] = useState(() => {
    try {
      const ver = localStorage.getItem('att_ver')
      if (ver !== '2') {
        // Clear old incompatible data
        localStorage.removeItem('att_employees')
        localStorage.removeItem('att_fileinfo')
        localStorage.setItem('att_ver', '2')
        return []
      }
      const saved = localStorage.getItem('att_employees')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const [fileInfo, setFileInfo] = useState(() => {
    try {
      const saved = localStorage.getItem('att_fileinfo')
      return saved ? JSON.parse(saved) : null
    } catch { return null }
  })
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('att_settings')
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS
    } catch { return DEFAULT_SETTINGS }
  })

  // Inject CSS once
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    return () => document.head.removeChild(style)
  }, [])

  const saveSettings = (s) => {
    setSettings(s)
    localStorage.setItem('att_settings', JSON.stringify(s))
  }

  const handleParsed = (emps) => {
    setEmployees(emps)
    localStorage.setItem('att_employees', JSON.stringify(emps))
    setTab('employees')
  }

  const handleClearData = () => {
    setEmployees([])
    setFileInfo(null)
    localStorage.removeItem('att_employees')
    localStorage.removeItem('att_fileinfo')
    setTab('upload')
  }

  const TABS = [
    { id: 'upload',    label: 'Upload',    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
    )},
    { id: 'employees', label: 'Karyawan',  icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
    )},
    { id: 'settings',  label: 'Pengaturan', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
    )},
  ]

  return (
    <div id="app-root">
      <div className="app-header">
        <div className="logo">🕐</div>
        <div>
          <h1>Absensi Printer</h1>
          <p>v1.0 · WebBluetooth · 58mm</p>
        </div>
        {employees.length > 0 && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--teal)' }}>
              {employees.length} karyawan
            </span>
            <button
              className="btn btn-danger btn-sm"
              style={{ padding: '4px 8px', fontSize: 11 }}
              onClick={handleClearData}
              title="Hapus semua data"
            >
              🗑️ Hapus
            </button>
          </div>
        )}
      </div>

      <div className="app-body">
        {tab === 'upload'    && <UploadTab    settings={settings} onParsed={handleParsed} fileInfo={fileInfo} setFileInfo={setFileInfo} />}
        {tab === 'employees' && <EmployeesTab employees={employees} settings={settings} />}
        {tab === 'settings'  && <SettingsTab  settings={settings} onSave={saveSettings} />}
      </div>

      <nav className="bottom-nav">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`nav-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}