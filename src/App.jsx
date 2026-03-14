// ============================================================
// AbsensiPrint — Attendance Report Printer
// Drop this into a React + Vite StackBlitz project
// Run: npm install xlsx
// ============================================================

import { useState, useCallback } from 'react'
import * as XLSX from 'xlsx'

// ============================================================
// DEFAULTS & CONSTANTS
// ============================================================

const DEFAULT_SETTINGS = {
  workStart: '08:00',
  workEnd: '17:00',
  gracePeriod: 5,
  overtimeMin: 0,
  printFontSize: 'normal',
  sheetIndex: 4,
  blockWidth: 15,
  nameRow: 2,
  nameColOffset: 9,
  dataStartRow: 11,
  workDays: [1, 2, 3, 4, 5],
}

const PAGES = { UPLOAD: 'upload', LIST: 'list', DETAIL: 'detail', SETTINGS: 'settings' }

// ============================================================
// UTILITIES
// ============================================================

function timeToMinutes(t) {
  if (!t || typeof t !== 'string') return null
  const [h, m] = t.trim().split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return null
  return h * 60 + m
}

function minsToHHMM(m) {
  if (m === null || m === undefined || m < 0) return '-'
  const h = Math.floor(m / 60)
  const mm = m % 60
  return h > 0 ? `${h}j ${mm}m` : `${mm}m`
}

function minsToTimeStr(mins) {
  if (mins === null) return '-'
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

function parseDayStr(s) {
  const map = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 }
  if (!s) return null
  const parts = s.trim().split(' ')
  if (parts.length < 2) return null
  return { day: parseInt(parts[0], 10), weekday: map[parts[1]] ?? -1 }
}

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('absensi_v1') || '{}') } }
  catch { return { ...DEFAULT_SETTINGS } }
}

function saveSettingsStorage(s) {
  localStorage.setItem('absensi_v1', JSON.stringify(s))
}

// ============================================================
// PARSER
// ============================================================

function parseFile(workbook, cfg) {
  const sheetName = workbook.SheetNames[cfg.sheetIndex]
  if (!sheetName) throw new Error(`Sheet ke-${cfg.sheetIndex + 1} tidak ditemukan. Cek "Index Sheet" di Pengaturan.`)
  const sheet = workbook.Sheets[sheetName]
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

  const startMin = timeToMinutes(cfg.workStart)
  const endMin = timeToMinutes(cfg.workEnd)
  const grace = Number(cfg.gracePeriod) || 0
  const otBuffer = Number(cfg.overtimeMin) || 0

  const nameRow = data[cfg.nameRow] || []
  const employees = []

  for (let col = 0; col < nameRow.length; col += cfg.blockWidth) {
    const name = String(nameRow[col + cfg.nameColOffset] || '').trim()
    if (!name || name.toLowerCase() === 'name') continue

    const noRow = data[3] || []
    const empNo = String(noRow[col + cfg.nameColOffset] || '').trim()

    const days = []
    for (let r = cfg.dataStartRow; r < data.length; r++) {
      const row = data[r] || []
      const dateStr = String(row[col] || '').trim()
      if (!dateStr) continue
      const dayInfo = parseDayStr(dateStr)
      if (!dayInfo || dayInfo.day < 1) continue

      const amIn  = String(row[col + 1]  || '').trim()
      const amOut = String(row[col + 3]  || '').trim()
      const pmIn  = String(row[col + 6]  || '').trim()
      const pmOut = String(row[col + 8]  || '').trim()
      const otIn  = String(row[col + 10] || '').trim()
      const otOut = String(row[col + 12] || '').trim()

      const isAbsent = pmIn === 'Absence' || amIn === 'Absence'
      const isWeekend = !cfg.workDays.includes(dayInfo.weekday)

      let firstIn = null, lastOut = null, lateMin = 0, otMin = 0

      if (!isAbsent && !isWeekend) {
        const ins  = [amIn, pmIn, otIn].map(timeToMinutes).filter(v => v !== null)
        const outs = [amOut, pmOut, otOut].map(timeToMinutes).filter(v => v !== null)
        firstIn = ins.length  ? Math.min(...ins)  : null
        lastOut = outs.length ? Math.max(...outs) : null
        if (firstIn !== null) lateMin = Math.max(0, firstIn - (startMin + grace))
        if (lastOut !== null) otMin = Math.max(0, lastOut - endMin - otBuffer)
      }

      days.push({
        dateStr, dayInfo,
        amIn: isAbsent ? '' : amIn, amOut,
        pmIn: isAbsent ? '' : pmIn, pmOut,
        otIn, otOut,
        isAbsent, isWeekend,
        firstIn, lastOut,
        lateMin, otMin,
      })
    }

    const workDaysList = days.filter(d => !d.isWeekend)
    const present  = workDaysList.filter(d => !d.isAbsent && d.firstIn !== null)
    const absent   = workDaysList.filter(d => d.isAbsent)
    const totalLate = present.reduce((s, d) => s + d.lateMin, 0)
    const totalOT   = days.reduce((s, d) => s + d.otMin, 0)

    employees.push({ name, empNo, days, presentDays: present.length, absentDays: absent.length, totalLate, totalOT })
  }

  return employees
}

