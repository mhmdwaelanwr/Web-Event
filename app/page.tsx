"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

type ThemeMode = "system" | "light" | "dark";
type AuthState = "checking" | "locked" | "authorized";
type AttendanceState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "success"; registrationId: string; message: string }
  | { type: "duplicate"; registrationId: string; message: string }
  | { type: "approval"; registrationId: string; message: string }
  | { type: "pending"; registrationId: string; pendingCount: number }
  | { type: "error"; message: string };

type ApiBody = {
  success?: boolean;
  error?: string;
  message?: string;
  registrationId?: string;
  day?: number;
  alreadyMarked?: boolean;
};

const PENDING_KEY = "event-checkin-pending-v1";
const THEME_KEY = "event-checkin-theme";
const HAPTIC_KEY = "event-checkin-haptic";
const MAX_PENDING = 100;
const SCAN_DELAY = 3000;
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "moanwarpcz@gmail.com";
const SUPPORT_WHATSAPP = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP || "201010373387";

function normalizeRegistrationId(value: string): string | null {
  const normalized = value.trim();
  return normalized && normalized.length <= 160 && !/[\u0000-\u001F\u007F]/.test(normalized)
    ? normalized
    : null;
}

function isDuplicateMessage(message?: string | null) {
  if (!message) return false;
  const markers = ["already registered", "already checked in", "duplicate", "مسجل مسبقا", "تم تسجيله مسبقا"];
  return markers.some((marker) => message.toLowerCase().includes(marker.toLowerCase()));
}

function readPending(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writePending(items: string[]) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(Array.from(new Set(items)).slice(0, MAX_PENDING)));
  } catch {
    // Storage can be unavailable in hardened/private browser modes.
  }
}

async function parseBody(response: Response): Promise<ApiBody> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ApiBody;
  } catch {
    return { error: raw };
  }
}

