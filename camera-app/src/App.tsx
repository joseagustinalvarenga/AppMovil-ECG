import { useEffect, useRef, useState } from "react";
import "./App.css";


/* ── Tipos ─────────────────────────────────────────────────────────────── */
type Step = "welcome" | "form" | "camera" | "result";

type ClinicalInfo = {
  name: string;
  age: number | "";
  smoker: boolean;
  heartIssues: boolean;
};

type Facing = "user" | "environment";

type ApiPrediction = {
  class: string;
  probability: number; // 0..1
};

type ApiResponseShape = {
  prediction: ApiPrediction;
  predictions?: ApiPrediction[];
  margin?: number;
  review?: boolean;
};

/* ── Util ──────────────────────────────────────────────────────────────── */
const pct = (p?: number) =>
  typeof p === "number" ? (p * 100).toFixed(1) + "%" : "—";

/* Etiqueta prolija para cada cámara */
const getDeviceLabel = (d: MediaDeviceInfo, idx: number) => {
  const L = d.label || "";
  if (!L) return `Cámara ${idx + 1}`;
  return L.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
};

/* Elegir la “mejor” según facing (trasera normal si hay, no-wide) */
const pickPreferredDevice = (devices: MediaDeviceInfo[], want: Facing) => {
  if (!devices?.length) return null;
  const isFront = (s: string) => /front|frontal|user|selfie/i.test(s);
  const isBack = (s: string) => /back|rear|trasera|environment/i.test(s);
  const isWide = (s: string) => /wide|ultra|uw|ultra[- ]wide/i.test(s);

  if (want === "environment") {
    const normalBack = devices.find(d => isBack(d.label || "") && !isWide(d.label || ""));
    if (normalBack) return normalBack.deviceId;
    const anyBack = devices.find(d => isBack(d.label || ""));
    if (anyBack) return anyBack.deviceId;
  } else {
    const anyFront = devices.find(d => isFront(d.label || ""));
    if (anyFront) return anyFront.deviceId;
  }
  return devices[0].deviceId;
};

/* ── Ícono (SVG) para alternar cámara ── */
function CameraSwitchIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" {...props}>
      <path
        d="M7 7h7l-1.5-1.5.71-.71L15.83 7l-2.62 2.21-.71-.71L14 7H7a4 4 0 0 0-4 4v2H2v-2a5 5 0 0 1-5 5Zm10 10h-7l1.5 1.5-.71.71L8.17 17l2.62-2.21.71.71L10 17h7a4 4 0 0 0 4-4v-2h1v2a5 5 0 0 1-5 5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/* ── App ───────────────────────────────────────────────────────────────── */