// ============================================================
// ESC/POS BUILDER
// ============================================================

function buildEscPos(emp, period, cfg) {
  const ESC = 0x1B, GS = 0x1D, LF = 0x0A
  const b = []
  const push = (...args) => b.push(...args)
  const text = s => { for (const c of String(s)) push(c.charCodeAt(0) & 0xFF) }
  const line = (s = '') => { text(s); push(LF) }
  const div  = () => line('--------------------------------')
  const align = a => push(ESC, 0x61, a)   // 0=L 1=C
  const bold  = on => push(ESC, 0x45, on ? 1 : 0)
  const size  = big => push(ESC, 0x21, big ? 0x10 : 0x00)
  const isBig = cfg.printFontSize === 'large'

  push(ESC, 0x40) // init

  align(1); size(true); bold(true)
  line('LAPORAN ABSENSI')
  bold(false); size(false)
  line(period)
  align(0); div()

  bold(true); line(`Nama   : ${emp.name}`); bold(false)
  div()

  size(isBig)
  line('TGL    IN    OUT   TMBT  LMBR')
  div()

  for (const d of emp.days) {
    if (d.isWeekend) continue
    const dt  = d.dateStr.substring(0, 5).padEnd(6)
    const inp = (d.amIn || (d.isAbsent ? 'ABSEN' : '-')).padEnd(5)
    const out = (d.lastOut !== null ? minsToTimeStr(d.lastOut) : '-').padEnd(5)
    const lat = d.isAbsent ? ''.padEnd(5) : (d.lateMin > 0 ? `${d.lateMin}m` : '-').padEnd(5)
    const ot  = d.otMin > 0 ? minsToHHMM(d.otMin) : '-'
    line(`${dt}${inp}${out}${lat}${ot}`)
  }

  size(false); div()
  line(`Hadir        : ${emp.presentDays} hari`)
  line(`Absen        : ${emp.absentDays} hari`)
  line(`Tot.Terlambat: ${emp.totalLate} menit`)
  line(`Tot.Lembur   : ${minsToHHMM(emp.totalOT)}`)
  div()

  align(1)
  const now = new Date()
  line(`Dicetak: ${now.toLocaleDateString('id-ID')} ${now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`)
  align(0)

  push(LF, LF, LF)
  push(GS, 0x56, 0x41, 0x03) // full cut

  return new Uint8Array(b)
}

// ============================================================
// BLUETOOTH PRINT
// ============================================================

const BLE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  '0000ff00-0000-1000-8000-00805f9b34fb',
]
const BLE_CHARS = [
  '00002af1-0000-1000-8000-00805f9b34fb',
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  '0000ff02-0000-1000-8000-00805f9b34fb',
]

