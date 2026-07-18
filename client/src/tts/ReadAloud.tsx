/**
 * Read-Aloud (text-to-speech), modelled on Word's Read Aloud.
 *
 * Uses the browser Web Speech API (window.speechSynthesis), defaulting to voices
 * where `localService === true` so playback works fully offline. It speaks the
 * document sentence by sentence (the same Blocks the Visual view renders) and
 * reports the active block upward so App can highlight it in the Visual view
 * AND follow along in the source editor. Math is spoken according to the
 * chosen mode (skip / say "equation" / naive).
 *
 * Every knob the Web Speech API exposes is surfaced here — voice, rate
 * (0.5–2×), pitch, volume — plus a "Preview voice" button so a voice can be
 * judged before committing to it. Settings persist in localStorage. Voice
 * QUALITY is an OS matter: macOS ships small "compact" voices by default;
 * much better ones (Siri/Enhanced/Premium) can be downloaded in
 * System Settings → Accessibility → Spoken Content → System Voice → Manage
 * Voices…, after which they appear in this picker automatically.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Block, MathReadMode } from "../visual/parse";
import { spokenText, blockIndexFromLine } from "../visual/parse";

export interface ReadAloudHandle {
  /** Start reading at the block with this seg id (visual double-click). */
  playFromSeg(seg: number): void;
}

interface ReadAloudProps {
  blocks: Block[];
  /** Current 1-based cursor line in the source editor. */
  getCursorLine(): number;
  /**
   * The block being spoken (null when stopped) — App highlights it in the
   * Visual view and, when followEditor is on, scrolls the source editor too.
   */
  onActiveBlock(block: Block | null, followEditor: boolean): void;
  ensureVisual(): void;
  onClose(): void;
}

const PREVIEW_SENTENCE =
  "The potential of mean force along a collective variable characterizes the free energy landscape.";

interface Persisted {
  voiceURI: string;
  rate: number;
  pitch: number;
  volume: number;
  mathMode: MathReadMode;
  followEditor: boolean;
  showAllVoices: boolean;
}

const STORAGE_KEY = "offleaf.readaloud";

function loadPersisted(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Persisted>;
  } catch {
    return {};
  }
}