async function sendAttendance(registrationId: string, sudo: boolean) {
  const response = await fetch("/api/attendance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ registrationId, sudo }),
    cache: "no-store"
  });
  return { response, body: await parseBody(response) };
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [screen, setScreen] = useState<"scanner" | "settings">("scanner");
  const [state, setState] = useState<AttendanceState>({ type: "idle" });
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [haptic, setHaptic] = useState(true);
  const [sudoMode, setSudoMode] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const lastScanRef = useRef<{ id: string; time: number } | null>(null);

  useEffect(() => {
    const storedTheme = localStorage.getItem(THEME_KEY) as ThemeMode | null;
    if (storedTheme === "system" || storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
    const storedHaptic = localStorage.getItem(HAPTIC_KEY);
    if (storedHaptic !== null) setHaptic(storedHaptic !== "false");
    setPendingCount(readPending().length);

    fetch("/api/session", { cache: "no-store" })
      .then((res) => setAuth(res.ok ? "authorized" : "locked"))
      .catch(() => setAuth("locked"));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(HAPTIC_KEY, String(haptic));
  }, [haptic]);

  useEffect(() => {
    if (!haptic || state.type === "idle" || state.type === "loading") return;
    if ("vibrate" in navigator) navigator.vibrate(200);
  }, [state, haptic]);

  useEffect(() => {
    if (state.type !== "duplicate" && state.type !== "pending") return;
    const timer = window.setTimeout(() => setState({ type: "idle" }), 2500);
    return () => window.clearTimeout(timer);
  }, [state.type]);

  const refreshPendingCount = useCallback(() => setPendingCount(readPending().length), []);

  const queueOffline = useCallback((registrationId: string) => {
    const current = readPending();
    if (current.includes(registrationId)) {
      setPendingCount(current.length);
      return current.length;
    }
    if (current.length >= MAX_PENDING) return null;
    const next = [...current, registrationId];
    writePending(next);
    setPendingCount(next.length);
    return next.length;
  }, []);

  const retryPending = useCallback(async () => {
    const pending = readPending();
    if (!pending.length || auth !== "authorized") return;

    const remaining = [...pending];
    for (const registrationId of pending) {
      try {
        const { response, body } = await sendAttendance(registrationId, sudoMode);
        if (response.status === 401) {
          setAuth("locked");
          break;
        }
        const message = body.error || body.message;
        if ((response.ok && body.success === true) || response.status === 409 || isDuplicateMessage(message)) {
          const index = remaining.indexOf(registrationId);
          if (index >= 0) remaining.splice(index, 1);
        }
      } catch {
        break;
      }
    }
    writePending(remaining);
    setPendingCount(remaining.length);
  }, [auth, sudoMode]);

  useEffect(() => {
    if (auth !== "authorized") return;
    void retryPending();
    const online = () => void retryPending();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [auth, retryPending]);

  const markAttendance = useCallback(
    async (rawId: string, sudoOverride = false) => {
      const registrationId = normalizeRegistrationId(rawId);
      if (!registrationId) {
        setState({ type: "error", message: "Invalid registration code" });
        return;
      }

      if (state.type === "loading") return;
      const now = Date.now();
      const last = lastScanRef.current;
      if (!sudoOverride && last?.id === registrationId && now - last.time < SCAN_DELAY) return;
      lastScanRef.current = { id: registrationId, time: now };

      setState({ type: "loading" });
      try {
        const { response, body } = await sendAttendance(registrationId, sudoOverride || sudoMode);
        const message = body.error || body.message;

        if (response.status === 401) {
          setAuth("locked");
          setSudoMode(false);
          setState({ type: "idle" });
          return;
        }

        if (response.status === 502 || response.status === 503 || response.status === 504) {
          const count = queueOffline(registrationId);
          setState(
            count === null
              ? { type: "error", message: "Offline queue is full. Connect to the internet and try again." }
              : { type: "pending", registrationId, pendingCount: count }
          );
          return;
        }

        if (response.ok) {
          if (body.success === true) {
            const successMessage =
              body.message || (body.alreadyMarked ? "Attendance was already marked for today" : "Attendance marked successfully");
            setState({
              type: "success",
              registrationId: body.registrationId || registrationId,
              message: successMessage
            });
            const remaining = readPending().filter((item) => item !== registrationId);
            writePending(remaining);
            setPendingCount(remaining.length);
            window.setTimeout(() => void retryPending(), 250);
            return;
          }

          if (isDuplicateMessage(message)) {
            setState({ type: "duplicate", registrationId, message: message || "User already registered" });
          } else {
            setState({ type: "error", message: message || "Failed to mark attendance" });
          }
          return;
        }

        if (response.status === 403) {
          setState({
            type: "approval",
            registrationId,
            message: message || "This attendee has not been accepted yet"
          });
        } else if (response.status === 409) {
          setState({ type: "duplicate", registrationId, message: message || "User already registered" });
        } else {
          setState({
            type: "error",
            message: message || `The check-in service rejected the request (${response.status}).`
          });
        }
      } catch {
        const count = queueOffline(registrationId);
        setState(
          count === null
            ? { type: "error", message: "Offline queue is full. Connect to the internet and try again." }
            : { type: "pending", registrationId, pendingCount: count }
        );
      }
    },
    [queueOffline, retryPending, state.type, sudoMode]
  );

  const lockStation = useCallback(async () => {
    await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
    setAuth("locked");
    setScreen("scanner");
    setSudoMode(false);
    setState({ type: "idle" });
  }, []);

  if (auth === "checking") {
    return (
      <main className="app-shell" style={{ display: "grid", placeItems: "center" }}>
        <span className="spinner" style={{ borderColor: "#bbb", borderTopColor: "#0078d4" }} />
      </main>
    );
  }

  if (auth === "locked") {
    return <AccessScreen onAuthorized={() => setAuth("authorized")} />;
  }

  if (screen === "settings") {
    return (
      <SettingsScreen
        theme={theme}
        setTheme={setTheme}
        haptic={haptic}
        setHaptic={setHaptic}
        sudoMode={sudoMode}
        setSudoMode={setSudoMode}
        onBack={() => setScreen("scanner")}
        onLock={lockStation}
      />
    );
  }

  if (state.type === "success") {
    return <SuccessScreen state={state} onNext={() => setState({ type: "idle" })} />;
  }

  return (
    <main className="app-shell scanner-page">
      <ScannerScreen
        state={state}
        pendingCount={pendingCount}
        onScan={(value) => void markAttendance(value)}
        onSettings={() => setScreen("settings")}
      />

      {state.type === "approval" && (
        <ApprovalModal
          state={state}
          onSkip={() => setState({ type: "idle" })}
          onApprove={() => void markAttendance(state.registrationId, true)}
        />
      )}
      {state.type === "duplicate" && (
        <ResultModal type="duplicate" message={`${state.message}\nID: ${state.registrationId}`} onDismiss={() => setState({ type: "idle" })} />
      )}
      {state.type === "pending" && (
        <ResultModal
          type="pending"
          message={`Saved securely for automatic sync.\nID: ${state.registrationId}\nPending: ${state.pendingCount}`}
          onDismiss={() => setState({ type: "idle" })}
        />
      )}
      {state.type === "error" && <ResultModal type="error" message={state.message} onDismiss={() => setState({ type: "idle" })} />}
    </main>
  );
}

function AccessScreen({ onAuthorized }: { onAuthorized: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function verify() {
    if (!key.trim() || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim() })
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) onAuthorized();
      else setError(body.error || "Incorrect access key. Please try again.");
    } catch {
      setError("Could not verify the access key. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setKey(text.trim());
        setError("");
      }
    } catch {
      setError("Paste permission was blocked. Enter the key manually.");
    }
  }

  return (
    <main className="app-shell">
      <section className="content-shell">
        <div className="icon-bubble" aria-hidden>🔑</div>
        <div className="access-space" />
        <h1>Staff access</h1>
        <p>Enter the event access key to open the check-in scanner.</p>
        <div className="access-space large" />

        <div className="field-wrap">
          <span className="field-label">Access key</span>
          <input
            className={`text-field ${error ? "error" : ""}`}
            value={key}
            onChange={(event) => { setKey(event.target.value); setError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter") void verify(); }}
            placeholder="Enter access key"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={loading}
          />
          <button className="field-action" onClick={() => key ? setKey("") : void paste()} aria-label={key ? "Clear" : "Paste"}>
            {key ? "×" : "⧉"}
          </button>
        </div>
        {error && <div className="supporting-error">{error}</div>}
        <div style={{ height: 20 }} />
        <button className="primary-button" onClick={() => void verify()} disabled={loading || !key.trim()}>
          {loading ? <span className="spinner" /> : "Verify and continue"}
        </button>

        <div className="secure-card">
          <span className="shield" aria-hidden>✓</span>
          <div>
            <strong>Secure staff access</strong>
            <small>Keys are verified server-side and are never exposed to the browser.</small>
          </div>
        </div>
        <p className="access-footer">Authorized event staff only</p>
      </section>
    </main>
  );
}

function ScannerScreen({
  state,
  pendingCount,
  onScan,
  onSettings
}: {
  state: AttendanceState;
  pendingCount: number;
  onScan: (value: string) => void;
  onSettings: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const scanReadyRef = useRef(state.type === "idle");
  const [cameraStatus, setCameraStatus] = useState<"starting" | "active" | "blocked">("starting");
  const [cameraError, setCameraError] = useState("");
  const [manualId, setManualId] = useState("");
  const [torch, setTorch] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);

  useEffect(() => { scanReadyRef.current = state.type === "idle"; }, [state.type]);

  const startCamera = useCallback(async () => {
    controlsRef.current?.stop();
    setCameraStatus("starting");
    setCameraError("");
    setTorch(false);
    setTorchAvailable(false);

    if (!navigator.mediaDevices?.getUserMedia || !videoRef.current) {
      setCameraStatus("blocked");
      setCameraError("Camera access is not supported in this browser. Use manual check-in below.");
      return;
    }

    try {
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        videoRef.current,
        (result) => {
          if (result && scanReadyRef.current) {
            scanReadyRef.current = false;
            onScan(result.getText());
          }
        }
      );
      controlsRef.current = controls;
      setCameraStatus("active");

      const stream = videoRef.current.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      setTorchAvailable(capabilities?.torch === true);
    } catch (error) {
      setCameraStatus("blocked");
      setCameraError(error instanceof Error ? error.message : "Camera permission is required to scan QR codes.");
    }
  }, [onScan]);

  useEffect(() => {
    void startCamera();
    return () => controlsRef.current?.stop();
  }, [startCamera]);

  async function toggleTorch() {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    const track = stream?.getVideoTracks()[0];
    if (!track || !torchAvailable) return;
    const next = !torch;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorch(next);
    } catch {
      setTorchAvailable(false);
    }
  }

  const status = {
    idle: ["Ready to scan", "status-idle"],
    loading: ["Verifying...", "status-loading"],
    success: ["Verified!", "status-success"],
    duplicate: ["Registered Before", "status-duplicate"],
    approval: ["Approval required", "status-approval"],
    pending: ["Saved for sync", "status-pending"],
    error: ["Error", "status-error"]
  }[state.type];

  function submitManual() {
    if (state.type !== "idle" || !manualId.trim()) return;
    onScan(manualId);
    setManualId("");
  }

  return (
    <>
      <video ref={videoRef} className="camera-video" autoPlay muted playsInline />
      {cameraStatus === "blocked" && (
        <div className="camera-fallback">
          <div>
            <div style={{ fontSize: 42 }}>📷</div>
            <p style={{ color: "#ddd", maxWidth: 330 }}>{cameraError || "Camera permission is required to scan QR codes."}</p>
            <button className="primary-button" onClick={() => void startCamera()}>Start camera</button>
          </div>
        </div>
      )}
      <div className="camera-dim" />

      <header className="scanner-header">
        <div className="eyebrow">EVENT CHECK-IN</div>
        <h1>Scan attendee QR</h1>
      </header>
      <button className="settings-gear" onClick={onSettings} aria-label="Settings">⚙</button>

      <div className={`status-pill ${status[1]}`}>{status[0]}</div>
      <button
        className={`torch-button ${torch ? "on" : ""}`}
        onClick={() => void toggleTorch()}
        disabled={!torchAvailable}
        aria-label="Toggle flashlight"
        title={torchAvailable ? "Toggle flashlight" : "Flashlight not available in this browser"}
      >
        {torch ? "⚡" : "◌"}
      </button>

      <div className="scan-frame-wrap" aria-hidden>
        <div className="scan-frame" />
        <div className="scan-laser" />
      </div>
      <div className="scan-hint">Hold the code inside the frame</div>

      <section className="manual-card">
        <h3>Manual check-in</h3>
        <div className="manual-row">
          <input
            className="manual-input"
            placeholder="Registration ID"
            value={manualId}
            onChange={(event) => setManualId(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") submitManual(); }}
            autoCapitalize="none"
            spellCheck={false}
          />
          <button className="manual-submit" onClick={submitManual} disabled={state.type !== "idle" || !manualId.trim()} aria-label="Check in">✓</button>
        </div>
        {pendingCount > 0 && <p className="pending-mini">Pending sync: {pendingCount}</p>}
      </section>

      {state.type === "loading" && <div className="loading-cover"><span className="spinner" /></div>}
    </>
  );
}

function SuccessScreen({ state, onNext }: { state: Extract<AttendanceState, { type: "success" }>; onNext: () => void }) {
  return (
    <main className="app-shell success-page">
      <section className="content-shell">
        <div className="icon-bubble success" aria-hidden>✓</div>
        <div style={{ height: 36 }} />
        <div className="kicker success">CHECK-IN COMPLETE</div>
        <h1>Attendance confirmed</h1>
        <p>The attendee is now marked as present.</p>
        <div className="success-card">
          <div className="label">Registration ID</div>
          <div className="registration">{state.registrationId}</div>
          <hr />
          <div className="checked">Checked in&nbsp; • &nbsp;Just now</div>
        </div>
        <button className="primary-button" onClick={onNext}>Scan next attendee</button>
      </section>
    </main>
  );
}

function ApprovalModal({
  state,
  onApprove,
  onSkip
}: {
  state: Extract<AttendanceState, { type: "approval" }>;
  onApprove: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal warning">
        <div className="modal-icon" aria-hidden>⚠</div>
        <h2>Attendee not accepted</h2>
        <p>{state.message}</p>
        <div className="registration-line">Registration ID: {state.registrationId}</div>
        <div style={{ height: 22 }} />
        <p style={{ color: "var(--text)", marginBottom: 0 }}>Do you want to override acceptance and check this attendee in?</p>
        <div className="modal-actions">
          <button className="outline-button" onClick={onSkip}>Skip</button>
          <button className="primary-button" onClick={onApprove}>Accept &amp; check in</button>
        </div>
      </div>
    </div>
  );
}

function ResultModal({
  type,
  message,
  onDismiss
}: {
  type: "duplicate" | "pending" | "error";
  message: string;
  onDismiss: () => void;
}) {
  const config = {
    duplicate: { icon: "ⓘ", title: "Already checked in", className: "result-duplicate" },
    pending: { icon: "ⓘ", title: "Saved for sync", className: "result-pending" },
    error: { icon: "⚠", title: "Check-in failed", className: "result-error" }
  }[type];

  const mail = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("EventSync Error Report")}&body=${encodeURIComponent(`Error Details:\n${message}`)}`;
  const whatsapp = `https://wa.me/${SUPPORT_WHATSAPP.replace(/\D/g, "")}?text=${encodeURIComponent(`Error Report:\n${message}`)}`;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }}>
      <div className={`modal ${config.className}`}>
        <div className="modal-icon" aria-hidden>{config.icon}</div>
        <h2>{config.title}</h2>
        <p style={{ whiteSpace: "pre-line", color: "var(--text)" }}>{message}</p>
        {type === "error" && (
          <>
            <div className="report-actions">
              <a href={mail}><button className="email-button">Email</button></a>
              <a href={whatsapp} target="_blank" rel="noreferrer"><button className="whatsapp-button">WhatsApp</button></a>
            </div>
            <button className="dismiss-link" onClick={onDismiss}>Dismiss</button>
          </>
        )}
      </div>
    </div>
  );
}