async function bluetoothPrint(emp, period, cfg) {
  if (!navigator.bluetooth) throw new Error('WebBluetooth tidak tersedia. Gunakan Android Chrome.')
  const bytes = buildEscPos(emp, period, cfg)
  const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES })
  const server = await device.gatt.connect()

  let char = null
  for (let i = 0; i < BLE_SERVICES.length; i++) {
    try {
      const svc = await server.getPrimaryService(BLE_SERVICES[i])
      char = await svc.getCharacteristic(BLE_CHARS[i])
      break
    } catch {}
  }
  if (!char) throw new Error('Characteristic printer tidak ditemukan. Coba printer lain.')

  for (let i = 0; i < bytes.length; i += 20) {
    await char.writeValue(bytes.slice(i, i + 20))
  }
  await device.gatt.disconnect()
}

// ============================================================
// APP ROOT
// ============================================================

export default function App() {
  const [page, setPage]           = useState(PAGES.UPLOAD)
  const [settings, setSettings]   = useState(loadSettings)
  const [employees, setEmployees] = useState([])
  const [period, setPeriod]       = useState('')
  const [selected, setSelected]   = useState(null)
  const [printMsg, setPrintMsg]   = useState({ text: '', ok: true })
  const [globalErr, setGlobalErr] = useState('')

  const applySettings = s => { setSettings(s); saveSettingsStorage(s) }

  const handleFile = useCallback(async file => {
    setGlobalErr('')
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[settings.sheetIndex]]
      const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      // Try grab period string from row 1 or 3
      const periodStr = String(raw[1]?.[3] || raw[3]?.[1] || '').trim()
      setPeriod(periodStr)
      const emps = parseFile(wb, settings)
      if (!emps.length) throw new Error('Tidak ada data karyawan ditemukan. Periksa "Index Sheet" dan "Row Nama" di Pengaturan.')
      setEmployees(emps)
      setPage(PAGES.LIST)
    } catch (e) {
      setGlobalErr(e.message)
    }
  }, [settings])

  const handlePrint = async emp => {
    setPrintMsg({ text: 'Menghubungkan...', ok: true })
    try {
      await bluetoothPrint(emp, period, settings)
      setPrintMsg({ text: '✓ Berhasil dicetak!', ok: true })
    } catch (e) {
      setPrintMsg({ text: `✗ ${e.message}`, ok: false })
    }
    setTimeout(() => setPrintMsg({ text: '', ok: true }), 5000)
  }

  return (
    <div style={S.app}>
      <Navbar page={page} setPage={setPage} hasData={!!employees.length} />
      {globalErr && (
        <div style={S.toast}>
          <span>{globalErr}</span>
          <button onClick={() => setGlobalErr('')} style={S.toastClose}>×</button>
        </div>
      )}
      {page === PAGES.UPLOAD   && <UploadPage onFile={handleFile} />}
      {page === PAGES.LIST     && <ListPage employees={employees} period={period} onSelect={e => { setSelected(e); setPage(PAGES.DETAIL) }} />}
      {page === PAGES.DETAIL   && selected && <DetailPage emp={selected} onPrint={handlePrint} printMsg={printMsg} />}
      {page === PAGES.SETTINGS && <SettingsPage settings={settings} onSave={applySettings} />}
    </div>
  )
}

// ============================================================
// NAVBAR
// ============================================================

function Navbar({ page, setPage, hasData }) {
  return (
    <nav style={S.nav}>
      <div style={S.navBrand}>
        <span style={S.navIcon}>◉</span>
        <span>AbsensiPrint</span>
      </div>
      <div style={S.navLinks}>
        <NBtn active={page === PAGES.UPLOAD}   onClick={() => setPage(PAGES.UPLOAD)}>Upload</NBtn>
        {hasData && <NBtn active={page === PAGES.LIST} onClick={() => setPage(PAGES.LIST)}>Karyawan</NBtn>}
        <NBtn active={page === PAGES.SETTINGS} onClick={() => setPage(PAGES.SETTINGS)}>Pengaturan</NBtn>
      </div>
    </nav>
  )
}

function NBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{ ...S.navBtn, ...(active ? S.navBtnOn : {}) }}>
      {children}
    </button>
  )
}

// ============================================================
// UPLOAD PAGE
// ============================================================