export default function App() {
  const [step, setStep] = useState<Step>("welcome");

  /* ── MÉDICO ───────────────────────────────────────────────────────────── */
  const [doctorName, setDoctorName] = useState<string>("");
  const [doctorError, setDoctorError] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("doctorName");
    if (saved) setDoctorName(saved);
  }, []);

  const handleEnter = (e: React.FormEvent) => {
    e.preventDefault();
    setDoctorError(null);
    if (!doctorName.trim()) {
      setDoctorError("Ingresá tu nombre para continuar.");
      return;
    }
    localStorage.setItem("doctorName", doctorName.trim());
    setStep("form");
  };

  /* ── FORM PACIENTE ────────────────────────────────────────────────────── */
  const [form, setForm] = useState<ClinicalInfo>({
    name: "",
    age: "",
    smoker: false,
    heartIssues: false,
  });
  const [formError, setFormError] = useState<string | null>(null);

  const handleStartCamera = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim()) {
      setFormError("El nombre del paciente es obligatorio.");
      return;
    }
    if (form.age === "" || Number.isNaN(Number(form.age)) || Number(form.age) <= 0) {
      setFormError("La edad debe ser un número mayor a 0.");
      return;
    }
    setStep("camera");
  };

  /* ── CÁMARA + ADJUNTO ─────────────────────────────────────────────────── */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const currentStreamRef = useRef<MediaStream | null>(null);
  const startTokenRef = useRef(0);
  const [camError, setCamError] = useState<string | null>(null);

  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null); // imagen actual
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[] | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");

  // Estados para API
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiResponse, setApiResponse] = useState<ApiResponseShape | null>(null);

  const stopCurrentStream = () => {
    currentStreamRef.current?.getTracks()?.forEach((t) => t.stop());
    currentStreamRef.current = null;
  };

  const listVideoDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const vids = all.filter((d) => d.kind === "videoinput");
      setVideoDevices(vids.length ? vids : null);
      return vids;
    } catch {
      setVideoDevices(null);
      return [];
    }
  };

  const guessDeviceIdByFacing = (devices: MediaDeviceInfo[], want: Facing) => {
    if (!devices?.length) return null;
    const isFront = (s: string) => /front|frontal|user|anter/i.test(s);
    const isBack =  (s: string) => /back|rear|trasera|environment/i.test(s);
    const candidates = devices.filter((d) => (want === "user" ? isFront(d.label) : isBack(d.label)));
    if (candidates.length) return candidates[0].deviceId;
    if (devices.length > 1) return want === "user" ? devices[0].deviceId : devices[1].deviceId;
    return devices[0].deviceId;
  };

  const openCamera = async (opts?: { deviceId?: string | null; facingMode?: Facing }) => {
    setCamError(null);
    stopCurrentStream();

    const token = ++startTokenRef.current;

    if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getUserMedia) {
      setCamError("Este navegador no soporta acceso a la cámara");
      return;
    }

   let constraints: MediaStreamConstraints = {
     audio: false,
     video: {
       facingMode: opts?.facingMode ?? facing,
       width: { ideal: 1280 },     // “pista” para que no use el ultra-wide
       height: { ideal: 720 },
       // advanced: [{ zoom: 1.0 }] // algunos navegadores soportan zoom
     }
   };

    if (opts?.deviceId) constraints.video = { deviceId: { exact: opts.deviceId } };
    else if (opts?.facingMode) constraints.video = { facingMode: opts.facingMode };
    else constraints.video = { facingMode: facing };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (token !== startTokenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      currentStreamRef.current = stream;

      const el = videoRef.current;
      if (!el) return;
      if (el.srcObject !== stream) el.srcObject = stream;

      await new Promise<void>((resolve) => {
        const onReady = () => {
          el.removeEventListener("loadedmetadata", onReady);
          el.removeEventListener("canplay", onReady);
          resolve();
        };
        el.addEventListener("loadedmetadata", onReady, { once: true });
        el.addEventListener("canplay", onReady, { once: true });
      });

      await el.play();
      const vids = await listVideoDevices();

      if (!selectedDeviceId) {
        const chosen =
          (constraints.video as MediaTrackConstraints)?.deviceId
            ? (constraints.video as any).deviceId.exact
            : guessDeviceIdByFacing(vids, opts?.facingMode || facing);
        setSelectedDeviceId(chosen || null);
      }
    } catch (e: any) {
      setCamError(e?.message ?? "No se pudo acceder a la cámara");
    }
  };

  useEffect(() => {
    if (step !== "camera") return;

    let mounted = true;
    (async () => {
      // 1) Abrir con facing preferido
      await openCamera({ facingMode: facing });
      if (!mounted) return;

      // 2) Obtener dispositivos con labels (tras dar permiso)
      const vids = await listVideoDevices();
      if (!mounted) return;

      // 3) Si no hay selección aún, elegir “principal” según facing
      if (!selectedDeviceId && vids.length) {
        const preferred = pickPreferredDevice(vids, facing);
        if (preferred) {
          setSelectedDeviceId(preferred);
          await openCamera({ deviceId: preferred, facingMode: facing });
        }
      }
    })();

    return () => {
      mounted = false;
      stopCurrentStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const switchFacing = async (want: Facing) => {
    setFacing(want);
    let deviceId: string | null = null;

    const vids = videoDevices?.length ? videoDevices : await listVideoDevices();
    deviceId = pickPreferredDevice(vids, want) || guessDeviceIdByFacing(vids, want);

    await openCamera({ deviceId, facingMode: want });
    setSelectedDeviceId(deviceId || null);
  };

  const toggleFacing = async () => {
    await switchFacing(facing === "environment" ? "user" : "environment");
  };

  /* --- Captura desde cámara --- */
  const handleCapture = () => {
    const video = videoRef.current;
    if (!video) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      setCamError("La cámara aún no está lista para capturar");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/png");
    setPhotoDataUrl(dataUrl);
    setApiResponse(null);
    setApiError(null);
  };

  /* --- Adjuntar archivo en vez de usar cámara --- */
  const handleFilePick = async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setApiError("El archivo debe ser una imagen.");
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    setPhotoDataUrl(dataUrl);
    setApiResponse(null);
    setApiError(null);
  };

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });

  const clearPhoto = () => {
    setPhotoDataUrl(null);
    setApiResponse(null);
    setApiError(null);
  };

  /* ── Enviar imagen a tu API y mostrar respuesta ───────────────────────── */
  const sendImageToApi = async (): Promise<void> => {
    if (!photoDataUrl) {
      setApiError("No hay imagen para enviar.");
      return;
    }

    const base64Image = photoDataUrl.split(",")[1];

    try {
      setApiLoading(true);
      setApiError(null);

      const resp = await fetch("https://a45c5324ca52.ngrok-free.app/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_b64: base64Image }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`API ${resp.status} ${resp.statusText}${text ? " - " + text : ""}`);
      }

      const json = (await resp.json()) as ApiResponseShape;
      setApiResponse(json);
      setStep("result"); // 👈 saltamos a la pantalla de resultado
    } catch (err: any) {
      setApiError(err?.message || "Error al enviar imagen a la API");
      setApiResponse(null);
    } finally {
      setApiLoading(false);
    }
  };

  /* ── UI ────────────────────────────────────────────────────────────────── */
  return (
    <div className="app">
      {/* ── PANTALLA 1: Bienvenida / Médico ── */}
      {step === "welcome" && (
        <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            className="card card--elevated"
            style={{ textAlign: "center", padding: "32px 24px", maxWidth: 400, width: "100%" }}
          >
            <img
              src="/logo.png"
              alt="Logo"
              style={{ width: 96, height: 96, objectFit: "contain", margin: "0 auto 16px", display: "block" }}
            />
            <h1 className="h1">Ingreso del médico</h1>
            <p className="subtle" style={{ marginTop: 4 }}>Ingresá tu nombre para continuar.</p>

            <form onSubmit={handleEnter} className="form" style={{ marginTop: 16 }}>
              <div className="field">
                <label className="label" htmlFor="doctor">Nombre del médico</label>
                <input
                  id="doctor" className="input" type="text"
                  value={doctorName} onChange={(e) => setDoctorName(e.target.value)}
                  placeholder="Ej: Dra. María González" required autoComplete="name"
                />
              </div>

              {doctorError && <p className="error" role="alert">{doctorError}</p>}

              <div className="toolbar" style={{ justifyContent: "center" }}>
                <button type="submit" className="btn btn-primary">Ingresar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── PANTALLA 2: Formulario paciente ── */}
      {/* ── PANTALLA 2: Formulario paciente ── */}
      {step === "form" && (
        <div className="stack formPage full-viewport">
          <h1 className="h1">Información clínica básica</h1>

          <div className="subtle" style={{ marginBottom: 4 }}>
            Médico: <strong>{doctorName || "—"}</strong>
          </div>

          {/* 👇 agregá formCard para estilos responsivos */}
          <form className="card form card--elevated formCard" onSubmit={handleStartCamera} noValidate>
            <div className="field">
              <label className="label" htmlFor="name">Nombre del paciente</label>
              <input
                id="name" className="input" type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ej: Juan Pérez" required autoComplete="name"
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="age">Edad</label>
              <input
                id="age" className="input" type="number" min={1} max={120}
                value={form.age}
                onChange={(e) => setForm((f) => ({ ...f, age: e.target.value === "" ? "" : Number(e.target.value) }))}
                placeholder="Ej: 45" required inputMode="numeric"
              />
            </div>

            <div className="row">
              <label className="check">
                <input className="checkbox" type="checkbox"
                  checked={form.smoker} onChange={(e) => setForm((f) => ({ ...f, smoker: e.target.checked }))}/>
                ¿Es fumador?
              </label>

              <label className="check">
                <input className="checkbox" type="checkbox"
                  checked={form.heartIssues} onChange={(e) => setForm((f) => ({ ...f, heartIssues: e.target.checked }))}/>
                ¿Tiene problemas cardíacos?
              </label>
            </div>

            {formError && <p className="error" role="alert">{formError}</p>}

            <div className="toolbar">
              <button type="submit" className="btn btn-primary">Continuar a la cámara</button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep("welcome")}>
                ← Cambiar médico
              </button>
            </div>
          </form>

          <p className="subtle">Nota: la cámara requiere HTTPS (ngrok) o localhost, y permisos del navegador.</p>
        </div>
      )}


      {/* ── PANTALLA 3: Cámara / o adjuntar archivo ── */}
      {step === "camera" && (
        <div className="stack">
          <h1 className="h1">Cámara</h1>
          <div className="subtle" style={{ marginBottom: 4 }}>
            Médico: <strong>{doctorName || "—"}</strong> · Paciente: <strong>{form.name}</strong>
          </div>

          {/* Video + botón flotante para alternar cámara */}
          <div className="card videoBox" style={{ position: "relative" }}>
            <video ref={videoRef} className="video" playsInline autoPlay muted />
            <button
              type="button" className="fabSwitch" onClick={toggleFacing}
              aria-label={`Cambiar a cámara ${facing === "environment" ? "frontal" : "trasera"}`}
              title={`Cambiar a cámara ${facing === "environment" ? "frontal" : "trasera"}`}
              disabled={apiLoading}
            >
              <CameraSwitchIcon className="fabIcon" />
            </button>
            <span className="camBadge">{facing === "environment" ? "Trasera" : "Frontal"}</span>
          </div>

          {/* Selector de cámara */}
          {videoDevices && videoDevices.length > 0 && (
            <div className="card camSelect" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label className="label" htmlFor="camSel" style={{ marginRight: 8 }}>Cámara</label>
              <select
                id="camSel"
                className="input"
                value={selectedDeviceId ?? ""}
                onChange={async (e) => {
                  const id = e.target.value || null;
                  setSelectedDeviceId(id);
                  await openCamera({ deviceId: id, facingMode: facing });
                }}
                disabled={apiLoading}
                style={{ minWidth: 240 }}
              >
                {videoDevices.map((d, i) => (
                  <option key={d.deviceId || `dev-${i}`} value={d.deviceId}>
                    {getDeviceLabel(d, i)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Barra de acciones: capturar, adjuntar, enviar */}
          <div className="toolbar">
            <button onClick={handleCapture} className="btn btn-primary" disabled={apiLoading}>
              📸 Sacar foto
            </button>

            {/* Adjuntar archivo en vez de usar cámara */}
            <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
              📎 Adjuntar imagen
              <input
                type="file" accept="image/*" style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFilePick(file);
                  e.currentTarget.value = "";
                }}
              />
            </label>

            {/* Enviar a API */}
            <button onClick={sendImageToApi} className="btn btn-secondary" disabled={apiLoading || !photoDataUrl}>
              {apiLoading ? "Enviando a API..." : "Enviar a API"}
            </button>

            <button onClick={() => setStep("form")} className="btn btn-ghost" disabled={apiLoading}>
              ← Volver al formulario
            </button>

            {photoDataUrl && (
              <button onClick={clearPhoto} className="btn btn-ghost" disabled={apiLoading}>
                🗑️ Borrar imagen
              </button>
            )}
          </div>

          {/* Respuesta cruda (opcional para debug) */}
          {apiError && <p className="error" role="alert">API: {apiError}</p>}

          {/* Vista previa de la imagen actual */}
          {photoDataUrl && (
            <div className="card">
              <p style={{ margin: "0 0 8px" }}>Imagen seleccionada:</p>
              <img className="imgPreview" src={photoDataUrl} alt="captura o adjunta" />
            </div>
          )}

          {camError && <p className="error" role="alert">Error cámara: {camError}</p>}
        </div>
      )}

      {/* ── PANTALLA 4: Resultado ── */}
      {step === "result" && apiResponse && (
        <div className="stack result">
          <h1 className="h1">Resultado del análisis</h1>

          <div className="context">
            <div className="chip">👨‍⚕️ {doctorName || "—"}</div>
            <div className="chip">🧑‍🦱 Paciente: {form.name || "—"}</div>
            <div className="chip">🎂 Edad: {form.age || "—"}</div>
            {form.smoker && <div className="chip chip--warn">🚬 Fumador</div>}
            {form.heartIssues && <div className="chip chip--warn">❤ Antecedentes cardíacos</div>}
          </div>

          {apiResponse.review && (
            <div className="alert alert--danger">
              <div className="alert__icon">⚠️</div>
              <div className="alert__body">
                <div className="alert__title">Revisión necesaria</div>
                <div className="alert__text">LLAMAR A UN CARDIÓLOGO</div>
              </div>
            </div>
          )}

          <div className="card card--elevated resultCard">
            <div className="result__header">
              <span className="badge">Pre-diagnóstico</span>
              <h2 className="result__title">
                {apiResponse.prediction?.class ?? "—"}
              </h2>
              <div className="confidence">
                <span>Confianza</span>
                <strong>{pct(apiResponse.prediction?.probability)}</strong>
              </div>
              <div className="bar">
                <div
                  className="bar__fill"
                  style={{ width: `${Math.round((apiResponse.prediction?.probability ?? 0) * 100)}%` }}
                />
              </div>
            </div>

            {!!apiResponse.predictions?.length && (
              <div className="altList">
                <div className="altList__title">Otras probabilidades</div>
                <div className="altList__grid">
                  {apiResponse.predictions.map((p, i) => (
                    <div key={i} className="altItem">
                      <div className="altItem__head">
                        <span className="altItem__class">{p.class}</span>
                        <span className="altItem__pct">{pct(p.probability)}</span>
                      </div>
                      <div className="bar bar--thin">
                        <div
                          className="bar__fill"
                          style={{ width: `${Math.round((p.probability ?? 0) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {typeof apiResponse.margin === "number" && (
              <div className="meta">
                <span className="meta__label">Margen</span>
                <code className="meta__code">{apiResponse.margin.toFixed(4)}</code>
              </div>
            )}
          </div>

          {photoDataUrl && (
            <div className="card imgCard">
              <img className="imgPreview imgPreview--rounded" src={photoDataUrl} alt="captura o adjunta" />
            </div>
          )}

          <div className="toolbar toolbar--sticky">
            <button className="btn btn-primary" onClick={() => setStep("camera")}>
              ➕ Analizar otra imagen
            </button>
            <button className="btn btn-ghost" onClick={() => setStep("form")}>
              ← Volver al formulario
            </button>
          </div>
        </div>
      )}

      {step === "result" && !apiResponse && (
        <div className="stack">
          <h1 className="h1">Resultado del análisis</h1>
          <div className="card">No hay respuesta disponible.</div>
          <div className="toolbar">
            <button className="btn btn-primary" onClick={() => setStep("camera")}>
              Volver a la cámara
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