function SettingsScreen({
  theme,
  setTheme,
  haptic,
  setHaptic,
  sudoMode,
  setSudoMode,
  onBack,
  onLock
}: {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  haptic: boolean;
  setHaptic: (enabled: boolean) => void;
  sudoMode: boolean;
  setSudoMode: (enabled: boolean) => void;
  onBack: () => void;
  onLock: () => void;
}) {
  return (
    <main className="app-shell settings-page">
      <div className="gradient-line" />
      <header className="settings-topbar">
        <button className="back-button" onClick={onBack} aria-label="Back">←</button>
        <h1>Settings</h1>
      </header>
      <div className="settings-content">
        <p className="settings-intro">Customize your check-in station</p>

        <div className="section-title">APPEARANCE</div>
        <section className="settings-card">
          <h3>Theme</h3>
          <p>Choose how the app looks</p>
          <div className="theme-options">
            {(["system", "light", "dark"] as ThemeMode[]).map((option) => (
              <button key={option} className={`theme-chip ${theme === option ? "selected" : ""}`} onClick={() => setTheme(option)}>
                {option[0].toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </section>

        <div className="section-title">FEEDBACK</div>
        <section className="settings-card settings-row">
          <div>
            <h3>Haptic feedback</h3>
            <p>Vibrate after each check-in result</p>
          </div>
          <button className={`switch ${haptic ? "on" : ""}`} onClick={() => setHaptic(!haptic)} aria-label="Toggle haptic feedback" />
        </section>

        <div className="section-title">CHECK-IN POLICY</div>
        <section className={`settings-card ${sudoMode ? "danger-outline" : ""}`}>
          <div className="settings-row">
            <div>
              <h3>Allow unapproved attendees</h3>
              <p>Admin Force</p>
            </div>
            <button className={`switch ${sudoMode ? "on" : ""}`} onClick={() => setSudoMode(!sudoMode)} aria-label="Toggle admin force" />
          </div>
          {sudoMode ? (
            <p className="policy-note danger">Override mode is ON. Acceptance checks will be bypassed for every scanned attendee.</p>
          ) : (
            <p className="policy-note">Default: OFF. Unapproved attendees require a staff decision after scanning.</p>
          )}
        </section>

        <div className="section-title">SECURITY</div>
        <button className="danger-button" onClick={onLock}>Lock this station</button>

        <div className="section-title">OPEN SOURCE</div>
        <a className="github-card" href="https://github.com/mhmdwaelanwr/Web-Event" target="_blank" rel="noreferrer">
          <span className="github-icon">GH</span>
          <span><strong>View source on GitHub</strong><small>Explore, learn, and contribute</small></span>
          <span className="external">↗</span>
        </a>

        <div className="install-hint">iPhone/iPad: open this site in Safari → Share → Add to Home Screen to use it like an app.</div>
        <div className="version">Event Check-in Web&nbsp; • &nbsp;Version 1.0</div>
      </div>
    </main>
  );
}