function UploadPage({ onFile }) {
  const [drag, setDrag] = useState(false)

  const onDrop = e => {
    e.preventDefault(); setDrag(false)
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0])
  }

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <h1 style={S.h1}>Upload File Absensi</h1>
        <p style={S.sub}>Export dari mesin fingerprint (.xls / .xlsx)</p>
      </div>
      <div
        style={{ ...S.drop, ...(drag ? S.dropActive : {}) }}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => document.getElementById('fi').click()}
      >
        <div style={S.dropEmoji}>📂</div>
        <div style={S.dropLabel}>Drag & drop file atau klik untuk pilih</div>
        <div style={S.dropHint}>.xls · .xlsx</div>
        <input id="fi" type="file" accept=".xls,.xlsx" style={{ display: 'none' }}
          onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
      </div>
      <div style={S.btNote}>
        <span style={S.btDot}>⚠</span>
        Print via Bluetooth hanya berfungsi di <strong>Android Chrome</strong>
      </div>
    </div>
  )
}

// ============================================================
// LIST PAGE
// ============================================================

function ListPage({ employees, period, onSelect }) {
  const [q, setQ] = useState('')
  const filtered = employees.filter(e => e.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <h1 style={S.h1}>Daftar Karyawan</h1>
        <p style={S.sub}>{period} — {employees.length} karyawan</p>
      </div>
      <input
        style={S.search}
        placeholder="🔍  Cari nama..."
        value={q}
        onChange={e => setQ(e.target.value)}
      />
      <div style={S.grid}>
        {filtered.map((emp, i) => (
          <EmpCard key={i} emp={emp} onClick={() => onSelect(emp)} />
        ))}
      </div>
    </div>
  )
}

function EmpCard({ emp, onClick }) {
  return (
    <div style={S.card} onClick={onClick}>
      <div style={S.cardName}>{emp.name}</div>
      <div style={S.cardStats}>
        <Chip label="Hadir"  val={`${emp.presentDays}h`} color="#4ade80" />
        <Chip label="Absen"  val={`${emp.absentDays}h`}  color="#f87171" />
        <Chip label="Terlambat" val={`${emp.totalLate}m`}  color="#fbbf24" />
        <Chip label="Lembur" val={minsToHHMM(emp.totalOT)} color="#60a5fa" />
      </div>
      <div style={S.cardArrow}>→</div>
    </div>
  )
}

function Chip({ label, val, color }) {
  return (
    <div style={S.chip}>
      <span style={{ ...S.chipVal, color }}>{val}</span>
      <span style={S.chipLabel}>{label}</span>
    </div>
  )
}

// ============================================================
// DETAIL PAGE
// ============================================================

