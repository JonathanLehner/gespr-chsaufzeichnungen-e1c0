"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";

export type PlayerHandle = {
  seekMs: (ms: number) => void;
  playFromMs: (ms: number) => void;
  toggle: () => void;
};

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export const WaveformPlayer = forwardRef<
  PlayerHandle,
  {
    src: string;
    startMs?: number;
    onTime: (ms: number) => void;
    onReady?: (durationMs: number) => void;
  }
>(function WaveformPlayer({ src, startMs = 0, onTime, onReady }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<WaveSurfer | null>(null);
  const startRef = useRef(startMs);
  const onTimeRef = useRef(onTime);
  const onReadyRef = useRef(onReady);
  onTimeRef.current = onTime;
  onReadyRef.current = onReady;

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let instance: WaveSurfer | null = null;

    (async () => {
      const { default: WaveSurferLib } = await import("wavesurfer.js");
      if (disposed || !containerRef.current || !audioRef.current) return;
      // Das eigene <audio>-Element bleibt im DOM: die Wiedergabe läuft dadurch
      // über native Bereichsanfragen und der Zustand ist von aussen prüfbar.
      instance = WaveSurferLib.create({
        container: containerRef.current,
        media: audioRef.current,
        url: src,
        height: 96,
        waveColor: "#9fb3bd",
        progressColor: "#0e5567",
        cursorColor: "#a9622c",
        cursorWidth: 2,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        normalize: true,
      });
      waveRef.current = instance;

      instance.on("ready", () => {
        if (disposed) return;
        setReady(true);
        const seconds = instance?.getDuration() ?? 0;
        setDuration(seconds);
        onReadyRef.current?.(Math.round(seconds * 1000));
        if (startRef.current > 0) {
          instance?.setTime(startRef.current / 1000);
          setPosition(startRef.current / 1000);
        }
      });
      instance.on("timeupdate", (seconds: number) => {
        setPosition(seconds);
        onTimeRef.current(Math.round(seconds * 1000));
      });
      instance.on("play", () => setPlaying(true));
      instance.on("pause", () => setPlaying(false));
      instance.on("finish", () => setPlaying(false));
      instance.on("error", () =>
        setError("Die Audiodatei konnte nicht geladen werden. Bitte laden Sie die Seite neu."),
      );
    })();

    return () => {
      disposed = true;
      instance?.destroy();
      waveRef.current = null;
    };
  }, [src]);

  useImperativeHandle(ref, () => ({
    seekMs(ms: number) {
      const wave = waveRef.current;
      if (!wave) return;
      wave.setTime(Math.max(0, ms / 1000));
      setPosition(ms / 1000);
      onTimeRef.current(ms);
    },
    playFromMs(ms: number) {
      const wave = waveRef.current;
      if (!wave) return;
      wave.setTime(Math.max(0, ms / 1000));
      setPosition(ms / 1000);
      onTimeRef.current(ms);
      void wave.play();
    },
    toggle() {
      void waveRef.current?.playPause();
    },
  }));

  function skip(seconds: number) {
    const wave = waveRef.current;
    if (!wave) return;
    const next = Math.min(Math.max(wave.getCurrentTime() + seconds, 0), wave.getDuration());
    wave.setTime(next);
    setPosition(next);
    onTimeRef.current(Math.round(next * 1000));
  }

  return (
    <div className="rounded-md border border-line bg-[#0f2027] p-4 text-white">
      {error && (
        <div className="notice notice-error mb-3" role="alert">
          {error}
        </div>
      )}
      <audio ref={audioRef} preload="metadata" className="hidden" />
      <div ref={containerRef} className="min-h-[96px] w-full" aria-label="Wellenform der Aufnahme" />
      {!ready && !error && (
        <p className="mt-2 text-[12px] text-white/60">Wellenform wird geladen …</p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn bg-white/10 text-white hover:bg-white/20"
            onClick={() => skip(-10)}
            disabled={!ready}
            aria-label="10 Sekunden zurück"
          >
            −10 s
          </button>
          <button
            type="button"
            className="btn btn-primary min-w-[104px]"
            onClick={() => void waveRef.current?.playPause()}
            disabled={!ready}
          >
            {playing ? "Pause" : "Abspielen"}
          </button>
          <button
            type="button"
            className="btn bg-white/10 text-white hover:bg-white/20"
            onClick={() => skip(10)}
            disabled={!ready}
            aria-label="10 Sekunden vor"
          >
            +10 s
          </button>
        </div>

        <p
          className="font-mono text-[13px] tabular-nums text-white/90"
          aria-label="Wiedergabeposition"
          aria-live="off"
        >
          {clock(position)} <span className="text-white/40">/ {clock(duration)}</span>
        </p>

        <label className="flex items-center gap-2 text-[12px] text-white/70">
          Lautstärke
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            className="w-28 accent-[#7fb3c0]"
            onChange={(event) => {
              const value = Number(event.target.value);
              setVolume(value);
              waveRef.current?.setVolume(value);
            }}
            aria-label="Lautstärke"
          />
          <span className="w-9 font-mono tabular-nums">{Math.round(volume * 100)}%</span>
        </label>

        <label className="flex items-center gap-2 text-[12px] text-white/70">
          Tempo
          <select
            value={speed}
            className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-1 text-[12px] text-white"
            onChange={(event) => {
              const value = Number(event.target.value);
              setSpeed(value);
              waveRef.current?.setPlaybackRate(value, true);
            }}
            aria-label="Wiedergabegeschwindigkeit"
          >
            {SPEEDS.map((option) => (
              <option key={option} value={option} className="text-ink">
                {option.toLocaleString("de-CH")}×
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
});