const ReadAloud = forwardRef<ReadAloudHandle, ReadAloudProps>(function ReadAloud(
  { blocks, getCursorLine, onActiveBlock, ensureVisual, onClose },
  ref,
) {
  const saved = useRef(loadPersisted()).current;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string>(saved.voiceURI ?? "");
  const [rate, setRate] = useState(saved.rate ?? 1);
  const [pitch, setPitch] = useState(saved.pitch ?? 1);
  const [volume, setVolume] = useState(saved.volume ?? 1);
  const [mathMode, setMathMode] = useState<MathReadMode>(saved.mathMode ?? "sayEquation");
  const [followEditor, setFollowEditor] = useState(saved.followEditor ?? true);
  const [showAllVoices, setShowAllVoices] = useState(saved.showAllVoices ?? false);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);

  const idxRef = useRef(0);
  const stoppedRef = useRef(true);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const stateRef = useRef({ voiceURI, rate, pitch, volume, mathMode, followEditor, voices });
  stateRef.current = { voiceURI, rate, pitch, volume, mathMode, followEditor, voices };

  // Persist settings whenever they change.
  useEffect(() => {
    try {
      const data: Persisted = { voiceURI, rate, pitch, volume, mathMode, followEditor, showAllVoices };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage full/blocked — settings just won't persist */
    }
  }, [voiceURI, rate, pitch, volume, mathMode, followEditor, showAllVoices]);

  // Load voices; some browsers populate them asynchronously. Offline (local)
  // voices are the default; "show all" also lists network voices.
  useEffect(() => {
    const load = () => {
      const all = window.speechSynthesis.getVoices();
      const local = all.filter((v) => v.localService);
      const list = showAllVoices || local.length === 0 ? all : local;
      // English first, then the rest alphabetically — the picker stays usable
      // even when macOS reports 100+ voices.
      const sorted = [...list].sort((a, b) => {
        const aEn = a.lang.startsWith("en") ? 0 : 1;
        const bEn = b.lang.startsWith("en") ? 0 : 1;
        return aEn - bEn || a.name.localeCompare(b.name);
      });
      setVoices(sorted);
      setVoiceURI((prev) =>
        prev && sorted.some((v) => v.voiceURI === prev)
          ? prev
          : sorted.find((v) => v.default)?.voiceURI || sorted[0]?.voiceURI || "",
      );
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
    };
  }, [showAllVoices]);

  // Cancel any speech when the panel unmounts.
  useEffect(() => () => window.speechSynthesis.cancel(), []);

  const configure = (u: SpeechSynthesisUtterance) => {
    const s = stateRef.current;
    const voice = s.voices.find((v) => v.voiceURI === s.voiceURI);
    if (voice) u.voice = voice;
    u.rate = s.rate;
    u.pitch = s.pitch;
    u.volume = s.volume;
  };

  const speakIndex = (i: number) => {
    if (stoppedRef.current) return;
    const list = blocksRef.current;
    if (i >= list.length) {
      finish();
      return;
    }
    idxRef.current = i;
    const block = list[i];
    const text = spokenText(block, stateRef.current.mathMode).trim();
    if (!text) {
      speakIndex(i + 1);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    configure(u);
    u.onstart = () => onActiveBlock(block, stateRef.current.followEditor);
    u.onend = () => {
      if (!stoppedRef.current) speakIndex(i + 1);
    };
    window.speechSynthesis.speak(u);
  };

  const play = (from: number) => {
    window.speechSynthesis.cancel();
    ensureVisual();
    stoppedRef.current = false;
    setPlaying(true);
    setPaused(false);
    // Give the visual view a tick to mount before we start highlighting.
    setTimeout(() => speakIndex(from), 60);
  };

  useImperativeHandle(ref, () => ({
    playFromSeg(seg: number) {
      const i = blocksRef.current.findIndex((b) => b.seg === seg);
      play(i >= 0 ? i : 0);
    },
  }));

  const playFromCursor = () => {
    play(blockIndexFromLine(blocksRef.current, getCursorLine()));
  };

  /** Speak one sample sentence with the current settings (voice audition). */
  const previewVoice = () => {
    stop();
    const u = new SpeechSynthesisUtterance(PREVIEW_SENTENCE);
    configure(u);
    window.speechSynthesis.speak(u);
  };

  const finish = () => {
    stoppedRef.current = true;
    setPlaying(false);
    setPaused(false);
    onActiveBlock(null, false);
  };

  const stop = () => {
    stoppedRef.current = true;
    window.speechSynthesis.cancel();
    finish();
  };

  const pauseResume = () => {
    if (paused) {
      window.speechSynthesis.resume();
      setPaused(false);
    } else {
      window.speechSynthesis.pause();
      setPaused(true);
    }
  };

  const skip = (delta: number) => {
    if (stoppedRef.current) return;
    window.speechSynthesis.cancel();
    const next = Math.max(0, Math.min(blocksRef.current.length - 1, idxRef.current + delta));
    speakIndex(next);
  };

  const resetSettings = () => {
    setRate(1);
    setPitch(1);
    setVolume(1);
    setMathMode("sayEquation");
  };

  return (
    <div className="readaloud">
      <div className="panel-title">
        🔊 Read Aloud
        <button className="link" onClick={() => { stop(); onClose(); }}>close</button>
      </div>
      <div className="ra-controls">
        {!playing ? (
          <>
            <button className="primary" onClick={() => play(0)}>▶ Play</button>
            <button onClick={playFromCursor} title="Read starting at the editor cursor">▶ From cursor</button>
          </>
        ) : (
          <>
            <button onClick={pauseResume}>{paused ? "▶ Resume" : "⏸ Pause"}</button>
            <button onClick={stop}>⏹ Stop</button>
          </>
        )}
        <button onClick={() => skip(-1)} disabled={!playing} title="Previous sentence">⏮</button>
        <button onClick={() => skip(1)} disabled={!playing} title="Next sentence">⏭</button>
      </div>

      <label className="ra-row">
        Voice
        <select value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)}>
          {voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} {v.localService ? "" : "(online)"} — {v.lang}
            </option>
          ))}
        </select>
      </label>
      <div className="ra-controls">
        <button onClick={previewVoice} title="Speak a sample sentence with the current voice/speed/pitch/volume">
          🔈 Preview voice
        </button>
        <button onClick={resetSettings} title="Reset speed, pitch, volume, and math mode to defaults">Reset</button>
      </div>
      <label className="ra-row ra-check">
        <input type="checkbox" checked={showAllVoices} onChange={(e) => setShowAllVoices(e.target.checked)} />
        Show all voices (incl. online)
      </label>

      <label className="ra-row">
        Speed <input type="range" min={0.5} max={2} step={0.1} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        <span className="muted">{rate.toFixed(1)}×</span>
      </label>
      <label className="ra-row">
        Pitch <input type="range" min={0.5} max={1.5} step={0.1} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} />
        <span className="muted">{pitch.toFixed(1)}</span>
      </label>
      <label className="ra-row">
        Volume <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
        <span className="muted">{Math.round(volume * 100)}%</span>
      </label>
      <label className="ra-row">
        Math
        <select value={mathMode} onChange={(e) => setMathMode(e.target.value as MathReadMode)}>
          <option value="skip">Skip equations</option>
          <option value="sayEquation">Say "equation"</option>
          <option value="naive">Read naively</option>
        </select>
      </label>
      <label className="ra-row ra-check">
        <input type="checkbox" checked={followEditor} onChange={(e) => setFollowEditor(e.target.checked)} />
        Follow along in the editor
      </label>

      <div className="muted ra-hint">Double-click a sentence in the Visual view to read from there.</div>
      <div className="muted ra-hint">
        Voice quality is set by macOS, not OffLeaf: download nicer voices under System Settings →
        Accessibility → Spoken Content → System Voice → Manage Voices… (look for "Enhanced"/"Premium"
        or Siri voices) — they appear here automatically.
      </div>
      {voices.length === 0 && <div className="muted ra-hint">No local voices found — install OS voices for offline speech.</div>}
    </div>
  );
});

export default ReadAloud;