function DetailPage({ emp, onPrint, printMsg }) {
  return (
    <div style={S.page}>
      <div style={S.detailTop}>
        <div>
          <h1 style={S.h1}>{emp.name}</h1>
          <div style={S.summaryRow}>
            <SumCard label="Hari Hadir"    val={emp.presentDays}          color="#4ade80" unit="hari" />
            <SumCard label="Hari Absen"    val={emp.absentDays}           color="#f87171" unit="hari" />
            <SumCard label="Tot.Terlambat" val={`${emp.totalLate}`}       color="#fbbf24" unit="menit" />
            <SumCard label="Tot.Lembur"    val={minsToHHMM(emp.totalOT)}  color="#60a5fa" />
          </div>
        </div>
        <div style={S.printGroup}>
          <button style={S.printBtn} onClick={() => onPrint(emp)}>🖨 Print</button>
          {printMsg.text && (
            <div style={{ ...S.printStatus, color: printMsg.ok ? '#4ade80' : '#f87171' }}>
              {printMsg.text}
            </div>
          )}
        </div>
      </div>

      <div style={S.tblWrap}>
        <table style={S.tbl}>
          <thead>
            <tr>
              {['Tgl', 'AM In', 'AM Out', 'PM In', 'PM Out', 'OT In', 'OT Out', 'Terlambat', 'Lembur'].map(h => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {emp.days.filter(d => !d.isWeekend).map((d, i) => (
              <tr key={i} style={{ ...S.tr, ...(d.isAbsent ? S.trAbs : i % 2 === 0 ? S.trAlt : {}) }}>
                <td style={{ ...S.td, ...S.tdDate }}>{d.dateStr}</td>
                <td style={S.tdMono}>{d.isAbsent ? <span style={S.absTag}>ABSEN</span> : d.amIn || '-'}</td>
                <td style={S.tdMono}>{d.amOut || '-'}</td>
                <td style={S.tdMono}>{d.pmIn || '-'}</td>
                <td style={S.tdMono}>{d.pmOut || '-'}</td>
                <td style={S.tdMono}>{d.otIn || '-'}</td>
                <td style={S.tdMono}>{d.otOut || '-'}</td>
                <td style={{ ...S.td, color: d.lateMin > 0 ? '#fbbf24' : '#475569', fontWeight: d.lateMin > 0 ? 600 : 400 }}>
                  {d.lateMin > 0 ? `${d.lateMin} mnt` : '-'}
                </td>
                <td style={{ ...S.td, color: d.otMin > 0 ? '#60a5fa' : '#475569', fontWeight: d.otMin > 0 ? 600 : 400 }}>
                  {d.otMin > 0 ? minsToHHMM(d.otMin) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SumCard({ label, val, color, unit }) {
  return (
    <div style={S.sumCard}>
      <div style={{ ...S.sumVal, color }}>{val}{unit ? <span style={S.sumUnit}> {unit}</span> : ''}</div>
      <div style={S.sumLabel}>{label}</div>
    </div>
  )
}

// ============================================================
// SETTINGS PAGE
// ============================================================

function SettingsPage({ settings, onSave }) {
  const [s, setS] = useState({ ...settings })
  const set = (k, v) => setS(p => ({ ...p, [k]: v }))
  const [saved, setSaved] = useState(false)

  const save = () => {
    onSave(s)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={S.page}>
      <div style={S.pageHead}>
        <h1 style={S.h1}>Pengaturan</h1>
        <p style={S.sub}>Semua pengaturan tersimpan otomatis di browser</p>
      </div>

      <Sec title="📅 Jadwal Kerja">
        <Row label="Jam Masuk">
          <input type="time" value={s.workStart} onChange={e => set('workStart', e.target.value)} style={S.inp} />
        </Row>
        <Row label="Jam Keluar">
          <input type="time" value={s.workEnd} onChange={e => set('workEnd', e.target.value)} style={S.inp} />
        </Row>
        <Row label="Toleransi Terlambat (menit)" hint="Cth: 5 = terlambat dihitung jika masuk setelah jam masuk + 5 menit">
          <input type="number" min="0" value={s.gracePeriod} onChange={e => set('gracePeriod', e.target.value)} style={{ ...S.inp, maxWidth: 120 }} />
        </Row>
        <Row label="Min. Menit untuk Lembur" hint="Menit setelah jam keluar sebelum dihitung lembur (0 = langsung)">
          <input type="number" min="0" value={s.overtimeMin} onChange={e => set('overtimeMin', e.target.value)} style={{ ...S.inp, maxWidth: 120 }} />
        </Row>
        <Row label="Hari Kerja">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['Min','Sen','Sel','Rab','Kam','Jum','Sab'].map((d, i) => (
              <button
                key={i}
                style={{ ...S.dayBtn, ...(s.workDays.includes(i) ? S.dayBtnOn : {}) }}
                onClick={() => set('workDays', s.workDays.includes(i) ? s.workDays.filter(x => x !== i) : [...s.workDays, i])}
              >{d}</button>
            ))}
          </div>
        </Row>
      </Sec>

      <Sec title="🖨 Cetak / Print">
        <Row label="Ukuran Font Slip 58mm">
          <select value={s.printFontSize} onChange={e => set('printFontSize', e.target.value)} style={S.inp}>
            <option value="normal">Normal — lebih banyak data per baris</option>
            <option value="large">Besar — header nama lebih besar</option>
          </select>
        </Row>
      </Sec>

      <Sec title="📂 Mapping File / Sheet" hint="Sesuaikan jika format mesin baru berbeda">
        <Row label="Index Sheet (mulai dari 0)" hint="Sheet ke-5 = index 4">
          <input type="number" min="0" value={s.sheetIndex} onChange={e => set('sheetIndex', parseInt(e.target.value))} style={{ ...S.inp, maxWidth: 120 }} />
        </Row>
        <Row label="Lebar Blok per Karyawan (kolom)" hint="Default mesin ini: 15">
          <input type="number" min="1" value={s.blockWidth} onChange={e => set('blockWidth', parseInt(e.target.value))} style={{ ...S.inp, maxWidth: 120 }} />
        </Row>
        <Row label="Baris Nama (row index, mulai dari 0)" hint="Default: 2">
          <input type="number" min="0" value={s.nameRow} onChange={e => set('nameRow', parseInt(e.target.value))} style={{ ...S.inp, maxWidth: 120 }} />
        </Row>
        <Row label="Offset Kolom Nama dalam Blok" hint="Default: 9">
          <input type="number" min="0" value={s.nameColOffset} onChange={e => set('nameColOffset', parseInt(e.target.value))} style={{ ...S.inp, maxWidth: 120 }} />
        </Row>
        <Row label="Baris Awal Data Harian (row index, mulai dari 0)" hint="Default: 11">
          <input type="number" min="0" value={s.dataStartRow} onChange={e => set('dataStartRow', parseInt(e.target.value))} style={{ ...S.inp, maxWidth: 120 }} />
        </Row>
      </Sec>

      <button style={{ ...S.saveBtn, ...(saved ? S.saveBtnOk : {}) }} onClick={save}>
        {saved ? '✓ Tersimpan!' : '💾 Simpan Pengaturan'}
      </button>
    </div>
  )
}

function Sec({ title, hint, children }) {
  return (
    <div style={S.sec}>
      <div style={S.secHead}>
        <span style={S.secTitle}>{title}</span>
        {hint && <span style={S.secHint}>{hint}</span>}
      </div>
      <div style={S.secBody}>{children}</div>
    </div>
  )
}

function Row({ label, hint, children }) {
  return (
    <div style={S.row}>
      <div style={S.rowLeft}>
        <div style={S.rowLabel}>{label}</div>
        {hint && <div style={S.rowHint}>{hint}</div>}
      </div>
      <div style={S.rowRight}>{children}</div>
    </div>
  )
}

// ============================================================
// STYLES
// ============================================================

const C = {
  bg:      '#0c0e14',
  surface: '#13161f',
  card:    '#191c28',
  border:  '#252840',
  text:    '#e2e8f0',
  muted:   '#64748b',
  subtle:  '#94a3b8',
  amber:   '#f59e0b',
  amberLo: '#78350f',
}

const S = {
  app:     { minHeight: '100vh', background: C.bg, color: C.text, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", fontSize: 14 },

  // NAV
  nav:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', height: 52, background: C.surface, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 100 },
  navBrand:  { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 15, color: C.amber, letterSpacing: '-0.3px' },
  navIcon:   { fontSize: 18, lineHeight: 1 },
  navLinks:  { display: 'flex', gap: 2 },
  navBtn:    { background: 'none', border: 'none', color: C.muted, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500, transition: 'color .15s' },
  navBtnOn:  { background: '#1e2035', color: C.amber },

  // PAGES
  page:     { maxWidth: 880, margin: '0 auto', padding: '28px 16px 60px' },
  pageHead: { marginBottom: 24 },
  h1:       { fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: '#f1f5f9', letterSpacing: '-0.5px' },
  sub:      { color: C.muted, fontSize: 13, margin: 0 },

  // TOAST
  toast:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#3b0a0a', color: '#fca5a5', padding: '10px 20px', borderLeft: '3px solid #ef4444' },
  toastClose: { background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 20, lineHeight: 1 },

  // UPLOAD
  drop:       { border: `2px dashed ${C.border}`, borderRadius: 14, padding: '56px 24px', textAlign: 'center', cursor: 'pointer', transition: 'all .2s', marginBottom: 20 },
  dropActive: { borderColor: C.amber, background: '#1a1200' },
  dropEmoji:  { fontSize: 52, marginBottom: 14 },
  dropLabel:  { fontSize: 16, color: C.subtle, marginBottom: 6 },
  dropHint:   { fontSize: 12, color: C.muted, fontFamily: 'monospace' },
  btNote:     { display: 'flex', alignItems: 'center', gap: 8, background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.amber}`, borderRadius: 8, padding: '10px 14px', fontSize: 12, color: C.muted },
  btDot:      { color: C.amber, flexShrink: 0 },

  // LIST
  search: { width: '100%', boxSizing: 'border-box', background: C.surface, border: `1px solid ${C.border}`, color: C.text, padding: '10px 14px', borderRadius: 8, fontSize: 14, marginBottom: 16, outline: 'none' },
  grid:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 },
  card:   { background: C.card, borderRadius: 10, padding: '16px', cursor: 'pointer', border: `1px solid ${C.border}`, position: 'relative', transition: 'border-color .15s' },
  cardName:  { fontWeight: 600, fontSize: 15, marginBottom: 12, color: '#f1f5f9', paddingRight: 20 },
  cardStats: { display: 'flex', gap: 14, flexWrap: 'wrap' },
  cardArrow: { position: 'absolute', top: 16, right: 14, color: C.muted, fontSize: 14 },
  chip:      { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  chipVal:   { fontSize: 16, fontWeight: 700, lineHeight: 1.2 },
  chipLabel: { fontSize: 10, color: C.muted, marginTop: 2 },

  // DETAIL
  detailTop:   { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 16 },
  summaryRow:  { display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' },
  sumCard:     { background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', minWidth: 90 },
  sumVal:      { fontSize: 20, fontWeight: 700, lineHeight: 1 },
  sumUnit:     { fontSize: 12, fontWeight: 400 },
  sumLabel:    { fontSize: 10, color: C.muted, marginTop: 4 },
  printGroup:  { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 },
  printBtn:    { background: C.amber, color: '#000', border: 'none', padding: '11px 22px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' },
  printStatus: { fontSize: 12, fontWeight: 500 },

  // TABLE
  tblWrap: { overflowX: 'auto', borderRadius: 10, border: `1px solid ${C.border}` },
  tbl:     { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:      { padding: '9px 12px', textAlign: 'left', color: C.muted, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.5px', background: C.surface },
  tr:      { borderBottom: `1px solid #0f111a` },
  trAlt:   { background: '#10121b' },
  trAbs:   { background: '#160a0a' },
  td:      { padding: '7px 12px', verticalAlign: 'middle' },
  tdDate:  { fontWeight: 600, color: C.subtle, whiteSpace: 'nowrap' },
  tdMono:  { padding: '7px 12px', fontFamily: "'Fira Code', monospace", fontSize: 12.5, verticalAlign: 'middle', color: C.subtle },
  absTag:  { background: '#450a0a', color: '#f87171', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, letterSpacing: '.5px' },

  // SETTINGS
  sec:      { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 14, overflow: 'hidden' },
  secHead:  { display: 'flex', alignItems: 'baseline', gap: 10, padding: '12px 18px', borderBottom: `1px solid ${C.border}`, background: '#0f1119' },
  secTitle: { fontWeight: 600, color: C.amber, fontSize: 13 },
  secHint:  { fontSize: 11, color: C.muted },
  secBody:  { padding: '4px 0' },
  row:      { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '10px 18px', borderBottom: `1px solid #0f1119`, flexWrap: 'wrap', gap: 8 },
  rowLeft:  { flex: 1, minWidth: 160 },
  rowRight: { flexShrink: 0 },
  rowLabel: { fontSize: 13, color: C.text, fontWeight: 500 },
  rowHint:  { fontSize: 11, color: C.muted, marginTop: 2 },
  inp:      { background: C.bg, border: `1px solid ${C.border}`, color: C.text, padding: '7px 10px', borderRadius: 6, fontSize: 13, width: '100%', boxSizing: 'border-box', outline: 'none' },
  dayBtn:   { background: C.bg, border: `1px solid ${C.border}`, color: C.muted, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  dayBtnOn: { background: C.amberLo, border: `1px solid ${C.amber}`, color: C.amber },
  saveBtn:  { width: '100%', background: C.amber, color: '#000', border: 'none', padding: '13px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', marginTop: 4, transition: 'background .2s' },
  saveBtnOk:{ background: '#16a34a', color: '#fff' },
}
